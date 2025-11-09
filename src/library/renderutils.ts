// import { utils } from '../library/utils';
import type { RenderUtils } from '../interfaces/renderutils';
import { inputfilters } from './inputfilters';
import { tooltip } from './tooltip';

export const renderutils: RenderUtils = {
  setInputFilter(textbox, inputFilter) {
    inputfilters.setInputFilter(textbox, inputFilter);
  },

  setIntegers(items, prefix = 'el') {
    inputfilters.setIntegers(items, prefix);
  },

  setSignedIntegers(items, prefix = 'el') {
    inputfilters.setSignedIntegers(items, prefix);
  },

  setDouble(items, prefix = 'el') {
    inputfilters.setDouble(items, prefix);
  },

  setSignedDouble(items, prefix = 'el') {
    inputfilters.setSignedDouble(items, prefix);
  },

  // Tooltip + highlight helpers (delegating to errortooltip.ts)
  addTooltip(anchor, message) {
    tooltip.addTooltip(anchor, message);
  },

  clearTooltip(anchor) {
    tooltip.clearTooltip(anchor);
  },

  addHighlight(target, kind = 'field') {
    tooltip.addHighlight(target, kind);
  },

  clearHighlight(target) {
    tooltip.clearHighlight(target);
  },
};
