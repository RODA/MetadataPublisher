
export type Dictionary = Record<string, string>;

export interface I18N {
  init: (lang: string, fromDir?: string) => void;
  setLocale: (lang: string, fromDir?: string) => void;
  getLocale: () => string;
  availableLocales: (fromDir?: string) => string[];
  t: (key: string, vars?: Record<string, string>, fromDir?: string) => string;
  translateDocument: (root: Document, fromDir?: string) => void;
}
