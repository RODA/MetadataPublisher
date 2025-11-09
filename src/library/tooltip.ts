import tippy from 'tippy.js';
import type { Tooltip } from '../interfaces/tooltip';

// Minimal, generic error tooltip/highlight helpers suitable for any app.
// Expose a single facade object per project conventions.

const tips = new Map<HTMLElement, any>();

export const tooltip: Tooltip = {
    addTooltip(anchor, message) {
        const text = String(message ?? '');
        if (!anchor || !text) return;
        let tip = tips.get(anchor);
        if (!tip) {
            tip = tippy(anchor, {
                theme: 'light-red',
                placement: 'top-start',
                content: text,
                arrow: false,
                allowHTML: true,
                appendTo: () => document.body,
                offset: [0, 8],
                zIndex: 9999,
                interactive: false
            });
            tips.set(anchor, tip);
        } else {
            tip[0]?.setContent(text);
        }
    },

    clearTooltip(anchor) {
        const tip = tips.get(anchor);
        if (tip) {
            try { tip[0]?.destroy(); } catch { /* noop */ }
            tips.delete(anchor);
        }
    },

    addHighlight(target, kind = 'field') {
        if (!target) return;
        target.classList.add(kind === 'radio' ? 'error-in-radio' : 'error-in-field');
    },

    clearHighlight(target) {
        if (!target) return;
        target.classList.remove('error-in-radio', 'error-in-field');
    },
};

export default tooltip;
