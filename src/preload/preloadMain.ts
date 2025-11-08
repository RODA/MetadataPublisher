// Minimal preload for the Main window: wire cover overlay listeners
import { coms } from '../modules/coms';
import { cover } from '../modules/cover';
import { contextBridge } from 'electron';
import { i18n } from '../i18n';
import * as path from 'path';

coms.on('addCover', () => {
  try {
    cover.addCover();
  } catch { /* noop */ }
});

coms.on('removeCover', () => {
  try {
    cover.removeCover();
  } catch { /* noop */ }
});

export {};

// i18n: initialize with whatever main chose (will be synced shortly)
try {
  i18n.init(i18n.getLocale(), path.resolve(__dirname));
} catch { /* noop */ }

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
    document.addEventListener('DOMContentLoaded', () => {
      i18n.translateDocument(document, path.resolve(__dirname));
      try { initSplitter(); } catch { /* noop */ }
    });
  } else {
    i18n.translateDocument(document, path.resolve(__dirname));
    try { initSplitter(); } catch { /* noop */ }
  }
} catch { /* noop */ }

// --- Resizable tree/metadata splitter ---
function initSplitter() {
  const LS_KEY = 'mp-left-width';
  const root = document.documentElement;
  const content = document.querySelector('.content') as HTMLElement | null;
  const splitter = document.getElementById('hsplitter') as HTMLElement | null;
  if (!content || !splitter) return;

  const getCssVarPx = (name: string): number => {
    const v = getComputedStyle(root).getPropertyValue(name).trim();
    return parseFloat(v.replace('px', '')) || 0;
  };
  const setTreeWidth = (px: number) => {
    root.style.setProperty('--tree-width', `${px}px`);
  };

  // Restore saved width if present
  try {
    const saved = localStorage.getItem(LS_KEY);
    if (saved) setTreeWidth(parseFloat(saved));
  } catch { /* noop */ }

  const defaultLeft = getCssVarPx('--tree-width');
  const splitterWidth = getCssVarPx('--splitter-width') || 3;
  const getMinLeft = () => getCssVarPx('--tree-min-width') || 200;
  const getMinMeta = () => getCssVarPx('--meta-min-width') || 260;

  let dragging = false;

  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return;
    const rect = content.getBoundingClientRect();
    const contentWidth = rect.width;
    let nextLeft = e.clientX - rect.left - splitterWidth / 2;
    const MIN_LEFT = getMinLeft();
    const MIN_META = getMinMeta();
    const maxLeft = contentWidth - splitterWidth - MIN_META;
    nextLeft = Math.max(MIN_LEFT, Math.min(maxLeft, nextLeft));
    setTreeWidth(Math.round(nextLeft));
  };

  const stopDragging = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('dragging');
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', stopDragging);
    try {
      const current = getCssVarPx('--tree-width');
      localStorage.setItem(LS_KEY, String(current));
    } catch { /* noop */ }
  };

  splitter.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    dragging = true;
    document.body.classList.add('dragging');
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', stopDragging);
  });

  splitter.addEventListener('keydown', (e: KeyboardEvent) => {
    const step = e.shiftKey ? 20 : 10;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const current = getCssVarPx('--tree-width');
      const rect = content.getBoundingClientRect();
      const contentWidth = rect.width;
      const MIN_LEFT = getMinLeft();
      const MIN_META = getMinMeta();
      const maxLeft = contentWidth - splitterWidth - MIN_META;
      const delta = e.key === 'ArrowLeft' ? -step : step;
      const next = Math.max(MIN_LEFT, Math.min(maxLeft, current + delta));
      setTreeWidth(next);
      try { localStorage.setItem(LS_KEY, String(next)); } catch { /* noop */ }
      e.preventDefault();
    } else if (e.key === 'Enter') {
      setTreeWidth(defaultLeft);
      try { localStorage.setItem(LS_KEY, String(defaultLeft)); } catch { /* noop */ }
    }
  });

  splitter.addEventListener('dblclick', () => {
    setTreeWidth(defaultLeft);
    try { localStorage.setItem(LS_KEY, String(defaultLeft)); } catch { /* noop */ }
  });
}
