const development = process.env.NODE_ENV === 'development';

import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import * as path from 'path';
import * as fs from "fs";
import { ChildProcessWithoutNullStreams, execFile, spawn } from 'child_process';
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
let nativeRscriptPath: string | null = null;
const nativeRLibraryDir = path.join(__dirname, '../src/library/R');
const nativeCodebookScript = path.join(nativeRLibraryDir, 'load_codebook_native.R');
const nativeDDITreeScript = path.join(nativeRLibraryDir, 'build_ddi_tree_native.R');
let webRInitPromise: Promise<void> | null = null;
let webRInitialized = false;

const windowid: { [key: string]: number } = {
    mainWindow: 1,
};



async function loadXmlViaWebR(hostFilePath: string): Promise<JsonValue> {
    const dir = path.dirname(hostFilePath);
    const base = path.basename(hostFilePath);

    // Mount the host directory so WebR can access the file
    await mount({ what: dir, where: '/hostfile' });

    const rPath = `/hostfile/${base}`;
    await webR.evalRVoid(`codeBook <- getCodebook("${utils.escapeForR(rPath)}")`);

    const getCodebookFromJSON = 'jsonlite::toJSON(normalize_codebook(codeBook), auto_unbox = TRUE)';
    const response = await webR.evalRString(getCodebookFromJSON);
    return JSON.parse(response) as JsonValue;
}

function runNativeRScript(scriptPath: string, args: string[]): Promise<string> {
    if (!nativeRscriptPath) {
        return Promise.reject(new Error('Native Rscript is not available'));
    }
    const rscript = nativeRscriptPath;
    return new Promise((resolve, reject) => {
        // console.log('[Main] running native R script', scriptPath, args);
        const proc = spawn(rscript, [scriptPath, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
        const typedProc = proc as ChildProcessWithoutNullStreams;
        let stdout = '';
        let stderr = '';
        typedProc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
        typedProc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
        typedProc.on('error', (error: Error) => reject(error));
        typedProc.on('close', (code: number) => {
            if (code !== 0) {
                const message = stderr.trim() || `Rscript exited with code ${code}`;
                reject(new Error(message));
                return;
            }
            const output = stdout.trim();
            if (!output) {
                reject(new Error('Native R script produced no output'));
                return;
            }
            // console.log('[Main] native R script succeeded, output length', output.length);
            resolve(output);
        });
    });
}

async function loadXmlViaNativeR(hostFilePath: string): Promise<JsonValue> {
    const raw = await runNativeRScript(nativeCodebookScript, [hostFilePath, nativeRLibraryDir]);
    return JSON.parse(raw) as JsonValue;
}

async function loadXmlFile(hostFilePath: string) {
    // Send message to renderer to start loader
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('addCover', i18n.t('page.main.loader'));
    }

    try {
        let codebook: JsonValue;
        if (nativeRscriptPath) {
            try {
                // console.log('[Main] loading XML via native R', hostFilePath);
                codebook = await loadXmlViaNativeR(hostFilePath);
                // console.log('[Main] native codebook loaded, tree root', (codebook as any)?.name);
            } catch (error: any) {
                // console.error('[Main] native codebook load failed, falling back to WebR', error);
                nativeRscriptPath = null;
                await ensureWebRInitialized();
                // console.log('[Main] loading XML via WebR fallback', hostFilePath);
                codebook = await loadXmlViaWebR(hostFilePath);
            }
        } else {
            await ensureWebRInitialized();
            // console.log('[Main] loading XML via WebR', hostFilePath);
            codebook = await loadXmlViaWebR(hostFilePath);
        }
        loadedCodebook = codebook;

        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('xmlcodebook', loadedCodebook);
        }
    } finally {
        // Send message to renderer to clear loader
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('removeCover');
        }
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
        await webR.evalRVoid('source("/app/utils.R")');

        await webR.evalRVoid(`.libPaths(c(.libPaths(), "/my-library"))`);
        await webR.evalRVoid(`library(DDIwR)`);

        // Source local R helper(s) after R initializes
        try {
            const bundle = await (getOrBuildDDITree(async () => {
                const tree = await webR.evalRString(
                    'jsonlite::toJSON(make_DDI_tree(), auto_unbox = TRUE)'
                );

                const elements = await webR.evalRString(
                    'jsonlite::toJSON(get("DDIC", envir = getEnv()), auto_unbox = TRUE)'
                );

                return ({
                    tree: JSON.parse(tree) as JsonValue,
                    elements: JSON.parse(elements) as JsonValue
                }) as DdiBundle;
            })) as DdiBundle;

            dditree = bundle.tree;
            ddielements = bundle.elements;
            broadcastDdiElements();
        } catch (e) {
            // Non-fatal in case the source file is missing in some environments
        }

        finalizeBoot();
    } catch (error) {
        throw error;
    }
}

function broadcastDdiElements() {
    if (!ddielements) return;
    try {
        BrowserWindow.getAllWindows().forEach((win) => {
            if (!win.isDestroyed()) win.webContents.send('ddi-elements', ddielements);
        });
    } catch { /* noop */ }
}

function finalizeBoot() {
    booting = false;
    const mainMenu = Menu.buildFromTemplate(buildMainMenuTemplate());
    Menu.setApplicationMenu(mainMenu);
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('removeCover');
    }
}

async function ensureWebRInitialized() {
    if (webRInitialized) return;
    if (!webRInitPromise) {
        // console.log('[Main] initializing WebR (fallback)');
        webRInitPromise = initWebR().then(() => {
            webRInitialized = true;
        }).catch((error) => {
            webRInitPromise = null;
            throw error;
        });
    }
    return webRInitPromise;
}

async function initializeRBackend() {
    // console.log('[Main] initializeRBackend: native available?', Boolean(nativeRscriptPath));
    if (nativeRscriptPath) {
        try {
            const bundle = (await getOrBuildDDITree(async () => {
                const raw = await runNativeRScript(nativeDDITreeScript, [nativeRLibraryDir]);
                return JSON.parse(raw) as DdiBundle;
            })) as DdiBundle;
            dditree = bundle.tree;
            ddielements = bundle.elements;
            broadcastDdiElements();
            // console.log('[Main] native DDI bundle ready, tree root', (dditree as any)?.name);
            finalizeBoot();
            return;
        } catch (error) {
            // console.error('[Main] native R initialization failed, falling back to WebR', error);
            nativeRscriptPath = null;
        }
    }
    // console.log('[Main] falling back to WebR initialization');
    await ensureWebRInitialized();
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
                    await loadXmlFile(filePath);
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

async function findNativeRscript(): Promise<string | null> {
    // console.log('[Main] searching for native Rscript executable...');
    return findExecutable('Rscript');
}

function findExecutable(name: string): Promise<string | null> {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    return new Promise((resolve) => {
        execFile(finder, [name], (error, stdout) => {
            if (error || !stdout) {
                resolve(null);
                return;
            }
            const lines = stdout.toString().split(/\r?\n/);
            const candidate = (lines[0] || '').trim();
            if (!candidate) {
                resolve(null);
                return;
            }
            resolve(candidate);
        });
    });
}

app.whenReady().then(async () => {
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

    nativeRscriptPath = await findNativeRscript();
    // if (nativeRscriptPath) {
    //     console.log(`[Main] Native Rscript available at ${nativeRscriptPath}`);
    // } else {
    //     console.log('[Main] Native Rscript not found; falling back to WebR for codebook loading');
    // }

    createMainWindow();
    setupIPC();

    initializeRBackend().catch((error) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        dialog.showErrorBox("Failed to initialize R backend", errorMessage);
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
