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
import { getOrBuildDDITree, JsonValue, DdiBundle } from './modules/dditree';

app.setName('MetadataPublisher');

// Static DDI structure (template)
let dditree: JsonValue | null = null;

// Elements map associated with the static DDI structure
let ddielements: any | null = null;

// Mutable currently loaded codebook (from user XML)
let loadedCodebook: JsonValue | null = null;

let mainWindow: BrowserWindow;
const webR = new WebR({ interactive: false });
let booting = true; // Block UI until R is ready and initial data loaded

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
    // mainWindow.webContents.send(
    //     'consolog',
    //     `codeBook <- getCodebook("${utils.escapeForR(rPath)}")`
    // );

    await webR.evalRVoid(`codeBook <- getCodebook("${utils.escapeForR(rPath)}")`);

    const getCodebookFromJSON = 'jsonlite::toJSON(normalize_codebook(codeBook), auto_unbox = TRUE)';

    const response = await webR.evalRString(getCodebookFromJSON);
    loadedCodebook = JSON.parse(response) as JsonValue;

    // Set as current document and send to current window
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('xmlcodebook', loadedCodebook);
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

        await mount({ what: appRDir, where: '/app' });
        await webR.evalRVoid('source("/app/DDI_Codebook_2.6.R")');
        await webR.evalRVoid('source("/app/utils.R")');

        await webR.evalRVoid(`.libPaths(c(.libPaths(), "/my-library"))`);
        await webR.evalRVoid(`library(DDIwR)`);

        // Source local R helper(s) after R initializes
        try {
            // const startTime = Date.now();
            const bundle = await (getOrBuildDDITree(async () => {
                const tree = await webR.evalRString(
                    'jsonlite::toJSON(make_DDI_tree(), auto_unbox = TRUE)'
                );

                const elements = await webR.evalRString(
                    'jsonlite::toJSON(get("DDIC", envir = cacheEnv), auto_unbox = TRUE)'
                );

                return ({
                    tree: JSON.parse(tree) as JsonValue,
                    elements: JSON.parse(elements) as JsonValue
                }) as DdiBundle;
            })) as DdiBundle;

            // console.log(`Tree loaded in ${(Date.now() - startTime)/1000}s`);
            dditree = bundle.tree;
            ddielements = bundle.elements;
            // Notify renderers elements are ready for labeling
            try {
                BrowserWindow.getAllWindows().forEach((win) => {
                    if (!win.isDestroyed()) win.webContents.send('ddi-elements', ddielements);
                });
            } catch { /* noop */ }
        } catch (e) {
            // Non-fatal in case the source file is missing in some environments
        }

        // Boot finished successfully: enable UI and remove cover
        try {
            booting = false;
            const mainMenu = Menu.buildFromTemplate(buildMainMenuTemplate());
            Menu.setApplicationMenu(mainMenu);
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('removeCover');
            }
        } catch { /* noop */ }
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
                mainWindow.webContents.send('i18nLanguageChanged', i18n.getLocale());
                // Add a startup cover while booting to block interaction
                if (booting) {
                    try { mainWindow.webContents.send('addCover', i18n.t('messages.app.initializing')); } catch { /* noop */ }
                }
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

    // Provide fetch endpoint for late windows to retrieve current loaded codebook
    try {
        ipcMain.handle('get-xmlcodebook', () => loadedCodebook);
        ipcMain.handle('get-ddi-elements', () => ddielements);
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
    template.push({ label: i18n.t('menu.file'), submenu: fileSubmenu, enabled: !booting });
    // Disable the whole Edit menu while booting to avoid accelerators
    template.push({ ...editMenu, enabled: !booting });

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

    template.push({ label: i18n.t('menu.language'), submenu: langSubmenu, enabled: !booting });

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
    template.push({ label: i18n.t('menu.settings'), submenu: settingsSubmenu, enabled: !booting });
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
