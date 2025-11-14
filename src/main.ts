const development = process.env.NODE_ENV === 'development';
const Windows_OS = process.platform === 'win32';

import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import * as path from 'path';
import * as fs from "fs";
import * as os from "os";
import { execFile } from 'child_process';
import { WebR } from "webr";
import { ungzip } from "pako";
import { i18n } from './i18n';
import { utils } from './library/utils';
import { settings } from './modules/settings';
import { MountArgs } from './interfaces/main';
import { getOrBuildDDITree, JsonValue, DDIBundle } from './modules/dditree';
import { NativeRWorker, NativeWorkerInitError } from './modules/nativeWorker';

app.setName('MetadataPublisher');

const SUPPORTED_CODEBOOK_EXTENSIONS = [
    'xml', 'sav', 'por', 'dta', 'rds', 'sas7bdat', 'xls', 'xlsx'
];

const getExtension = (filePath: string): string => {
    return path.extname(filePath).replace(/^\./, '').toLowerCase();
};

const isSupportedCodebookFile = (filePath: string): boolean => {
    return utils.isElementOf(
        getExtension(filePath),
        SUPPORTED_CODEBOOK_EXTENSIONS
    );
};

type BackendMode = 'native' | 'webr';
type NativeInitResult = 'ready' | 'fallback' | 'refused';


// Static DDI structure (template)
let dditree: JsonValue | null = null;

// Static elements map associated with the DDI structure
let ddielements: any | null = null;

// Mutable currently loaded codebook (from user XML or dataset)
let loadedCodebook: JsonValue | null = null;

let mainWindow: BrowserWindow;
const webR = new WebR({ interactive: false });

let booting = true; // Block UI until R is ready and initial data loaded
let nativeRscriptPath: string | null = null;
const nativeRLibraryDir = path.join(__dirname, '../src/library/R');
const nativeRWorker = new NativeRWorker();
let nativeRInitialized = false;
let webRInitPromise: Promise<void> | null = null;
let webRInitialized = false;

// temp dir for (copying) dropped files
const DROP_TEMP_DIR = path.join(os.tmpdir(), 'metadata-publisher-drops');

const windowid: { [key: string]: number } = {
    mainWindow: 1,
};



async function loadCodebookViaWebR(hostFilePath: string): Promise<JsonValue> {
    const dirname = path.dirname(hostFilePath);
    const filename = path.basename(hostFilePath);

    // Mount the host directory so WebR can access the file
    await mount({ what: dirname, where: '/hostfile' });

    const rPath = `/hostfile/${filename}`;
    await webR.evalRVoid(
        `codeBook <- getCodebook("${utils.escapeForR(rPath)}")`
    );

    const response = await webR.evalRString(
        'jsonlite::toJSON(normalize_codebook(codeBook), auto_unbox = TRUE)'
    );

    return JSON.parse(response) as JsonValue;
}

async function ensureDropDir() {
    try {
        await fs.promises.mkdir(DROP_TEMP_DIR, { recursive: true });
    } catch { /* noop */ }
}

const sanitizeFilename = (name: string): string => name.replace(/[<>:"/\\|?*\u0000]/g, '_');

const writeDroppedFile = async (name: string, data: Buffer): Promise<string> => {
    await ensureDropDir();
    const timestamp = Date.now();
    const cleanName = sanitizeFilename(name) || `dropped_${timestamp}`;
    const dropPath = path.join(DROP_TEMP_DIR, `${timestamp}_${cleanName}`);
    await fs.promises.writeFile(dropPath, data);
    return dropPath;
};

type FallbackChoice = 'once' | 'default';

async function notifyNoNativeR(): Promise<void> {
    const message = i18n.t('messages.native.notfound');
    await dialog.showMessageBox(mainWindow ?? undefined, {
        type: 'warning',
        buttons: ['OK'],
        defaultId: 0,
        cancelId: 0,
        message,
        normalizeAccessKeys: true,
    });
}

async function promptNativePackageFallback(
    missing: string[], errorMessage?: string
): Promise<FallbackChoice> {
    const packages = missing.length ? missing.join(', ') : i18n.t('messages.native.unknownPackages');
    const message = i18n.t('messages.native.missing', { packages });
    const detailParts = [i18n.t('messages.native.useWebR')];
    // Only show a raw error message if we don't have a specific missing list
    if ((!missing || missing.length === 0) && errorMessage) detailParts.push(errorMessage);
    const res = await dialog.showMessageBox(mainWindow ?? undefined, {
        type: 'warning',
        buttons: [i18n.t('messages.native.webr_once'), i18n.t('messages.native.webr_default')],
        defaultId: 0,
        cancelId: 0,
        message,
        detail: detailParts.join('\n\n'),
        normalizeAccessKeys: true,
    });
    return res.response === 1 ? 'default' : 'once';
}

async function ensureNativeRInitialized(): Promise<NativeInitResult> {
    if (nativeRInitialized) {
        return 'ready';
    }

    if (!nativeRscriptPath) {
        await notifyNoNativeR();
        return 'fallback';
    }

    try {
        await nativeRWorker.start(nativeRscriptPath, '', nativeRLibraryDir);
        nativeRInitialized = true;
        return 'ready';
    } catch (error) {
        nativeRInitialized = false;
        nativeRWorker.stop();
        const missing = error instanceof NativeWorkerInitError ? error.missingPackages : [];
        // Show a localized generic message when there is no concrete missing list
        const localized = (!missing || missing.length === 0) ? i18n.t('messages.native.initfailed') : undefined;
        const choice = await promptNativePackageFallback(missing, localized);
        if (choice === 'default') {
            try { settings.set('backendMode', 'webr'); } catch { /* noop */ }
        }
        return 'fallback';
    }
}

// function to write the json to an external file for diagnostics
const writeDiagnosticFile = async (label: string, text: string): Promise<string> => {
    await ensureDropDir();
    const timestamp = Date.now();
    const cleanLabel = sanitizeFilename(label) || `native-output-${timestamp}`;
    const dumpPath = path.join(DROP_TEMP_DIR, `${timestamp}-${cleanLabel}.json`);
    await fs.promises.writeFile(dumpPath, text, 'utf8');
    // console.log('[Main] saved native R output to', dumpPath);
    return dumpPath;
};

async function loadCodebookFile(hostFilePath: string) {
    if (!isSupportedCodebookFile(hostFilePath)) {
        dialog.showErrorBox(
            i18n.t('messages.load.failed'),
            i18n.t('messages.load.unsupported')
        );
        return;
    }

    // Send message to renderer to start loader
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('addCover', i18n.t('page.main.loader'));
    }

    try {
        const backendMode = settings.get('backendMode');
        let nativeInitResult = '';
        if (backendMode === 'native') {
            nativeInitResult = await ensureNativeRInitialized();
        }

        // No refusal branch anymore; fallback happens automatically after notice

        if (nativeInitResult === 'ready' && Boolean(nativeRscriptPath)) { // using system R
            try {
                console.log('[Main] loading codebook via native R', hostFilePath);

                await nativeRWorker.evalRVoid(
                    `codeBook <- getCodebook("${utils.escapeForR(hostFilePath)}")`
                );

                const response = await nativeRWorker.evalRString(
                    'jsonlite::toJSON(normalize_codebook(codeBook), auto_unbox = TRUE)'
                );

                loadedCodebook = JSON.parse(response) as JsonValue;
                console.log('[Main] native codebook loaded, tree root', (loadedCodebook as any)?.name);

            } catch (error: any) {
                console.error('[Main] native codebook load failed', error);
                nativeRscriptPath = null;
                nativeRInitialized = false;
                nativeRWorker.stop();

                // Fall back to WebR without surfacing low-level error details
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('addCover', i18n.t('messages.app.initializing.webr'));
                }

                await ensureWebRInitialized();
                console.log('[Main] loading codebook via WebR fallback', hostFilePath);

                const dirname = path.dirname(hostFilePath);
                const filename = path.basename(hostFilePath);

                await mount({ what: dirname, where: '/hostfile' });
                const rPath = `/hostfile/${filename}`;
                await webR.evalRVoid(
                    `codeBook <- getCodebook("${utils.escapeForR(rPath)}")`
                );
                const responseWB = await webR.evalRString(
                    'jsonlite::toJSON(normalize_codebook(codeBook), auto_unbox = TRUE)'
                );
                loadedCodebook = JSON.parse(responseWB) as JsonValue;
            }
        } else {
            if (backendMode === 'native') {
                console.log('[Main] native backend requested but unavailable, using WebR instead', hostFilePath);
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('addCover', i18n.t('messages.app.initializing.webr'));
                }
            }

            await ensureWebRInitialized();
            console.log('[Main] loading codebook via WebR', hostFilePath);

            const dirname = path.dirname(hostFilePath);
            const filename = path.basename(hostFilePath);

            // Mount the host directory so WebR can access the file
            await mount({ what: dirname, where: '/hostfile' });

            const rPath = `/hostfile/${filename}`;
            await webR.evalRVoid(
                `codeBook <- getCodebook("${utils.escapeForR(rPath)}")`
            );

            const response = await webR.evalRString(
                'jsonlite::toJSON(normalize_codebook(codeBook), auto_unbox = TRUE)'
            );

            loadedCodebook = JSON.parse(response) as JsonValue;
        }

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
                const combined = await webR.evalRString(
                    'jsonlite::toJSON(ddi_tree_elements(), auto_unbox = TRUE)'
                );
                return JSON.parse(combined) as DDIBundle;
            })) as DDIBundle;

            dditree = bundle.tree;
            ddielements = bundle.elements;
            broadcastDDIElements();
        } catch (e) {
            // Non-fatal in case the source file is missing in some environments
        }

        finalizeBoot();
    } catch (error) {
        throw error;
    }
}

function broadcastDDIElements() {
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
    const backendMode = settings.get('backendMode');
    const nativeInitResult = backendMode === 'native' ? await ensureNativeRInitialized() : 'fallback';
    if (nativeInitResult === 'refused') return;

    if (nativeInitResult === 'ready' && nativeRscriptPath) {
        try {
            const combined = await nativeRWorker.evalRString(
                'jsonlite::toJSON(ddi_tree_elements(), auto_unbox = TRUE)'
            );
            const bundle = JSON.parse(combined) as DDIBundle;
            dditree = bundle.tree;
            ddielements = bundle.elements;
            broadcastDDIElements();
            finalizeBoot();
            return;
        } catch (error) {
            nativeRscriptPath = null;
            nativeRInitialized = false;
            nativeRWorker.stop();
        }
    }

    if (backendMode === 'native' && nativeInitResult === 'fallback') {
        console.log('[Main] native R backend unavailable, falling back to WebR');
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('addCover', i18n.t('messages.app.initializing.webr'));
        }
    }

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
                    try {
                        const bm = settings.get('backendMode');
                        const useWebR = (bm === 'webr');
                        const key = useWebR ? 'messages.app.initializing.webr' : 'messages.app.initializing';
                        mainWindow.webContents.send('addCover', i18n.t(key));
                    } catch { /* noop */ }
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

            if (channel === 'loadFile') {
                const filePath = String(args[0] ?? '');
                if (filePath) {
                    loadCodebookFile(filePath).catch((e: unknown) => {
                        dialog.showErrorBox(
                            i18n.t('messages.load.failed'),
                            String((e && (e as Error).message) ? (e as Error).message : e)
                        );
                    });
                }
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
        ipcMain.handle('load-dropped-file', async (_event, name: string, data: Buffer) => {
            const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
            const filePath = await writeDroppedFile(name, payload);
            await loadCodebookFile(filePath);
            return filePath;
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
                    filters: [
                        {
                            name: i18n.t('menu.file.loadfilter'),
                            extensions: SUPPORTED_CODEBOOK_EXTENSIONS,
                        },
                    ],
                    properties: ['openFile']
                });
                if (canceled || !filePaths || filePaths.length === 0) return;
                    try {
                        const filePath = filePaths[0];
                        await loadCodebookFile(filePath);
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

    const currentBackendMode = settings.get('backendMode');
    const setBackend = (mode: BackendMode) => {
        try { settings.set('backendMode', mode); } catch { /* noop */ }
        const mainMenu = Menu.buildFromTemplate(buildMainMenuTemplate());
        Menu.setApplicationMenu(mainMenu);
        if (mode === 'webr') {
            try { mainWindow?.webContents.send('addCover', i18n.t('messages.app.initializing.webr')); } catch { /* noop */ }
            ensureWebRInitialized()
                .catch(() => { /* ignore; UI will surface on next action if needed */ })
                .finally(() => { try { mainWindow?.webContents.send('removeCover'); } catch { /* noop */ } });
        }
    };

    const backendSubmenu: MenuItemConstructorOptions[] = [
        {
            label: i18n.t('settings.backend.native'),
            type: 'radio',
            checked: currentBackendMode === 'native',
            click: () => setBackend('native')
        },
        {
            label: i18n.t('settings.backend.webr'),
            type: 'radio',
            checked: currentBackendMode === 'webr',
            click: () => setBackend('webr')
        },
    ];

    const settingsSubmenu: MenuItemConstructorOptions[] = [
        {
            label: i18n.t('tree.labels'),
            submenu: treeLabelsSubmenu
        },
        { type: 'separator' },
        {
            label: i18n.t('settings.backend'),
            submenu: backendSubmenu
        },
    ];

    template.push({
        label: i18n.t('menu.settings'),
        submenu: settingsSubmenu,
        enabled: !booting
    });

    return template;
}

async function findNativeRscript(): Promise<string | null> {
    // console.log('[Main] searching for native Rscript executable...');
    const finder = Windows_OS ? 'where' : 'which';
    return new Promise((resolve) => {
        execFile(finder, ['Rscript'], (error, stdout) => {
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
        // console.log(`[Main] Native Rscript available at ${nativeRscriptPath}`);
    // } else {
        // console.log('[Main] Native Rscript not found; falling back to WebR for codebook loading');
    // }

    createMainWindow();
    setupIPC();

    initializeRBackend().catch((error) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        dialog.showErrorBox("Failed to initialize system R", errorMessage);
    });

    // Ensure a default label mode exists
    try {
        const v = settings.get('treeLabelMode');
        if (v !== 'name' && v !== 'title' && v !== 'both') settings.set('treeLabelMode', 'both');
    } catch { /* noop */ }
    try {
        const backend = settings.get('backendMode');
        if (backend !== 'native' && backend !== 'webr') settings.set('backendMode', 'native');
    } catch { /* noop */ }
});

app.on('window-all-closed', () => {
    app.quit();
});
