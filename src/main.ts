const development = process.env.NODE_ENV === 'development';

import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import * as path from 'path';
import * as fs from "fs";
import { WebR } from "webr";
import { ungzip } from "pako";
import { i18n } from './i18n';
import { MountArgs } from './interfaces/main';

let mainWindow: BrowserWindow;
const webR = new WebR({ interactive: false });

const windowid: { [key: string]: number } = {
    mainWindow: 1,
};


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

        // mount a virtual filesystem containing contributed R packages
        const buffer = Buffer.from(ungzip(fs.readFileSync(
            path.join(__dirname, '../src/library/R/library.data.gz')
        )));
        const data = new Blob([buffer]);

        const metadata = JSON.parse(
            fs.readFileSync(
                path.join(__dirname, '../src/library/R/library.js.metadata'),
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
    } catch (error) {
        throw error;
    }
}


function createMainWindow() {
    mainWindow = new BrowserWindow({
        title: i18n.t('app.title.main'),
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
            // Rebuild menus and update window titles
            const mainMenu = Menu.buildFromTemplate(buildMainMenuTemplate());
            Menu.setApplicationMenu(mainMenu);
            if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.setTitle(i18n.t('app.title.main'));
            }
            // Notify all renderer processes
            BrowserWindow.getAllWindows().forEach((win) => {
            if (!win.isDestroyed()) {
                win.webContents.send(
                'message-from-main-i18nLanguageChanged',
                lang
                );
            }
            });
            return;
        }
        // Add other main-handled channels here as needed
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
}

function buildMainMenuTemplate(): MenuItemConstructorOptions[] {
    const fileSubmenu: MenuItemConstructorOptions[] = [
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
        label: `${lang}${lang === i18n.getLocale() ? ' ✓' : ''}`,
        type: 'normal',
        click: () => {
        i18n.setLocale(lang);
        const mainMenu = Menu.buildFromTemplate(buildMainMenuTemplate());
        Menu.setApplicationMenu(mainMenu);
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.setTitle(i18n.t('app.title.main'));
        }
        BrowserWindow.getAllWindows().forEach((win) => {
            if (!win.isDestroyed()) {
            try { win.webContents.send('message-from-main-i18nLanguageChanged', lang); } catch {}
            }
        });
        },
    }));
    template.push({ label: i18n.t('menu.language'), submenu: langSubmenu });
    return template;
}

app.whenReady().then(() => {
  // Initialize i18n with system locale (best-effort)
    try {
        const sysLocale = app.getLocale ? app.getLocale() : 'en';
        const short = (sysLocale || 'en').slice(0, 2);
        i18n.init(short, __dirname);
    } catch {
        i18n.init('en', __dirname);
    }
    createMainWindow();
    setupIPC();
    initWebR().catch((error) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        dialog.showErrorBox("Failed to initialize WebR", errorMessage);
    });
});

app.on('window-all-closed', () => {
    app.quit();
});
