// Minimal, generic render utils interface for the template.
// Keep only broadly reusable helpers (input filtering).

export interface RenderUtils {
    setInputFilter: (textbox: HTMLInputElement | null, inputFilter: (value: string) => boolean) => void;
    setIntegers: (items: string[] | HTMLInputElement[], prefix?: string) => void;
    setSignedIntegers: (items: string[] | HTMLInputElement[], prefix?: string) => void;
    setDouble: (items: string[] | HTMLInputElement[], prefix?: string) => void;
    setSignedDouble: (items: string[] | HTMLInputElement[], prefix?: string) => void;
    addTooltip: (anchor: HTMLElement, message: string) => void;
    clearTooltip: (anchor: HTMLElement) => void;
    addHighlight: (target: HTMLElement, kind?: 'field' | 'radio') => void;
    clearHighlight: (target: HTMLElement) => void;
}
