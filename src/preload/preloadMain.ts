// Minimal preload for the Main window: wire cover overlay listeners
import { coms } from '../modules/coms';
import { cover } from '../modules/cover';
import { contextBridge } from 'electron';
import { i18n } from '../i18n';
import * as path from 'path';

coms.on('addCover', () => {
  try { cover.addCover(); } catch { /* noop */ }
});

coms.on('removeCover', () => {
  try { cover.removeCover(); } catch { /* noop */ }
});

export {};

// i18n: initialize with whatever main chose (will be synced shortly)
try { i18n.init(i18n.getLocale(), path.resolve(__dirname)); } catch { /* noop */ }

// Expose minimal API to the page
try {
  contextBridge.exposeInMainWorld('i18n', {
    t: (key: string) => i18n.t(key, undefined, path.resolve(__dirname)),
    getLocale: () => i18n.getLocale(),
    setLocale: (lang: string) => coms.sendTo('main', 'setLanguage', lang),
    translatePage: () => i18n.translateDocument(document, path.resolve(__dirname)),
  });
} catch { /* noop */ }

// When main announces a language change, refresh the page texts
coms.on('i18nLanguageChanged', (langUnknown: unknown) => {
  try {
    const lang = String(langUnknown);
    i18n.setLocale(lang, path.resolve(__dirname));
    i18n.translateDocument(document, path.resolve(__dirname));
  } catch { /* noop */ }
});

// Auto-translate once DOM is ready
try {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => i18n.translateDocument(document, path.resolve(__dirname)));
  } else {
    i18n.translateDocument(document, path.resolve(__dirname));
  }
} catch { /* noop */ }
