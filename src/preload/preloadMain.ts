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
  path: string[]; // array of actual object keys from codeBook root
  children?: TreeNode[];
};

type ElementsIndex = { [k: string]: string } | undefined;
type LabelMode = 'name' | 'title' | 'both';
type RawElements = { [k: string]: any } | undefined;

function normalizeName(name: string): string {
  const noNs = name.includes(':') ? (name.split(':').pop() || name) : name;
  return noNs.replace(/\.\d+$/u, '');
}

function jsonToTree(
  value: JsonValue,
  elements: ElementsIndex,
  mode: LabelMode,
  idPrefix = 'root',
  keyLabel = 'root',
  pathKeys: string[] = [],
): TreeNode {
  const lookupTitle = (name: string): string | undefined => {
    const norm = normalizeName(name);
    return elements?.[norm];
  };

  const compose = (name: string): string => {
    const title = lookupTitle(name);
    if (mode === 'name') return name;
    if (mode === 'title') return title || name;
    return title ? `${name}: ${title}` : name;
  };
  // Arrays represent unnamed children -> treat as values: don't render items as tree nodes
  if (Array.isArray(value)) {
    return { id: idPrefix, label: compose(keyLabel), path: pathKeys };
  }
  if (value !== null && typeof value === 'object') {
    // Object: hide `.extra`, avoid grouping wrappers, display repeated siblings individually
    const obj = value as { [k: string]: JsonValue };
    const label = compose(keyLabel);
    const entries = Object.entries(obj).filter(([k]) => k !== '.extra' && k !== '.attributes');

    // If object only wraps text (e.g., {".text":"..."} or {"text":"..."}), treat as leaf
    const wrapperSet = new Set(['.text', 'text', '#text', 'value']);
    const nonWrapper = entries.filter(([k]) => !wrapperSet.has(k));
    if (entries.length > 0 && nonWrapper.length === 0) {
      return { id: idPrefix, label, path: pathKeys };
    }

    // If there is a single unnamed key (""), treat as leaf value (common from R JSON)
    if (entries.length === 1) {
      const [ek, ev] = entries[0];
      if (ek === '' && (ev === null || typeof ev === 'string' || typeof ev === 'number' || typeof ev === 'boolean')) {
        return { id: idPrefix, label, path: pathKeys };
      }
    }

    // If keys are numeric-only, treat as unnamed values -> collapse to leaf
    const numericKeyed = entries.length > 0 && entries.every(([k]) => /^\d+$/.test(k));
    if (numericKeyed) {
      // Treat as values: do not show actual values in the tree
      return { id: idPrefix, label, path: pathKeys };
    }

    const stripSuffix = (k: string) => k.replace(/\.\d+$/u, '');
    const children: TreeNode[] = entries.map(([k, v]) => {
      const base = stripSuffix(k);
      // Child nodes keep the element name (base) as label; no grouping wrapper
      return jsonToTree(v, elements, mode, `${idPrefix}.${k}`, base, pathKeys.concat([k]));
    });
    return { id: idPrefix, label, path: pathKeys, children };
  }
  // Primitive leaf -> values are not displayed in the tree
  return { id: idPrefix, label: compose(keyLabel), path: pathKeys };
}

function initTree() {
  const container = document.querySelector('.tree-area') as HTMLElement | null;
  if (!container) return;
  const metaArea = document.querySelector('.metadata-area') as HTMLElement | null;
  const metaContent = document.querySelector('.meta-content') as HTMLElement | null;
  const topToolbar = document.getElementById('toolbar') as HTMLElement | null;
  // Slot inside top toolbar to host context controls
  let controlsSlot: HTMLElement | null = null;
  if (topToolbar) {
    controlsSlot = topToolbar.querySelector('.tree-controls') as HTMLElement | null;
    if (!controlsSlot) {
      controlsSlot = document.createElement('div');
      controlsSlot.className = 'tree-controls';
      topToolbar.appendChild(controlsSlot);
    }
  }

  const state = {
    mode: 'both' as LabelMode,
    elements: undefined as ElementsIndex,
    rawElements: undefined as RawElements,
    lastPayload: null as JsonValue | null,
    treeRoot: null as JsonValue | null,
    selectedId: null as string | null,
    selectedPath: null as string[] | null,
  };

  const render = (rootJson: unknown) => {
    if (!rootJson) return;
    state.lastPayload = rootJson as JsonValue;
    let treeRoot: JsonValue = state.lastPayload;
    let rootLabel = 'root';
    // Expect composite payload: { codeBook, elements }
    if (state.lastPayload && typeof state.lastPayload === 'object' && !Array.isArray(state.lastPayload)) {
      const obj = state.lastPayload as any;
      const code = obj.codeBook || obj.Codebook || null;
      if (code) {
        treeRoot = code as JsonValue;
        rootLabel = 'codeBook';
        if (obj.elements && typeof obj.elements === 'object') {
          // Build a simple string index from incoming elements map
          const idx: { [k: string]: string } = {};
          for (const [k, v] of Object.entries(obj.elements as Record<string, unknown>)) {
            if (typeof v === 'string') idx[normalizeName(k)] = v as string;
            else if (v && typeof v === 'object') {
              const t = (v as any).title || (v as any).Title || (v as any).label || (v as any).Label;
              if (typeof t === 'string') idx[normalizeName(k)] = t as string;
            }
          }
          state.elements = idx;
          state.rawElements = obj.elements as RawElements;
        }
      }
    }
    state.treeRoot = treeRoot;
    const treeData = jsonToTree(treeRoot, state.elements, state.mode, 'root', rootLabel, []);
    mountAriaTree(container, treeData, (nodeId, path) => {
      state.selectedId = nodeId;
      state.selectedPath = path || null;
      renderMetadata();
    }, state.selectedId || undefined);
    renderMetadata();
  };

  // 1) Try immediate fetch
  // Fetch initial label mode from main
  ipcRenderer.invoke('get-tree-label-mode').then((mode) => {
    if (mode === 'name' || mode === 'title' || mode === 'both') state.mode = mode;
  }).catch(() => {});

  // 1) Try immediate fetch
  ipcRenderer.invoke('get-dditree').then((tree) => {
    if (tree) render(tree);
  }).catch(() => {});

  // 2) Also listen for a later broadcast
  coms.on('dditree', (tree: unknown) => render(tree));

  // React to Tree Label Mode changes from Settings menu
  coms.on('treeLabelModeChanged', (mode: unknown) => {
    const m = String(mode);
    if (m === 'name' || m === 'title' || m === 'both') {
      state.mode = m;
      if (state.lastPayload) render(state.lastPayload);
    }
  });

  function renderMetadata() {
    if (!metaArea || !metaContent || !controlsSlot) return;
    if (!metaArea) return;
    // Reset content area, keep toolbar node
    metaContent.innerHTML = '';
    controlsSlot.innerHTML = '';
    if (!state.treeRoot || !state.selectedId) return;

    // Build path tokens after 'root'
    let keyPath: string[];
    if (state.selectedPath && state.selectedPath.length) {
      keyPath = state.selectedPath.slice();
    } else {
      const id = state.selectedId;
      const parts = id.split('.');
      if (parts[0] !== 'root') return;
      keyPath = parts.slice(1);
    }

    // Follow path to get parent and key
    const res = getParentAndKey(state.treeRoot as any, keyPath);
    if (!res) return;
    const { parent, key, value } = res;

    // Title and path
    const title = document.createElement('h1');
    title.textContent = keyPath.join(' / ');
    title.style.margin = '12px';
    metaContent.appendChild(title);

    const controls = document.createElement('div');
    controls.style.margin = '0 12px 12px 12px';

    // Editor for primitive values OR common wrapped-text schemas (e.g., { ".text": "..." })
    let editableObj: any = null;
    let editableProp: string | null = null;
    let currentStr = '';
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      editableObj = parent; editableProp = key; currentStr = value === null ? '' : String(value);
    } else if (value && typeof value === 'object') {
      const v: any = value;
      // Common wrapped text fields
      let wrappedProp = typeof v['.text'] === 'string' ? '.text'
        : (typeof v['text'] === 'string' ? 'text'
        : (typeof v['#text'] === 'string' ? '#text'
        : (typeof v['value'] === 'string' ? 'value' : null)));
      // Numeric-keyed single value (e.g., {"1":"..."})
      if (!wrappedProp) {
        const entries = Object.entries(v).filter(([kk]) => kk !== '.attributes' && kk !== '.extra');
        const numericOnly = entries.length === 1 && /^\d+$/.test(entries[0][0]) &&
          (typeof entries[0][1] === 'string' || typeof entries[0][1] === 'number' || typeof entries[0][1] === 'boolean');
        if (numericOnly) {
          wrappedProp = entries[0][0];
        } else if (entries.length === 1 && typeof entries[0][1] === 'string') {
          wrappedProp = entries[0][0];
        } else if (entries.length === 1 && /^\d+$/.test(entries[0][0]) && entries[0][1] && typeof entries[0][1] === 'object') {
          // Numeric-keyed object that itself wraps text (e.g., {"1": {"#text": "..."}})
          const inner: any = entries[0][1];
          const innerKey = typeof inner['.text'] === 'string' ? '.text'
            : (typeof inner['text'] === 'string' ? 'text'
            : (typeof inner['#text'] === 'string' ? '#text'
            : (typeof inner['value'] === 'string' ? 'value' : null)));
          if (innerKey) {
            editableObj = inner; editableProp = innerKey; currentStr = String(inner[innerKey]);
          }
        } else {
          // Special case: unnamed key "" (value) possibly next to .extra
          const emptyKey = entries.find(([kk, vv]) => kk === '' && (vv === null || typeof vv === 'string' || typeof vv === 'number' || typeof vv === 'boolean'));
          if (emptyKey) {
            wrappedProp = '';
          }
        }
      }
      if (wrappedProp) {
        editableObj = v; editableProp = wrappedProp; currentStr = String(v[wrappedProp]);
      }
    }

    if (editableObj && editableProp) {
      const label = document.createElement('div');
      label.textContent = 'Value';
      label.style.marginBottom = '6px';
      controls.appendChild(label);

      const input = document.createElement(currentStr.length > 60 ? 'textarea' : 'input');
      if (input instanceof HTMLTextAreaElement) {
        input.rows = 4;
        input.style.width = '96%';
      } else {
        (input as HTMLInputElement).type = 'text';
        (input as HTMLInputElement).style.width = '96%';
      }
      (input as HTMLInputElement | HTMLTextAreaElement).value = currentStr;
      const apply = () => {
        const newVal = (input as HTMLInputElement | HTMLTextAreaElement).value;
        editableObj![editableProp!] = newVal;
      };
      input.addEventListener('change', apply);
      input.addEventListener('blur', apply);
      controls.appendChild(input);
    } else {
      const info = document.createElement('div');
      info.textContent = 'This node is a container (not directly editable).';
      controls.appendChild(info);
    }

    // Add sibling if repeatable
    const baseName = normalizeName(key);
    const repeatable = isRepeatable(baseName, parent);
    // Toolbar (top): + button for adding siblings
    const addBtn = document.createElement('button');
    addBtn.title = 'Add sibling';
    addBtn.textContent = '+';
    addBtn.disabled = !repeatable;
    addBtn.addEventListener('click', () => {
      if (!repeatable) return;
      const parentObj = parent as any;
      const newKey = nextSiblingKey(baseName, parentObj);
      const newVal: any = emptyLike(value);
      parentObj[newKey] = newVal;
      const rootLabel = 'codeBook';
      const treeData = jsonToTree(state.treeRoot as JsonValue, state.elements, state.mode, 'root', rootLabel);
      const newSelectedPath = keyPath.slice(0, -1).concat([newKey]);
      const newSelectedId = 'root.' + newSelectedPath.join('.');
      state.selectedId = newSelectedId;
      state.selectedPath = newSelectedPath;
      mountAriaTree(container!, treeData, (nid) => { state.selectedId = nid; renderMetadata(); }, newSelectedId);
      renderMetadata();
    });
    controlsSlot.appendChild(addBtn);

    // Toolbar: delete current sibling
    const delBtn = document.createElement('button');
    delBtn.title = 'Delete sibling';
    delBtn.textContent = '−';
    delBtn.disabled = false;
    delBtn.addEventListener('click', () => {
      const parentObj = parent as any;
      const sibs = siblingKeys(parentObj, baseName);
      const idx = sibs.indexOf(key);
      if (idx === -1) return;
      delete parentObj[key];
      const rootLabel = 'codeBook';
      const treeData = jsonToTree(state.treeRoot as JsonValue, state.elements, state.mode, 'root', rootLabel);
      const nextSelKey = sibs[idx + 1] || sibs[idx - 1] || null;
      if (nextSelKey) {
        const p = keyPath.slice(0, -1).concat([nextSelKey]);
        state.selectedPath = p; state.selectedId = 'root.' + p.join('.');
      } else {
        const p = keyPath.slice(0, -1);
        state.selectedPath = p; state.selectedId = 'root.' + p.join('.');
      }
      mountAriaTree(container!, treeData, (nid) => { state.selectedId = nid; renderMetadata(); }, state.selectedId);
      renderMetadata();
    });
    controlsSlot.appendChild(delBtn);

    // Toolbar: move up/down within sibling group
    const upBtn = document.createElement('button');
    upBtn.title = 'Move up';
    upBtn.textContent = '↑';
    const dnBtn = document.createElement('button');
    dnBtn.title = 'Move down';
    dnBtn.textContent = '↓';
    const sibsNow = siblingKeys(parent as any, baseName);
    const idxNow = sibsNow.indexOf(key);
    upBtn.disabled = !repeatable || idxNow <= 0;
    dnBtn.disabled = !repeatable || idxNow === -1 || idxNow >= sibsNow.length - 1;
    upBtn.addEventListener('click', () => {
      const parentObj = parent as any;
      const sibs = siblingKeys(parentObj, baseName);
      const i = sibs.indexOf(key);
      if (i > 0) {
        const newOrder = sibs.slice();
        [newOrder[i - 1], newOrder[i]] = [newOrder[i], newOrder[i - 1]];
        reorderSiblings(parentObj, baseName, newOrder);
        const rootLabel = 'codeBook';
        const treeData = jsonToTree(state.treeRoot as JsonValue, state.elements, state.mode, 'root', rootLabel);
        const p = keyPath.slice(0, -1).concat([key]);
        state.selectedPath = p; state.selectedId = 'root.' + p.join('.');
        mountAriaTree(container!, treeData, (nid) => { state.selectedId = nid; renderMetadata(); }, state.selectedId);
        renderMetadata();
      }
    });
    dnBtn.addEventListener('click', () => {
      const parentObj = parent as any;
      const sibs = siblingKeys(parentObj, baseName);
      const i = sibs.indexOf(key);
      if (i !== -1 && i < sibs.length - 1) {
        const newOrder = sibs.slice();
        [newOrder[i], newOrder[i + 1]] = [newOrder[i + 1], newOrder[i]];
        reorderSiblings(parentObj, baseName, newOrder);
        const rootLabel = 'codeBook';
        const treeData = jsonToTree(state.treeRoot as JsonValue, state.elements, state.mode, 'root', rootLabel);
        const p = keyPath.slice(0, -1).concat([key]);
        state.selectedPath = p; state.selectedId = 'root.' + p.join('.');
        mountAriaTree(container!, treeData, (nid) => { state.selectedId = nid; renderMetadata(); }, state.selectedId);
        renderMetadata();
      }
    });
    controlsSlot.appendChild(upBtn);
    controlsSlot.appendChild(dnBtn);

    metaContent.appendChild(controls);
  }

  function getParentAndKey(root: any, keys: string[]): { parent: any; key: string; value: any } | null {
    let parent: any = null;
    let obj: any = root;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (i === keys.length - 1) {
        return { parent: obj, key: k, value: obj ? obj[k] : undefined };
      }
      if (!obj || typeof obj !== 'object') return null;
      obj = obj[k];
      parent = obj;
    }
    return null;
  }

  function isRepeatable(base: string, parentObj?: Record<string, unknown>): boolean {
    const e = state.rawElements ? (state.rawElements[base] || state.rawElements[base + ''] || undefined) : undefined;
    if (!e) return false;
    // Heuristics: consider common fields that denote multiplicity
    const v = (e.repeatable ?? e.isRepeatable ?? e.multiple ?? e.cardinality ?? e.occurs ?? e.maxOccurs) as any;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 1 && v !== 0;
    if (typeof v === 'string') {
      const s = v.toLowerCase();
      if (s === 'true' || s === 'multiple' || s === 'many' || s === 'unbounded') return true;
      const n = parseInt(s, 10); if (!Number.isNaN(n)) return n !== 1 && n !== 0;
    }
    // Fallback: if siblings exist with numeric suffixes, treat as repeatable
    if (parentObj) {
      for (const k of Object.keys(parentObj)) {
        if (new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.(\\d+)$').test(k)) return true;
      }
    }
    return false;
  }

  function nextSiblingKey(base: string, parentObj: Record<string, unknown>): string {
    let max = 0;
    let hasBase = false;
    for (const k of Object.keys(parentObj)) {
      if (k === base) { hasBase = true; continue; }
      const m = k.match(new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.(\\d+)$'));
      if (m) {
        const idx = parseInt(m[1], 10);
        if (!Number.isNaN(idx)) max = Math.max(max, idx);
      }
    }
    const next = hasBase ? max + 1 : 1;
    return `${base}.${next}`;
  }

  function emptyLike(value: any): any {
    // Primitive -> empty string
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return '';
    if (value && typeof value === 'object') {
      const v: any = value;
      // Unnamed value with optional .extra
      if (v && Object.prototype.hasOwnProperty.call(v, '')) return { '': '' };
      if (typeof v['.text'] === 'string') return { '.text': '' };
      if (typeof v['text'] === 'string') return { 'text': '' };
      if (typeof v['#text'] === 'string') return { '#text': '' };
      if (typeof v['value'] === 'string') return { 'value': '' };
      const entries = Object.entries(v).filter(([kk]) => kk !== '.attributes' && kk !== '.extra');
      if (entries.length === 1 && /^\d+$/.test(entries[0][0])) {
        const single = entries[0][1] as any;
        const idxKey = entries[0][0];
        if (single && typeof single === 'object') {
          if (typeof single['.text'] === 'string') return { [idxKey]: { '.text': '' } };
          if (typeof single['text'] === 'string') return { [idxKey]: { 'text': '' } };
          if (typeof single['#text'] === 'string') return { [idxKey]: { '#text': '' } };
          if (typeof single['value'] === 'string') return { [idxKey]: { 'value': '' } };
        } else if (single === null || typeof single === 'string' || typeof single === 'number' || typeof single === 'boolean') {
          return { [idxKey]: '' };
        }
      }
      // Default empty container
      return {};
    }
    return '';
  }

  function siblingKeys(parentObj: Record<string, unknown>, base: string): string[] {
    const keys = Object.keys(parentObj);
    const rx = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:\\.(\\d+))?$');
    const filtered = keys.filter(k => rx.test(k));
    // sort by index where bare base is 0, then numeric ascending, else stable
    return filtered.sort((a, b) => {
      const ma = a === base ? 0 : parseInt((a.match(/\.(\d+)$/) || [,'999999'])[1], 10);
      const mb = b === base ? 0 : parseInt((b.match(/\.(\d+)$/) || [,'999999'])[1], 10);
      return ma - mb;
    });
  }

  function reorderSiblings(parentObj: Record<string, unknown>, base: string, newOrder: string[]) {
    const keys = Object.keys(parentObj);
    const setSibling = new Set(newOrder);
    const out: Record<string, unknown> = {};
    let inserted = false;
    for (const k of keys) {
      if (setSibling.has(k)) {
        if (!inserted) {
          for (const sk of newOrder) out[sk] = (parentObj as any)[sk];
          inserted = true;
        }
        // skip original sibling occurrence
      } else {
        out[k] = (parentObj as any)[k];
      }
    }
    // replace content of parentObj preserving reference
    for (const k of Object.keys(parentObj)) delete (parentObj as any)[k];
    for (const k of Object.keys(out)) (parentObj as any)[k] = out[k];
  }
}

// Preserve expand/selection state across remounts
const treeUiState = new WeakMap<HTMLElement, { expanded: Set<string>; focusedId: string | null; selectedId: string | null }>();

function mountAriaTree(container: HTMLElement, data: TreeNode, onSelect?: (id: string, path: string[]) => void, initialSelectedId?: string) {
  container.innerHTML = '';
  const prev = treeUiState.get(container);
  const expanded = prev?.expanded ? new Set(prev.expanded) : new Set<string>([data.id]);
  let focusedId: string | null = initialSelectedId ?? prev?.focusedId ?? data.id;
  let selectedId: string | null = initialSelectedId ?? prev?.selectedId ?? null;
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
      try { onSelect && onSelect(node.id, node.path); } catch { /* noop */ }
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
        try { onSelect && onSelect(node.id, node.path); } catch { /* noop */ }
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
    // Save UI state for this container so remounts can restore it
    treeUiState.set(container, { expanded, focusedId, selectedId });
    // Avoid initial focus ring, but keep focus on subsequent rerenders
    if (!firstRender) {
      // Restore focus to the newly rendered focused node
      setTimeout(() => focusRow(focusedId || data.id), 0);
    }
    firstRender = false;
  };

  rerender();

}
