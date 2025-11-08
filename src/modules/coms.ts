// encapsulation

import { ipcRenderer } from 'electron';
import { Communications } from '../interfaces/coms';
import { EventEmitter } from 'events';
// import { utils } from '../library/utils';
// import { renderutils } from '../library/renderutils';


const messenger = new EventEmitter();

// Track which channels have been hooked into ipcRenderer
const registeredChannels = new Set<string>();

export const coms: Communications = {
    emit(channel, ...args) {
        messenger.emit(channel, ...args);
    },

    // send to all listeners from all processes, via ipcMain
    send(channel, ...args) {
        coms.sendTo('all', channel, ...args);
        // ipcRenderer.send("send-to", "all", channel, ...args);
    },

    sendTo(window, channel, ...args) {
        ipcRenderer.send("send-to", window, channel, ...args);
    },

    on(channel, listener) {
        // Ensure ipcRenderer is listening only once per logical channel
        const responseChannel = `message-from-main-${channel}`;

        if (!registeredChannels.has(channel)) {
            // Support both the legacy prefixed channel and a clean channel name
            ipcRenderer.on(responseChannel, (_event, ...args) => {
                messenger.emit(channel, ...args);
            });
            ipcRenderer.on(channel, (_event, ...args) => {
                messenger.emit(channel, ...args);
            });
            registeredChannels.add(channel);
        }

        messenger.on(channel, listener);
    },

    once(channel, listener) {
        const responseChannel = `message-from-main-${channel}`;

        if (!registeredChannels.has(channel)) {
            ipcRenderer.on(responseChannel, (_event, ...args) => {
                messenger.emit(channel, ...args);
            });
            ipcRenderer.on(channel, (_event, ...args) => {
                messenger.emit(channel, ...args);
            });
            registeredChannels.add(channel);
        }

        messenger.once(channel, listener);
    },

    // IPC dispatcher
    handlers: {
        addCover: '../modules/cover',
        removeCover: '../modules/cover'
    },

    fontSize: 12,
    fontFamily: "'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, 'Noto Sans', 'Liberation Sans', sans-serif",
    maxWidth: 615,
    maxHeight: 455,
}

// Template note: automatic dispatch to app-specific handlers is removed.
// You can register listeners explicitly via coms.on(...) in each window.

coms.on('consolog', (...args: unknown[]) => {
    console.log(args[0]);
});


export const showMessage = (
    type: 'info' | 'error' | 'question' | 'warning',
    title: string,
    message: string
) => {
    coms.sendTo('main', 'showDialogMessage', type, title, message);
}

export const showError = (message: string) => {
    coms.sendTo('main', 'showError', message);
}
