import { utils } from '../library/utils';
import type { InputFilters } from '../interfaces/inputfilters';

export const inputfilters: InputFilters = {
  setInputFilter(textbox, inputFilter) {
    if (!textbox) return;
    const state = { oldValue: '', oldSelectionStart: 0, oldSelectionEnd: 0 };
    [
      'input', 'keydown', 'keyup', 'mousedown', 'mouseup', 'select', 'contextmenu', 'drop', 'focusout'
    ].forEach((event) => {
      textbox.addEventListener(event, function () {
        if (inputFilter(textbox.value)) {
          state.oldValue = textbox.value;
          state.oldSelectionStart = textbox.selectionStart ?? 0;
          state.oldSelectionEnd = textbox.selectionEnd ?? 0;
        } else if (state.oldValue !== undefined) {
          textbox.value = state.oldValue;
          if (!(utils.isNull(state.oldSelectionStart) || utils.isNull(state.oldSelectionEnd))) {
            textbox.setSelectionRange(state.oldSelectionStart, state.oldSelectionEnd);
          }
        } else {
          textbox.value = '';
        }
      });
    });
  },

  setIntegers(items, prefix = 'el') {
    items.forEach((item) => {
      let element: HTMLInputElement | null = null;
      if (item instanceof HTMLInputElement) element = item; else element = document.getElementById(prefix + item) as HTMLInputElement | null;
      if (!element) return;
      inputfilters.setInputFilter(element, (value: string): boolean => {
        let v = String(value || '');
        if (v === '') return true;
        if (!/^\d+$/.test(v)) return false;
        if (v.length > 1 && v.startsWith('0')) {
          const stripped = v.replace(/^0+/, '');
          element!.value = stripped === '' ? '0' : stripped;
        }
        return true;
      });
    });
  },

  setSignedIntegers(items, prefix = 'el') {
    items.forEach((item) => {
      let element: HTMLInputElement | null = null;
      if (item instanceof HTMLInputElement) element = item; else element = document.getElementById(prefix + item) as HTMLInputElement | null;
      if (!element) return;
      inputfilters.setInputFilter(element, (value: string): boolean => {
        let v = String(value || '');
        if (v === '') return true;
        if (!/^[+-]?\d+$/.test(v)) return false;
        if (/^[+-]0+$/.test(v)) {
          element!.value = '0';
        }
        return true;
      });
    });
  },

  setDouble(items, prefix = 'el') {
    items.forEach((item) => {
      let element: HTMLInputElement | null = null;
      if (item instanceof HTMLInputElement) element = item; else element = document.getElementById(prefix + item) as HTMLInputElement | null;
      if (!element) return;
      inputfilters.setInputFilter(element, (value: string): boolean => {
        const v = String(value || '');
        if (v === '') return true;
        return /^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(v);
      });
    });
  },

  setSignedDouble(items, prefix = 'el') {
    items.forEach((item) => {
      let element: HTMLInputElement | null = null;
      if (item instanceof HTMLInputElement) element = item; else element = document.getElementById(prefix + item) as HTMLInputElement | null;
      if (!element) return;
      inputfilters.setInputFilter(element, (value: string): boolean => {
        const v = String(value || '');
        if (v === '') return true;
        return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(v);
      });
    });
  },
};

export default inputfilters;
