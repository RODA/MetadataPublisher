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
let FULL_PATH_RENDERING = false;
let DEBUG_LABELS = false;
let AVOID_DATA_DSCR = true;

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
  pathIdx: number[];
  children?: TreeNode[];
};

type NormNode = {
  name: string;
  value?: string | null;
  attributes?: Record<string, string> | null;
  children?: NormNode[];
};

type ElementsIndex = { [k: string]: string } | undefined;
type LabelMode = 'name' | 'title' | 'both';
type RawElements = { [k: string]: any } | undefined;

function normalizeName(name: string): string {
  const noNs = name.includes(':') ? (name.split(':').pop() || name) : name;
  return noNs.replace(/\.\d+$/u, '');
}

function normToTree(
  node: NormNode,
  elements: ElementsIndex,
  mode: LabelMode,
  idPrefix = 'root',
  pathIdx: number[] = [],
): TreeNode {
  const name = node.name || 'node';
  const title = elements?.[normalizeName(name)];
  const label = mode === 'name' ? name : mode === 'title' ? (title || name) : (title ? `${name}: ${title}` : name);
  const kids = Array.isArray(node.children) ? node.children : [];
  if (!kids.length) return { id: idPrefix, label, pathIdx };
  const children = kids.map((child, idx) => normToTree(child, elements, mode, `${idPrefix}.${idx}`, pathIdx.concat([idx])));
  return { id: idPrefix, label, pathIdx, children };
}

function initTree() {
  const container = document.querySelector('.tree-area') as HTMLElement | null;
  if (!container) return;
  const metaArea = document.querySelector('.metadata-area') as HTMLElement | null;
  const metaContent = document.querySelector('.meta-content') as HTMLElement | null;
  const dropTarget = metaArea;
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

  function resolveNormPath(root: NormNode, path: number[]): { parent: NormNode | null; index: number; node: NormNode; namePath: string[] } | null {
    let parent: NormNode | null = null;
    let cur: NormNode = root;
    const names: string[] = [cur.name || 'root'];
    if (!path.length) return { parent: null, index: -1, node: cur, namePath: names };
    for (let i = 0; i < path.length; i++) {
      parent = cur;
      const arr = Array.isArray(parent.children) ? parent.children : [];
      const idx = path[i];
      if (idx < 0 || idx >= arr.length) return null;
      cur = arr[idx];
      names.push(cur.name || `#${idx}`);
    }
    return { parent, index: path[path.length - 1], node: cur, namePath: names };
  }

  const idToPath = (id: string | null): number[] => {
    if (!id) return [];
    const parts = id.split('.').slice(1);
    const out: number[] = [];
    for (const p of parts) {
      const n = parseInt(p, 10);
      if (!Number.isNaN(n)) out.push(n);
    }
    return out;
  };

  const buildIdFromPath = (path: number[]): string => (path.length ? `root.${path.join('.')}` : 'root');

  function siblingOrder(parent: any, base: string): number[] {
    if (!parent || !Array.isArray(parent.children)) return [];
    const out: number[] = [];
    for (let i = 0; i < parent.children.length; i++) {
      if (normalizeName(String(parent.children[i]?.name)) === normalizeName(base)) out.push(i);
    }
    return out;
  }

  function swapChildren(parent: any, a: number, b: number) {
    if (!parent || !parent.children) return;
    const tmp = parent.children[a]; parent.children[a] = parent.children[b]; parent.children[b] = tmp;
  }

  function createNormElement(base: string): any {
    const elMeta = (state.rawElements as any)?.[base] ?? (state.rawElements as any)?.[normalizeName(base)];
    const hasChildren = (() => {
      if (!elMeta || typeof elMeta !== 'object') return false;
      const c = (elMeta as any).children ?? (elMeta as any).subelements ?? (elMeta as any).elements;
      if (!c) return false;
      if (Array.isArray(c)) return c.length > 0;
      if (typeof c === 'object') return Object.keys(c).length > 0;
      return Boolean(c);
    })();
    return hasChildren ? { name: base, children: [] } : { name: base, value: '' };
  }

  const state = {
    mode: 'both' as LabelMode,
    elements: undefined as ElementsIndex,
    rawElements: undefined as RawElements,
    lastPayload: null as JsonValue | null,
    treeRoot: null as NormNode | null,
    selectedId: 'root',
    selectedPath: [] as number[],
  };

  const isDataDscrName = (name?: string | null): boolean => {
    if (!name) return false;
    return normalizeName(String(name)).toLowerCase() === 'datadscr';
  };

  const handleTreeSelect = (nodeId: string, pathIdx?: number[]) => {
    const targetPath = pathIdx && pathIdx.length ? [...pathIdx] : idToPath(nodeId);
    state.selectedId = nodeId;
    state.selectedPath = targetPath;
    renderMetadata();
  };

  let metadataRenderFrame: number | null = null;
  let metadataCoverActive = false;

  const cancelPendingMetadataRender = () => {
    if (metadataRenderFrame !== null) {
      window.cancelAnimationFrame(metadataRenderFrame);
      metadataRenderFrame = null;
    }
  };

  const ensureMetadataCover = () => {
    if (!metadataCoverActive) {
      metadataCoverActive = true;
      cover.addCover(i18n.t('page.main.rendering'));
    }
  };

  const releaseMetadataCover = () => {
    if (metadataCoverActive) {
      metadataCoverActive = false;
      cover.removeCover();
    }
  };

  const parseUriList = (raw: string | undefined): string | null => {
    if (!raw) return null;
    const lines = raw.split(/[\r\n]+/).map((line) => line.trim()).filter(Boolean);
    const first = lines.find((line) => /^file:\/\//i.test(line));
    if (!first) return null;
    try {
      const uri = new URL(first);
      if (process.platform === 'win32') {
        const pathname = uri.pathname?.replace(/^\//, '') ?? '';
        return decodeURI(pathname.replace(/\//g, path.sep));
      }
      return decodeURI(uri.pathname);
    } catch {
      return null;
    }
  };

  const sendFileToMain = async (file: File) => {
    try {
      const buffer = Buffer.from(await file.arrayBuffer());
      await ipcRenderer.invoke('load-dropped-file', file.name, buffer);
    } catch (error) {
      console.error('[Drop] failed to send file to main', error);
    }
  };

  const dispatchFileLoad = async (files: FileList | null | undefined, event?: DragEvent) => {
    // console.log('[Drop] dispatchFileLoad called', files);
    if (!files || files.length === 0) {
      // try to infer from URI list if possible
      const uriList = event?.dataTransfer?.getData('text/uri-list') || event?.dataTransfer?.getData('text/plain');
      const fallbackPath = parseUriList(uriList);
      // console.log('[Drop] fallback uriList', uriList, 'parsed', fallbackPath);
      if (fallbackPath) {
        coms.sendTo('main', 'loadFile', fallbackPath);
        return;
      }
      return;
    }
    const file = files[0];
    const filePath = (file as File & { path?: string }).path;
    // console.log('[Drop] file keys', Object.keys(file), 'has path', 'path' in file);
    // console.log('[Drop] path descriptor', Object.getOwnPropertyDescriptor(file, 'path'));
    // console.log('[Drop] file from drop', filePath);
    if (typeof filePath === 'string' && filePath) {
      coms.sendTo('main', 'loadFile', filePath);
      return;
    }
    await sendFileToMain(file);
  };

  let dragDepth = 0;
  const setDragHighlight = (active: boolean) => {
    if (!dropTarget) return;
    if (active && !dropTarget.classList.contains('is-dragover')) {
      dropTarget.classList.add('is-dragover');
    } else if (!active && dropTarget.classList.contains('is-dragover')) {
      dropTarget.classList.remove('is-dragover');
    }
  };

  if (dropTarget) {

      dropTarget.addEventListener('dragover', (event) => {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      });

      dropTarget.addEventListener('dragenter', (event) => {
        dragDepth += 1;
        setDragHighlight(true);
        event.preventDefault();
      });

      dropTarget.addEventListener('dragleave', (event) => {
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) setDragHighlight(false);
        event.preventDefault();
      });
      dropTarget.addEventListener('drop', (event) => {
        event.preventDefault();
        event.stopPropagation();
        dragDepth = 0;
        setDragHighlight(false);
        void dispatchFileLoad(event.dataTransfer?.files ?? null, event);
      });
  }

  window.addEventListener('dragover', (event) => {
    event.preventDefault();
  });

      window.addEventListener('drop', (event) => {
        event.preventDefault();
        dragDepth = 0;
        setDragHighlight(false);
        console.log('[Drop] window drop', event.target, event.dataTransfer);
        console.log('[Drop] drop types', event.dataTransfer?.types);
    void dispatchFileLoad(event.dataTransfer?.files ?? null, event);
      });

  const render = (rootJson: unknown) => {
    if (!rootJson) return;
    state.lastPayload = rootJson as JsonValue;
    let treeRoot: NormNode | null = null;
    // Now the payload can be either the root codebook node itself or legacy wrapped
    if (state.lastPayload && typeof state.lastPayload === 'object') {
      const obj = state.lastPayload as any;
      treeRoot = (obj.codeBook || obj.Codebook || obj) as NormNode;
    }
    if (DEBUG_LABELS) {
      try {
        console.log('[Labels] render() payload keys:', typeof state.lastPayload === 'object' && state.lastPayload ? Object.keys(state.lastPayload as any) : '(not object)');
      } catch {}
    }
    if (!treeRoot) {
      if (metaArea) metaArea.classList.remove('has-metadata');
      return;
    }
    if (metaArea) metaArea.classList.add('has-metadata');
    state.treeRoot = treeRoot;
    state.selectedId = 'root';
    state.selectedPath = [];
    if (DEBUG_LABELS) {
      try {
        console.log('[Labels] render() mode=', state.mode, 'titles.size=', state.elements ? Object.keys(state.elements).length : 0, 'root=', treeRoot?.name);
      } catch {}
    }
    const treeData = normToTree(treeRoot, state.elements, state.mode, 'root', []);
    treeUiState.delete(container);
    mountAriaTree(container, treeData, handleTreeSelect, state.selectedId);
    renderMetadata();
  };

  // 1) Try immediate fetch
  // Fetch initial label mode from main
  ipcRenderer.invoke('get-tree-label-mode').then((mode) => {
    if (mode === 'name' || mode === 'title' || mode === 'both') state.mode = mode;
  }).catch(() => {});

  // 1) Try immediate fetch of the last loaded codebook
  ipcRenderer.invoke('get-xmlcodebook').then((book) => { if (book) { if (DEBUG_LABELS) console.log('[Labels] got xmlcodebook'); render(book); } else { if (DEBUG_LABELS) console.log('[Labels] no xmlcodebook'); } }).catch((e) => { if (DEBUG_LABELS) console.log('[Labels] get-xmlcodebook error', e); });

  // Fetch DDI elements map used for labeling
  const applyElements = (elements: unknown) => {
    if (DEBUG_LABELS) console.log('[Labels] elements type=', typeof elements);
    if (!elements || typeof elements !== 'object') return;
    const titles: { [k: string]: string } = {};
    const rawFlat: { [k: string]: any } = {};

    const getChildren = (obj: any): any[] => {
      const c = obj?.children ?? obj?.Children ?? obj?.subelements ?? obj?.Subelements ?? obj?.subElements ?? obj?.elements ?? obj?.Elements;
      if (!c) return [];
      if (Array.isArray(c)) return c;
      if (typeof c === 'object') return Object.entries(c).map(([k, v]) => ({ __name: k, ...((typeof v === 'object') ? v as any : { title: String(v) }) }));
      return [];
    };

    const visitEntry = (name: string, meta: any) => {
      const key = normalizeName(name);
      if (meta && typeof meta === 'object') {
        const t = meta.title ?? meta.Title ?? meta.label ?? meta.Label;
        if (typeof t === 'string') titles[key] = String(t);
        rawFlat[key] = meta;
        const kids = getChildren(meta);
        for (const child of kids) {
          const childName = (child && typeof child === 'object' && '__name' in child) ? (child as any).__name : (child?.name || child?.Name || '');
          if (childName) visitEntry(String(childName), child);
        }
      } else if (typeof meta === 'string') {
        titles[key] = meta;
      }
    };

    for (const [k, v] of Object.entries(elements as Record<string, unknown>)) visitEntry(String(k), v);

    state.elements = titles;
    state.rawElements = rawFlat as RawElements;
    if (DEBUG_LABELS) {
      const sampleKeys = Object.keys(titles).slice(0, 12);
      console.log('[Labels] titles count=', Object.keys(titles).length, 'sample=', sampleKeys.map(k => `${k}=${titles[k]}`));
    }
    if (state.treeRoot) {
      // Re-render tree labels with new elements map
      const treeData = normToTree(state.treeRoot, state.elements, state.mode, 'root', []);
      mountAriaTree(container, treeData, handleTreeSelect, state.selectedId);
      renderMetadata();
    }
  };
  if (DEBUG_LABELS) console.log('[Labels] fetching DDI elements...');
  ipcRenderer.invoke('get-ddi-elements').then((elements) => applyElements(elements)).catch(() => {});
  // Also react to a broadcast once main finishes boot and computes elements
  coms.on('ddi-elements', (elements: unknown) => applyElements(elements));

  // 2) Also listen for a later broadcast
  coms.on('xmlcodebook', (book: unknown) => render(book));

  // React to Tree Label Mode changes from Settings menu
  coms.on('treeLabelModeChanged', (mode: unknown) => {
    const m = String(mode);
    if (m === 'name' || m === 'title' || m === 'both') {
      if (DEBUG_LABELS) console.log('[Labels] treeLabelModeChanged ->', m);
      state.mode = m;
      if (state.lastPayload) render(state.lastPayload);
    }
  });

  function renderMetadataImpl() {
    if (!metaArea || !metaContent || !controlsSlot) return;
    if (!state.treeRoot || !state.selectedId) return;

    const keyPath = state.selectedPath.length ? [...state.selectedPath] : idToPath(state.selectedId);
    const normRoot = state.treeRoot;
    if (!normRoot) return;
    const resolved = resolveNormPath(normRoot, keyPath);
    if (!resolved) return;
    const { parent, index, node, namePath } = resolved;
    if (!node) return;
    if (AVOID_DATA_DSCR && isDataDscrName(node.name)) return;

    metaContent.innerHTML = '';
    controlsSlot.innerHTML = '';

    if (normRoot) {
      // Helper: build display label based on current mode (name/title/both)
      const makeLabel = (n: string): string => {
        const title = state.elements?.[normalizeName(n)];
        if (state.mode === 'name') return n;
        if (state.mode === 'title') return title || n;
        return title ? `${n}: ${title}` : n;
      };

      // Helper: display-friendly attribute name mapping
      const displayAttr = (k: string): string => (k === 'xmlang' ? 'xml:lang' : k);

      // Title
      const title = document.createElement('h1');
      const displayPath = namePath.length > 1 ? namePath.slice(1) : namePath;
      const own = displayPath[displayPath.length - 1] || '';
      title.textContent = FULL_PATH_RENDERING
        ? displayPath.map(makeLabel).join(' / ')
        : makeLabel(own);
      title.style.margin = '12px';
      metaContent.appendChild(title);

      const controls = document.createElement('div');
      controls.style.margin = '0 12px 12px 12px';

      const isLeaf = !node.children || node.children.length === 0;
      const hasValue = node.value !== undefined && node.value !== null;

      // Leaf value editor
      if (isLeaf && hasValue) {
        // grid row: label | control
        const grid = document.createElement('div');
        grid.className = 'form-grid';

        const label = document.createElement('div');
        label.textContent = 'Value';
        label.className = 'form-label';
        grid.appendChild(label);

        const rawValue = node.value === null || node.value === undefined ? '' : String(node.value);

        // Trim leading/trailing whitespace
        const currentStr = rawValue.replace(/^\s+/, '').replace(/\s+$/, '');

        const needsTextarea = currentStr.length > 60 || /\r|\n/.test(currentStr);
        const input = document.createElement(needsTextarea ? 'textarea' : 'input');
        if (input instanceof HTMLTextAreaElement) {
          input.rows = 7;
        } else {
          (input as HTMLInputElement).type = 'text';
        }
        (input as HTMLInputElement | HTMLTextAreaElement).className = 'form-control';
        (input as HTMLInputElement | HTMLTextAreaElement).value = currentStr;
        const apply = () => {
          const newVal = (input as HTMLInputElement | HTMLTextAreaElement).value;
          node.value = newVal.replace(/^\s+/, '').replace(/\s+$/, '');
        };
        input.addEventListener('change', apply);
        input.addEventListener('blur', apply);
        grid.appendChild(input);
        controls.appendChild(grid);
      } else if (isLeaf) {
        const info = document.createElement('div');
        info.textContent = 'This element has no text value.';
        controls.appendChild(info);
      } else {
        // Parent node selected; details for descendants will be rendered below.
      }

      // Attributes editor for the selected node
      if (node.attributes && typeof node.attributes === 'object') {
        const attrsTitle = document.createElement('div');
        attrsTitle.textContent = 'Attributes';
        attrsTitle.className = 'meta-subtitle';
        controls.appendChild(attrsTitle);
        const table = document.createElement('div');
        table.className = 'form-grid';
        for (const [ak, av] of Object.entries(node.attributes)) {
          const lab = document.createElement('div');
          lab.textContent = displayAttr(String(ak));
          lab.className = 'form-label';
          const inp = document.createElement('input'); (inp as HTMLInputElement).type = 'text';
          (inp as HTMLInputElement).className = 'form-control';
          (inp as HTMLInputElement).value = av === null || av === undefined ? '' : String(av);
          (inp as HTMLInputElement).addEventListener('change', () => { (node.attributes as any)[ak] = (inp as HTMLInputElement).value; });
          table.appendChild(lab); table.appendChild(inp);
        }
        controls.appendChild(table);
      }

      const baseName = normalizeName(String(node.name || ''));
      const repeatable = isRepeatable(baseName);
      const addBtn = document.createElement('button');
      addBtn.title = 'Add sibling';
      addBtn.textContent = '+';
      addBtn.disabled = !repeatable;
      addBtn.addEventListener('click', () => {
        if (!repeatable || !parent) return;
        parent.children = Array.isArray(parent.children) ? parent.children : [];
        const insertAt = typeof index === 'number' ? index + 1 : parent.children.length;
        parent.children.splice(insertAt, 0, createNormElement(baseName));
        console.log('[Tree] add sibling', {
          parentName: parent.name,
          baseName,
          insertAt,
          children: parent.children?.map((child, idx) => ({ idx, name: child.name, value: child.value })) ?? [],
        });
        const treeData = normToTree(state.treeRoot as NormNode, state.elements, state.mode, 'root', []);
        const newSelectedPath = keyPath.slice(0, -1).concat([insertAt]);
        const newSelectedId = buildIdFromPath(newSelectedPath);
        state.selectedPath = newSelectedPath;
        state.selectedId = newSelectedId;
        mountAriaTree(container!, treeData, handleTreeSelect, newSelectedId);
        renderMetadata();
      });
      controlsSlot.appendChild(addBtn);

      const delBtn = document.createElement('button');
      delBtn.title = 'Delete sibling';
      delBtn.textContent = '−';
      delBtn.addEventListener('click', () => {
        if (!parent || typeof index !== 'number') return;
        parent.children?.splice(index, 1);
        const treeData = normToTree(state.treeRoot as NormNode, state.elements, state.mode, 'root', []);
        const childCount = parent.children?.length ?? 0;
        let nextPath: number[];
        if (childCount === 0) {
          nextPath = keyPath.slice(0, -1);
        } else {
          const nextIdx = Math.min(index, childCount - 1);
          nextPath = keyPath.slice(0, -1).concat([nextIdx]);
        }
        state.selectedPath = nextPath;
        state.selectedId = buildIdFromPath(nextPath);
        mountAriaTree(container!, treeData, handleTreeSelect, state.selectedId);
        renderMetadata();
      });
      controlsSlot.appendChild(delBtn);

      const upBtn = document.createElement('button');
      upBtn.title = 'Move up';
      upBtn.textContent = '↑';
      const dnBtn = document.createElement('button');
      dnBtn.title = 'Move down';
      dnBtn.textContent = '↓';
      const order = siblingOrder(parent, baseName);
      const idxNow = order.indexOf(typeof index === 'number' ? index : -1);
      upBtn.disabled = !repeatable || idxNow <= 0;
      dnBtn.disabled = !repeatable || idxNow === -1 || idxNow >= order.length - 1;
      upBtn.addEventListener('click', () => {
        const order = siblingOrder(parent, baseName); const i = order.indexOf(index);
        if (i > 0) { const a = order[i - 1], b = order[i]; swapChildren(parent, a, b);
          const treeData = normToTree(state.treeRoot as NormNode, state.elements, state.mode, 'root', []);
          const p = keyPath.slice(0, -1).concat([a]); state.selectedPath = p; state.selectedId = buildIdFromPath(p);
          mountAriaTree(container!, treeData, handleTreeSelect, state.selectedId); renderMetadata(); }
      });
      dnBtn.addEventListener('click', () => {
        const order = siblingOrder(parent, baseName); const i = order.indexOf(index);
        if (i !== -1 && i < order.length - 1) { const a = order[i], b = order[i + 1]; swapChildren(parent, a, b);
          const treeData = normToTree(state.treeRoot as NormNode, state.elements, state.mode, 'root', []);
          const p = keyPath.slice(0, -1).concat([b]); state.selectedPath = p; state.selectedId = buildIdFromPath(p);
          mountAriaTree(container!, treeData, handleTreeSelect, state.selectedId); renderMetadata(); }
      });
      controlsSlot.appendChild(upBtn); controlsSlot.appendChild(dnBtn);

      metaContent.appendChild(controls);

      // If the selected node is a parent, render a readable editor for all descendants
      if (node.children && node.children.length) {

        const subtreeContainer = document.createElement('div');
        subtreeContainer.style.margin = '0 12px 24px 12px';
        metaContent.appendChild(subtreeContainer);

        const renderAttributes = (n: NormNode, parentEl: HTMLElement) => {
          if (!n.attributes || typeof n.attributes !== 'object') return;
          const attrsTitle = document.createElement('div');
          attrsTitle.textContent = 'Attributes';
          attrsTitle.className = 'meta-subtitle';
          parentEl.appendChild(attrsTitle);
          const grid = document.createElement('div');
          grid.className = 'form-grid';
          for (const [ak, av] of Object.entries(n.attributes)) {
            const lab = document.createElement('div');
            lab.textContent = displayAttr(String(ak));
            lab.className = 'form-label';
            const inp = document.createElement('input');
            (inp as HTMLInputElement).type = 'text';
            (inp as HTMLInputElement).className = 'form-control';
            (inp as HTMLInputElement).value = av === null || av === undefined ? '' : String(av);
            (inp as HTMLInputElement).addEventListener('change', () => { (n.attributes as any)[ak] = (inp as HTMLInputElement).value; });
            grid.appendChild(lab); grid.appendChild(inp);
          }
          parentEl.appendChild(grid);
        };

        const renderValue = (n: NormNode, parentEl: HTMLElement) => {
          const rawValue = n.value === null || n.value === undefined ? '' : String(n.value);
          const currentStr = rawValue.replace(/^\s+/, '').replace(/\s+$/, '');
          const needsTextarea = currentStr.length > 60 || /\r|\n/.test(currentStr);
          const grid = document.createElement('div'); grid.className = 'form-grid';
          const lab = document.createElement('div'); lab.className = 'form-label'; lab.textContent = 'Value';
          const input = document.createElement(needsTextarea ? 'textarea' : 'input');
          if (input instanceof HTMLTextAreaElement) input.rows = 7; else (input as HTMLInputElement).type = 'text';
          (input as HTMLInputElement | HTMLTextAreaElement).className = 'form-control';
          (input as HTMLInputElement | HTMLTextAreaElement).value = currentStr;
          const apply = () => {
            const newVal = (input as HTMLInputElement | HTMLTextAreaElement).value;
            n.value = newVal.replace(/^\s+/, '').replace(/\s+$/, '');
          };
          input.addEventListener('change', apply); input.addEventListener('blur', apply);
          grid.appendChild(lab); grid.appendChild(input);
          parentEl.appendChild(grid);
        };

        const renderDeep = (n: NormNode, pathNames: string[], level: number) => {
          if (AVOID_DATA_DSCR && isDataDscrName(n.name)) return;
          const section = document.createElement('section');
          const hTag = `h${Math.min(level, 6)}` as keyof HTMLElementTagNameMap;
          const heading = document.createElement(hTag);

          // const labelPath = pathNames.map(makeLabel).join(' / ');
          // heading.textContent = labelPath;
          // heading.style.margin = '18px 0 8px 0';
          // section.appendChild(heading);

          // Only leaves show their full path; intermediates show only their own label
          const isLeafNode = !n.children || n.children.length === 0;
          const fullPath = pathNames.map(makeLabel).join(' / ');
          const ownLabel = makeLabel(pathNames[pathNames.length - 1]);
          heading.textContent = FULL_PATH_RENDERING ? fullPath : ownLabel;
          heading.style.margin = '18px 0 8px 0';
          section.appendChild(heading);

          // Append parent section first so order is parent -> children
          subtreeContainer.appendChild(section);

          // If this node has a value, show it
          if (typeof n.value !== 'undefined' && n.value !== null) renderValue(n, section);
          // Show attributes (if any)
          renderAttributes(n, section);

          // Recurse into children (pre-order traversal)
          if (n.children && n.children.length) {
            for (const child of n.children) {
              renderDeep(child, pathNames.concat([child.name]), level + 1);
            }
          }
        };

        for (const child of node.children) {
          if (AVOID_DATA_DSCR && isDataDscrName(child.name)) continue;
          renderDeep(child, [child.name], 2);
        }
        const bottomSpacer = document.createElement('div');
        bottomSpacer.className = 'metadata-end-spacer';
        metaContent.appendChild(bottomSpacer);
      }

      return; // handled normalized path
    }
    // Legacy path fallback removed; normalized path handled above
  }

  function renderMetadata() {
    if (!metaArea || !metaContent || !controlsSlot) {
      cancelPendingMetadataRender();
      releaseMetadataCover();
      return;
    }
    if (!state.treeRoot || !state.selectedId) {
      cancelPendingMetadataRender();
      releaseMetadataCover();
      return;
    }

    cancelPendingMetadataRender();
    ensureMetadataCover();
    metadataRenderFrame = window.requestAnimationFrame(() => {
      metadataRenderFrame = null;
      try {
        renderMetadataImpl();
      } finally {
        releaseMetadataCover();
      }
    });
  }

  // Legacy key-path resolver removed; normalized model uses resolveNormPath

  function isRepeatable(base: string, _ignore?: Record<string, unknown>): boolean {
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
    return false;
  }

  // Legacy sibling helpers removed; normalized model uses siblingOrder/swapChildren + createNormElement

  // Legacy sibling helpers removed; normalized model uses siblingOrder/swapChildren
}

// Preserve expand/selection state across remounts
const treeUiState = new WeakMap<HTMLElement, { expanded: Set<string>; focusedId: string | null; selectedId: string | null }>();

function mountAriaTree(container: HTMLElement, data: TreeNode, onSelect?: (id: string, path: number[]) => void, initialSelectedId?: string) {
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
    // 1) Clicking the disclosure arrow only expands/collapses, no metadata change
    disclosure.addEventListener('click', (e) => {
      e.stopPropagation();
      if (hasChildren) { toggle(node.id); rerender(); }
    });

    // 2) Clicking the label selects the node and updates metadata, without toggling
    label.addEventListener('click', (e) => {
      e.stopPropagation();
      focusedId = node.id;
      selectedId = node.id;
      rerender();
      try { onSelect && onSelect(node.id, node.pathIdx); } catch { /* noop */ }
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
        try { onSelect && onSelect(node.id, node.pathIdx); } catch { /* noop */ }
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
