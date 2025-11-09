// Minimal preload for the Main window: wire cover overlay listeners
import { coms } from '../modules/coms';
import { cover } from '../modules/cover';
import { contextBridge, ipcRenderer } from 'electron';
import { i18n } from '../i18n';
import * as path from 'path';

coms.on('addCover', (text: unknown) => {
  try {
    cover.addCover(typeof text === 'string' ? text : undefined);
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
      try { initTree(); } catch { /* noop */ }
    });
  } else {
    i18n.translateDocument(document, path.resolve(__dirname));
    try { initSplitter(); } catch { /* noop */ }
    try { initTree(); } catch { /* noop */ }
  }
} catch { /* noop */ }

// --- Resizable tree/metadata splitter ---
function initSplitter() {
  const LS_KEY = 'mp-left-width';
  const root = document.documentElement;
  const content = document.querySelector('.content') as HTMLElement | null;
  const splitter = document.getElementById('splitter') as HTMLElement | null;
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

// --- ARIA Tree renderer (minimal) ---
type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [k: string]: JsonValue };

type TreeNode = {
  id: string;
  label: string;
  children?: TreeNode[];
};

function jsonToTree(value: JsonValue, idPrefix = 'root', keyLabel = 'root'): TreeNode {
  // Arrays represent unnamed children -> treat as values: don't render items as tree nodes
  if (Array.isArray(value)) {
    return { id: idPrefix, label: keyLabel };
  }
  if (value !== null && typeof value === 'object') {
    // Object: hide `.extra`, avoid grouping wrappers, display repeated siblings individually
    const obj = value as { [k: string]: JsonValue };
    const label = keyLabel;
    const entries = Object.entries(obj).filter(([k]) => k !== '.extra' && k !== '.attributes');

    // If keys are numeric-only, treat as unnamed values -> collapse to leaf
    const numericKeyed = entries.length > 0 && entries.every(([k]) => /^\d+$/.test(k));
    if (numericKeyed) {
      // Treat as values: do not show actual values in the tree
      return { id: idPrefix, label };
    }

    const stripSuffix = (k: string) => k.replace(/\.\d+$/u, '');
    const children: TreeNode[] = entries.map(([k, v]) => {
      const base = stripSuffix(k);
      // Child nodes keep the element name (base) as label; no grouping wrapper
      return jsonToTree(v, `${idPrefix}.${k}`, base);
    });
    return { id: idPrefix, label, children };
  }
  // Primitive leaf -> values are not displayed in the tree
  return { id: idPrefix, label: keyLabel };
}

function initTree() {
  const container = document.querySelector('.tree-area') as HTMLElement | null;
  if (!container) return;

  const render = (rootJson: unknown) => {
    if (!rootJson) return;
    const treeData = jsonToTree(rootJson as JsonValue);
    mountAriaTree(container, treeData);
  };

  // 1) Try immediate fetch
  ipcRenderer.invoke('get-dditree').then((tree) => {
    if (tree) render(tree);
  }).catch(() => {});

  // 2) Also listen for a later broadcast
  coms.on('dditree', (tree: unknown) => render(tree));
}

function mountAriaTree(container: HTMLElement, data: TreeNode) {
  container.innerHTML = '';
  const expanded = new Set<string>([data.id]);
  let focusedId: string | null = data.id;
  let selectedId: string | null = null;
  let firstRender = true;

  const root = document.createElement('ul');
  root.className = 'tree';
  root.setAttribute('role', 'tree');
  container.appendChild(root);

  const renderNode = (node: TreeNode): HTMLElement => {
    const li = document.createElement('li');
    li.className = 'tree__item';
    li.setAttribute('role', 'treeitem');
    li.id = `tree-${node.id}`;
    const hasChildren = !!(node.children && node.children.length);
    if (hasChildren) {
      li.setAttribute('aria-expanded', expanded.has(node.id) ? 'true' : 'false');
    }

    // Roving tabindex
    li.tabIndex = (focusedId === node.id) ? 0 : -1;
    if (selectedId === node.id) li.classList.add('is-selected');

    const row = document.createElement('div');
    row.className = 'tree__row';
    const disclosure = document.createElement('span');
    disclosure.className = 'tree__disclosure' + (hasChildren ? '' : ' is-leaf');
    const label = document.createElement('span');
    label.className = 'tree__label';
    label.textContent = node.label;
    row.appendChild(disclosure);
    row.appendChild(label);
    li.appendChild(row);

    // Mouse interactions
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      focusedId = node.id;
      selectedId = node.id;
      if (hasChildren) toggle(node.id);
      rerender();
    });

    // Keyboard interactions
    li.addEventListener('keydown', (e) => {
      const visible = visibleNodes();
      const idx = visible.findIndex(n => n.id === node.id);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = visible[idx + 1];
        if (next) { focusedId = next.id; focusRow(next.id); }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = visible[idx - 1];
        if (prev) { focusedId = prev.id; focusRow(prev.id); }
      } else if (e.key === 'ArrowRight') {
        if (hasChildren) {
          if (!expanded.has(node.id)) { toggle(node.id); rerender(); }
          else { // move to first child
            const first = node.children![0];
            focusedId = first.id; rerender();
          }
        }
      } else if (e.key === 'ArrowLeft') {
        if (hasChildren && expanded.has(node.id)) { toggle(node.id); rerender(); }
        else { // move to parent
          const parentId = parentOf(node.id);
          if (parentId) { focusedId = parentId; rerender(); }
        }
      } else if (e.key === 'Home') {
        e.preventDefault();
        const first = visible[0];
        if (first) { focusedId = first.id; rerender(); }
      } else if (e.key === 'End') {
        e.preventDefault();
        const last = visible[visible.length - 1];
        if (last) { focusedId = last.id; rerender(); }
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectedId = node.id;
        if (hasChildren) toggle(node.id);
        rerender();
      }
    });

    if (hasChildren && expanded.has(node.id)) {
      const group = document.createElement('ul');
      group.className = 'tree__group';
      group.setAttribute('role', 'group');
      for (const child of node.children!) group.appendChild(renderNode(child));
      li.appendChild(group);
    }
    return li;
  };

  const parentOf = (id: string): string | null => {
    const idx = id.lastIndexOf('.');
    return idx > 0 ? id.slice(0, idx) : null;
  };

  const toggle = (id: string) => {
    if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
  };

  const visibleNodes = (): TreeNode[] => {
    const out: TreeNode[] = [];
    const walk = (n: TreeNode) => {
      out.push(n);
      if (n.children && expanded.has(n.id)) n.children.forEach(walk);
    };
    walk(data);
    return out;
  };

  const focusRow = (id: string) => {
    const el = container.querySelector(`#tree-${CSS.escape(id)}`) as HTMLElement | null;
    if (!el) return;
    el.focus();
  };

  const rerender = () => {
    root.innerHTML = '';
    root.appendChild(renderNode(data));
    // Avoid initial focus ring, but keep focus on subsequent rerenders
    if (!firstRender) {
      // Restore focus to the newly rendered focused node
      setTimeout(() => focusRow(focusedId || data.id), 0);
    }
    firstRender = false;
  };

  rerender();

}
