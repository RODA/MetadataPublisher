export interface Tooltip {
  addTooltip: (anchor: HTMLElement, message: string) => void;
  clearTooltip: (anchor: HTMLElement) => void;
  addHighlight: (target: HTMLElement, kind?: 'field' | 'radio') => void;
  clearHighlight: (target: HTMLElement) => void;
}

