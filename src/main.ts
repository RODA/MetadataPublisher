const development = process.env.NODE_ENV === 'development';

import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import * as path from 'path';
import * as fs from "fs";
import { WebR } from "webr";
import { ungzip } from "pako";
import { i18n } from './i18n';
import { utils } from './library/utils';
import { settings } from './modules/settings';
import { MountArgs } from './interfaces/main';
import { getOrBuildDDITree, JsonValue } from './modules/dditree';

app.setName('MetadataPublisher');
let dditree: JsonValue | null = null;
let ddiElements: any | null = null; // elements map from cached tree.json
let mainWindow: BrowserWindow;
const webR = new WebR({ interactive: false });

const windowid: { [key: string]: number } = {
    mainWindow: 1,
};



async function loadXmlViaR(hostFilePath: string) {
    // Send message to renderer to start loader
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('addCover', i18n.t('page.main.loader'));
    }

    const dir = path.dirname(hostFilePath);
    const base = path.basename(hostFilePath);

    // Mount the host directory so WebR can access the file
    await mount({ what: dir, where: '/hostfile' });

    const rPath = `/hostfile/${base}`;
    mainWindow.webContents.send(
        'consolog',
        `codeBook <- getCodebook("${utils.escapeForR(rPath)}")`
    );

    await webR.evalRVoid(`codeBook <- getCodebook("${utils.escapeForR(rPath)}")`);

    const getCodebookFromJSON = 'jsonlite::toJSON(' +
        'keep_attributes(codeBook), ' +
        // 'codeBook, ' +
        'auto_unbox = TRUE, null = "null")';

    const response = await webR.evalRString(getCodebookFromJSON);
    const codeBookOnly = JSON.parse(response) as JsonValue;
    // Combine freshly loaded codebook with cached elements map so renderer can label nodes
    dditree = { codeBook: codeBookOnly, elements: ddiElements } as unknown as JsonValue;

    // Log to console panel, if any
    mainWindow.webContents.send('consolog', dditree);

    // Set as current tree and send to current window
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('dditree', dditree);
    }

    // Send message to renderer to clear loader
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('removeCover');
    }
}


async function mount(obj: MountArgs) {

    try {
        await webR.FS.unmount(obj.where);
    } catch (error) {
        // consolog(obj.where + " directory is not mounted yet.");
        try {
            await webR.FS.mkdir(obj.where);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            dialog.showErrorBox("Failed to make " + obj.where, errorMessage);
            throw error;
        }
    }

    try {
        await webR.FS.mount(
            "NODEFS",
            { root: obj.what },
            obj.where
        );
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        dialog.showErrorBox("Failed to mount " + obj.what + " to " + obj.where, errorMessage);
        throw error;
    }
}

async function initWebR() {
    try {
        await webR.init();

        const appRDir = path.join(__dirname, '../src/library/R');

        // mount a virtual filesystem containing contributed R packages
        const buffer = Buffer.from(ungzip(fs.readFileSync(
            path.join(appRDir, 'library.data.gz')
        )));
        const data = new Blob([buffer]);

        const metadata = JSON.parse(
            fs.readFileSync(
                path.join(appRDir, 'library.js.metadata'),
                'utf-8'
            )
        );

        const options = {
            packages: [{
                blob: data,
                metadata: metadata,
            }]
        };

        await webR.FS.mkdir('/my-library');
        await webR.FS.mount(
            "WORKERFS",
            options,
            '/my-library'
        );

        await webR.evalRVoid(`.libPaths(c(.libPaths(), "/my-library"))`);
        await webR.evalRVoid(`library(DDIwR)`);

        // Source local R helper(s) after R initializes
        try {
            await mount({ what: appRDir, where: '/app' });
            // Attempt to source local utils function for testing overrides
            try {
                await webR.evalRVoid('source("/app/utils.R")');
            } catch { /* noop: sourcing errors should not break app */ }
            // const startTime = Date.now();
            const tree = await getOrBuildDDITree(async () => {
                const response = await webR.evalRString(
                    'jsonlite::toJSON(makeDDITree(), auto_unbox = TRUE, null = "null", pretty = TRUE)'
                );
                return JSON.parse(response) as JsonValue;
            });

            // console.log(`Tree loaded in ${(Date.now() - startTime)/1000}s`);

            dditree = tree;
            try {
                // Keep only the elements map handy for later merges
                const anyTree: any = tree as any;
                ddiElements = anyTree && typeof anyTree === 'object' ? anyTree.elements || null : null;
            } catch { ddiElements = null; }
        } catch (e) {
            // Non-fatal in case the source file is missing in some environments
        }
    } catch (error) {
        throw error;
    }
}


function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 860,
        minWidth: 1200,
        minHeight: 860,
        center: true,
        webPreferences: {
        contextIsolation: true,
        nodeIntegration: true,
        preload: path.join(__dirname, 'preload/preloadMain.js'),
        sandbox: false,
        },
    });

    mainWindow.loadFile(path.join(__dirname, '../src/pages/main.html'));

    const mainMenu = Menu.buildFromTemplate(buildMainMenuTemplate());
    Menu.setApplicationMenu(mainMenu);

    // Ensure renderer picks up current language on first load
    try {
        mainWindow.webContents.on('did-finish-load', () => {
            try {
                mainWindow.webContents.send('message-from-main-i18nLanguageChanged', i18n.getLocale());
            } catch { /* noop */ }
        });
    } catch { /* noop */ }

    if (development) {
        mainWindow.webContents.openDevTools();
        setTimeout(() => mainWindow.focus(), 300);
    }

    windowid.mainWindow = mainWindow.id;
}

function setupIPC() {
    ipcMain.on('send-to', (_event, window, channel, ...args) => {
        if (window === 'main') {
            if (channel === 'setLanguage') {
                const lang = (args[0] || 'en') as string;
                i18n.setLocale(lang);

                try { settings.set('language', lang); } catch { /* noop */ }

                // Rebuild menus and update window titles
                const mainMenu = Menu.buildFromTemplate(buildMainMenuTemplate());
                Menu.setApplicationMenu(mainMenu);

                // Notify all renderer processes
                BrowserWindow.getAllWindows().forEach((win) => {
                    if (!win.isDestroyed()) {
                        win.webContents.send('i18nLanguageChanged', lang);
                    }
                });
                return;
            }

            return;
        }

        if (window === 'all') {
            BrowserWindow.getAllWindows().forEach((win) => {
                win.webContents.send(`message-from-main-${channel}`, ...args);
            });
            return;
        }

        const win = BrowserWindow.fromId(windowid[window]);
        if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
            win.webContents.send(`message-from-main-${channel}`, ...args);
        }
    });

    // Provide fetch endpoint for late windows to retrieve current DDI tree
    try {
        ipcMain.handle('get-dditree', () => dditree);
        // Settings fetchers
        ipcMain.handle('get-tree-label-mode', () => {
            const v = settings.get('treeLabelMode');
            const mode = (v === 'name' || v === 'title' || v === 'both') ? (v as string) : 'both';
            return mode;
        });
    } catch { /* noop: handler may already be registered in some hot-reload flows */ }
}

function buildMainMenuTemplate(): MenuItemConstructorOptions[] {
    const fileSubmenu: MenuItemConstructorOptions[] = [
        { // Load
            label: i18n.t('menu.file.load'),
            accelerator: 'CommandOrControl+L',
            click: async () => {
                const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
                    title: i18n.t('menu.file.loadtitle'),
                    filters: [{ name: 'DDI XML file', extensions: ['xml'] }],
                    properties: ['openFile']
                });
                if (canceled || !filePaths || filePaths.length === 0) return;
                try {
                    const filePath = filePaths[0];
                    await loadXmlViaR(filePath);
                } catch (e: any) {
                    dialog.showErrorBox(
                        i18n.t('messages.load.failed'),
                        String((e && e.message) ? e.message : e)
                    );
                }
            }
        },
        { role: 'quit', label: i18n.t('menu.quit') },
    ];

    const editMenu: MenuItemConstructorOptions = {
        label: i18n.t('menu.edit'),
        submenu: [
        { role: 'undo', label: i18n.t('menu.edit.undo') },
        { role: 'redo', label: i18n.t('menu.edit.redo') },
        { type: 'separator' },
        { role: 'cut', label: i18n.t('menu.edit.cut') },
        { role: 'copy', label: i18n.t('menu.edit.copy') },
        { role: 'paste', label: i18n.t('menu.edit.paste') },
        { role: 'selectAll', label: i18n.t('menu.edit.selectAll') },
        ],
    };

    const template: MenuItemConstructorOptions[] = [];
    template.push({ label: i18n.t('menu.file'), submenu: fileSubmenu });
    template.push(editMenu);

    // Language submenu (simple demo, lists available locales)
    const langs = i18n.availableLocales(__dirname);

    const langSubmenu: MenuItemConstructorOptions[] = langs.map((lang) => ({
        label: `${i18n.t('languageName.' + lang)}${lang === i18n.getLocale() ? ' ✓' : ''}`,
        type: 'normal',
        click: () => {
            i18n.setLocale(lang);
            try { settings.set('language', lang); } catch { /* noop */ }

            const mainMenu = Menu.buildFromTemplate(buildMainMenuTemplate());
            Menu.setApplicationMenu(mainMenu);

            BrowserWindow.getAllWindows().forEach((win) => {
                if (!win.isDestroyed()) {
                    try { win.webContents.send('i18nLanguageChanged', lang); } catch {}
                }
            });
        },
    }));

    template.push({ label: i18n.t('menu.language'), submenu: langSubmenu });

    // Settings menu: Tree label mode
    const currentLabelMode = (() => {
        const v = settings.get('treeLabelMode');
        return (v === 'name' || v === 'title' || v === 'both') ? (v as string) : 'both';
    })();
    const setMode = (mode: 'name' | 'title' | 'both') => {
        try { settings.set('treeLabelMode', mode); } catch { /* noop */ }
        // Notify all renderers
        BrowserWindow.getAllWindows().forEach((win) => {
            if (!win.isDestroyed()) {
                try { win.webContents.send('treeLabelModeChanged', mode); } catch {}
            }
        });
        // Rebuild menus to update radio checkmarks
        const mainMenu = Menu.buildFromTemplate(buildMainMenuTemplate());
        Menu.setApplicationMenu(mainMenu);
    };
    const treeLabelsSubmenu: MenuItemConstructorOptions[] = [
        { label: i18n.t('tree.names'), type: 'radio', checked: currentLabelMode === 'name', click: () => setMode('name') },
        { label: i18n.t('tree.titles'), type: 'radio', checked: currentLabelMode === 'title', click: () => setMode('title') },
        { label: i18n.t('tree.nametitles'), type: 'radio', checked: currentLabelMode === 'both', click: () => setMode('both') },
    ];
    const settingsSubmenu: MenuItemConstructorOptions[] = [
        { label: i18n.t('tree.labels'), submenu: treeLabelsSubmenu },
    ];
    template.push({ label: i18n.t('menu.settings'), submenu: settingsSubmenu });
    return template;
}

app.whenReady().then(() => {
  // Initialize i18n with saved language or system locale (best-effort)
    try {
        const sysLocale = app.getLocale ? app.getLocale() : 'en';
        const short = (sysLocale || 'en').slice(0, 2);
        let lang = short;
        try {
            const saved = settings.get('language');
            if (typeof saved === 'string' && saved) {
                lang = saved;
            }
        } catch { /* noop */ }

        i18n.init(lang, __dirname);

    } catch {
        i18n.init('en', __dirname);
    }

    createMainWindow();
    setupIPC();

    initWebR().catch((error) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        dialog.showErrorBox("Failed to initialize WebR", errorMessage);
    });

    // Ensure a default label mode exists
    try {
        const v = settings.get('treeLabelMode');
        if (v !== 'name' && v !== 'title' && v !== 'both') settings.set('treeLabelMode', 'both');
    } catch { /* noop */ }
});

app.on('window-all-closed', () => {
    app.quit();
});
