import * as fs from 'fs';
import * as path from 'path';
import type { I18N, Dictionary } from '../interfaces/i18n';

let currentLocale = 'en';
let dictionaries: Record<string, Dictionary> = {};

function localesDir(fromDir: string) {
  // dist/main.js lives in dist; preload lives in dist/preload.
  // Keep locales under src/locales and load via relative path from dist.
  // Try ../../src/locales first (preload), then ../src/locales (main).
  const candidates = [
    // When running from dist/preload/* → ../../src/i18n/locales
    path.resolve(fromDir, '../../src/i18n/locales'),
    // When running from dist/* → ../src/i18n/locales
    path.resolve(fromDir, '../src/i18n/locales'),
    // When packaged and locales copied next to dist files
    path.resolve(fromDir, 'locales'),
    // When packaged via electron-builder extraResources
    (typeof process !== 'undefined' && (process as any).resourcesPath)
      ? path.resolve((process as any).resourcesPath, 'i18n/locales')
      : '',
    (typeof process !== 'undefined' && (process as any).resourcesPath)
      ? path.resolve((process as any).resourcesPath, 'locales')
      : '',
  ];
  for (const p of candidates) {
    try {
      const stat = fs.statSync(p);
      if (stat.isDirectory()) return p;
    } catch {}
  }
  // Fallback to cwd/src/locales
  return path.resolve(process.cwd(), 'src/i18n/locales');
}

function loadDict(lang: string, baseDir: string): Dictionary {
  if (dictionaries[lang]) return dictionaries[lang];
  const file = path.join(baseDir, `${lang}.json`);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const json = JSON.parse(raw) as Dictionary;
    dictionaries[lang] = json;
    return json;
  } catch {
    dictionaries[lang] = {};
    return {};
  }
}

function flatGet(dict: Dictionary, key: string): string | undefined {
  // Support simple dotted keys by direct lookup of full key
  return dict[key];
}

export const i18n: I18N = {
  init: function (lang, fromDir = __dirname) {
    const base = localesDir(fromDir);
    currentLocale = lang || currentLocale;
    loadDict('en', base); // ensure fallback
    loadDict(currentLocale, base);
  },

  setLocale: function (lang, fromDir = __dirname) {
    currentLocale = lang;
    const base = localesDir(fromDir);
    loadDict(lang, base);
  },

  getLocale: function () {
    return currentLocale;
  },

  availableLocales: function (fromDir = __dirname) {
    const dir = localesDir(fromDir);
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => path.basename(f, '.json'))
        .sort();
    } catch {
      return ['en'];
    }
  },

  t: function (key, vars, fromDir = __dirname) {
    const dir = localesDir(fromDir);
    const primary = loadDict(currentLocale, dir);
    const fallback = loadDict('en', dir);
    let phrase = flatGet(primary, key) ?? flatGet(fallback, key) ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        phrase = phrase.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
      }
    }
    return phrase;
  },

  translateDocument: function (root, fromDir = __dirname) {
    const dir = localesDir(fromDir);
    loadDict(currentLocale, dir);
    loadDict('en', dir);
    const nodes = root.querySelectorAll('[data-i18n]');
    nodes.forEach((el) => {
      const key = el.getAttribute('data-i18n');
      if (!key) return;
      const text = i18n.t(key, undefined, fromDir);
      if (text && el.textContent !== undefined) el.textContent = text;
    });
    const attrNodes = root.querySelectorAll('[data-i18n-attr]');
    attrNodes.forEach((el) => {
      const mapping = el.getAttribute('data-i18n-attr');
      if (!mapping) return;
      // format: attr:key;attr2:key2
      mapping.split(';').forEach((pair) => {
        const [attr, key] = pair.split(':');
        if (attr && key) {
          const val = i18n.t(key, undefined, fromDir);
      (el as Element).setAttribute(attr, val);
        }
      });
    });
  },
};

export default i18n;
