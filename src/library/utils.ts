
// PURE utilities functions, no side effects, no dependencies
// these do not depend on browser-only APIs, so can be imported
// in both renderer AND main process.

import { Utils } from '../interfaces/utils';

const TRUE_SET = new Set(['true', 't', '1']); // , 'yes', 'y', 'on'
const FALSE_SET = new Set(['false', 'f', '0']); // , 'no', 'n', 'off'
const DECIMAL_REGEX = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const INT_REGEX = /^[+-]?\d+$/;

export const utils: Utils = {
    // ---- inline typing necessary below ----

        isRecord: function(x: any): x is Record<string, any> {
            return x && typeof x === 'object' && !Array.isArray(x);
        },

        isNull: function<T> (x: T | null | undefined): x is null {
            // Important: see the complete type guard in the interface
            // If x's type includes undefined, it remains possibly undefined in the false branch
            return x === null; // automatically means x is not undefined (so it exists)
        },

        // Aliases for clarity when checking both null and undefined together
        isNil: function<T>(x: T | null | undefined): x is null | undefined {
            return x === null || x === undefined;
        },

        notNil: function<T>(x: T | null | undefined): x is NonNullable<T> {
            // NonNullable: x is neither null nor undefined, at the same time
            return x !== null && x !== undefined;
        },

        isKeyOf: function <T extends object>(obj: T, key: PropertyKey): key is keyof T {
            return !!obj && key in obj;
        },

        isOwnKeyOf: function <T extends object>(obj: T, key: PropertyKey): key is keyof T {
            if (!obj) return false;
            return Object.prototype.hasOwnProperty.call(obj, key);
        },

        getKeyValue: function <T extends object, K extends keyof T>(obj: T, key: K): T[K] {
            return obj[key];
        },

        // Overloaded primitive type expectation helper
        expectType: (function() {
            function expectType<T extends object, K extends string>(obj: T, key: K, kind: 'string'): asserts obj is T & Record<K, string>;
            function expectType<T extends object, K extends string>(obj: T, key: K, kind: 'number'): asserts obj is T & Record<K, number>;
            function expectType<T extends object, K extends string>(obj: T, key: K, kind: 'boolean'): asserts obj is T & Record<K, boolean>;
            function expectType(obj: any, key: string, kind: 'string' | 'number' | 'boolean') {
                if (!obj || !(key in obj)) {
                    throw new Error(`Missing property "${key}"`);
                }
                const v = obj[key];
                if (typeof v !== kind || (kind === 'number' && !Number.isFinite(v))) {
                    throw new Error(`Expected "${key}" to be ${kind}, got ${typeof v}`);
                }
            }
            return expectType;
        })(),
    // ---- end of necessary inline typing ----

    // Generic typing lives in the Utils interface; we keep implementation minimal here.
    getKeys: function (obj) {
        if (!obj) {
            // never[] is assignable to Array<Extract<keyof typeof obj,string>>
            return [] as never[];
        }
        return Object.keys(obj) as Array<Extract<keyof typeof obj, string>>;
    },
    // getKeys: function(obj) {
    //     if (obj === null) return([]);
    //     return Object.keys(obj);
    // },

    isNumeric: function(x) {
        // True only for finite number primitives or boxed Number objects.
        if (typeof x === 'number') {
            return Number.isFinite(x);
        }

        // Accept boxed numbers, ex. let x = new Number(5);
        if (Object.prototype.toString.call(x) === '[object Number]') {
            try {
                const n = (x as unknown as Number).valueOf() as unknown as number;
                return Number.isFinite(n);
            } catch {
                return false;
            }
        }

        return false;
    },

    possibleNumeric: function(x) {
        // Return true only for full-string finite decimal numeric literals (optionally scientific notation)
        // Allowed examples: 42, '42', '  -3.14  ', '+1.0', '1e3', '-2.5E-2', '.5', '5.'
        // Disallowed examples: '5x', '3.2abc', '', 'Infinity', Infinity, true/false, null/undefined, '0x10', '0b1010', '0o77'

        // The global isFinite() is different from Number.isFinite();
        // it first coerces to number, for instance '42' -> 42
        // but here asNumeric() attempts this very coercion, minus the edge cases.
        return isFinite(utils.asNumeric(x));
    },

    possibleInteger: function (x) {
        // True if x is an integer-valued numeric under strict decimal/scientific parsing.
        // Accepts: 3, 3.0, '3', '3.0', '1e3', '+0', '-0', '.0'
        // Rejects: '3.5', '5x', '', 'Infinity', Infinity, NaN, booleans, null/undefined, '0x10', '0b10', '0o7'
        return Number.isInteger(utils.asNumeric(x));
    },

    asNumeric: function(x) {
        if (utils.missing(x) || utils.isNull(x)) {
            return NaN;
        }

        if (typeof x === 'number') {
            return Number.isFinite(x) ? x : NaN;
        }

        if (Object.prototype.toString.call(x) === '[object Number]') {
            // boxed numbers, ex. let x = new Number(3);
            try {
                const n = (x as unknown as Number).valueOf() as unknown as number;
                return Number.isFinite(n) ? n : NaN;
            } catch {
                return NaN;
            }
        }

        if (typeof x === 'string') {
            const s = x.trim();
            if (s.length === 0) {
                return NaN;
            }

            if (!DECIMAL_REGEX.test(s)) {
                return NaN;
            }

            const n = Number(s);
            return Number.isFinite(n) ? n : NaN;
        }

        return NaN;
    },

    asInteger: function(x) {
        if (utils.missing(x) || utils.isNull(x)) {
            return NaN;
        }

        if (typeof x === 'number') {
            return Number.isFinite(x) ? Math.trunc(x) : NaN;
        }

        if (Object.prototype.toString.call(x) === '[object Number]') {
            try {
                const n = (x as unknown as Number).valueOf() as unknown as number;
                return Number.isFinite(n) ? Math.trunc(n) : NaN;
            } catch {
                return NaN;
            }
        }

        if (typeof x === 'string') {
            const s = x.trim();
            if (s.length === 0) {
                return NaN;
            }

            // If strict integer, parse directly; else if valid decimal numeric, truncate; else NaN
            if (INT_REGEX.test(s)) {
                return Number(s);
            }

            if (DECIMAL_REGEX.test(s)) {
                const n = Number(s);
                return Number.isFinite(n) ? Math.trunc(n) : NaN;
            }

            return NaN;
        }

        return NaN;
    },

    ensureNumber: function(x, fallback) {
        return utils.possibleNumeric(x) ? utils.asNumeric(x) : fallback;
    },

    isTrue: function(x) {
        if (utils.missing(x) || utils.isNull(x)) {
            return false;
        }
        // return (x === true || (typeof x === 'string' && (x === 'true' || x === 'True')));
        if (typeof x === 'boolean') return x === true;
        if (typeof x === 'number') return x === 1;
        if (typeof x === 'string') {
            const s = x.trim().toLowerCase();
            if (TRUE_SET.has(s)) return true;
            if (FALSE_SET.has(s)) return false; // explicit false tokens remain false
        }
        return false;
    },

    isFalse: function(x) {
        if (utils.missing(x) || utils.isNull(x)) {
            return false;
        }
        // return (x === false || (typeof x === 'string' && (x === 'false' || x === 'False')));
        if (typeof x === 'boolean') return x === false;
        if (typeof x === 'number') return x === 0;
        if (typeof x === 'string') {
            const s = x.trim().toLowerCase();
            return FALSE_SET.has(s);
        }
        return false;
    },

    missing: function (x) {
        return x === void 0 || x === undefined;
    },

    exists: function (x) {
        return x !== void 0 && x !== undefined;
    },

    capitalize: function (str) {
        return str.charAt(0).toUpperCase() + str.slice(1);
    },

    isElementOf: function (x, set) {
        if (
            utils.missing(x) ||
            utils.isNull(x) ||
            utils.missing(set) ||
            utils.isNull(set) ||
            set.length === 0
        ) {
            return false;
        }

        return set.indexOf(x) >= 0;
    },

    isNotElementOf: function (x, set) {
        if (
            utils.missing(x) ||
            utils.isNull(x) ||
            utils.missing(set) ||
            utils.isNull(set) ||
            set.length === 0
        ) {
            return false;
        }

        return set.indexOf(x) < 0;
    },

    isValidColor: function(value) {
        const x = new Option().style;
        x.color = value;
        return x.color !== '';
    },

    isIdentifier: function(text) {
        // Returns true if (and only if) the string is a valid, non-reserved simple JavaScript identifier
        // under a narrow ASCII rule set (letters, digits, _, $) that does NOT start with a digit.
        // Otherwise false.

        if (typeof text !== 'string' || text.length === 0) {
            return false;
        }

        if (!/^[A-Za-z_$][\w$]*$/.test(text)) {
            return false;
        }

        // Exclude ECMAScript reserved words and literals.
        const RESERVED = new Set<string>([
            // Strict + future + contextual (conservative superset)
            'break','case','catch','class','const','continue','debugger','default','delete','do','else','enum','export','extends',
            'false','finally','for','function','if','import','in','instanceof','new','null','return','super','switch','this','throw','true','try','typeof','var','void','while','with','yield','let','static','implements','interface','package','private','protected','public','await','arguments','eval','of','from','as'
        ]);

        if (RESERVED.has(text.toLowerCase())) {
            return false;
        }

        return true;
    },

    // Measure the natural width (in CSS pixels) of a text string for a given font
    // Prefers an offscreen canvas when a DOM is available; otherwise falls back to an approximation
    textWidth: function(text, fontSize, fontFamily?) {
        const t = String(text ?? '');
        if (t.length === 0) return 0;

        const size = Number(fontSize) || 12;

        // Resolve a usable font-family string
        let family = (fontFamily && String(fontFamily).trim().length) ? String(fontFamily) : '';

        if (
            !family &&    // same thing as family === '' because '' is falsy
            typeof window !== 'undefined' &&
            typeof getComputedStyle === 'function'
        ) {
            family = getComputedStyle(document.body || document.documentElement).fontFamily || '';
        }

        // Default app font-family (Inter stack) if nothing else found
        if (!family) { // same thing as if (family === '') because '' is falsy
            family = "'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, 'Noto Sans', 'Liberation Sans', sans-serif";
        }

        // Quote family names with spaces that are not already quoted
        const familyNormalized = family
            .split(',')
            .map(s => s.trim())
            .filter(s => s.length > 0)
            .map(name => (/^['"]/ .test(name) || !/\s/.test(name)) ? name : `"${name}"`)
            .join(', ');

        // Prefer OffscreenCanvas if available (no layout required)
        const Offscreen = globalThis.OffscreenCanvas;
        if (Offscreen && typeof Offscreen === 'function') {
            const off = new Offscreen(0, 0);
            const ctx = off.getContext('2d');
            if (ctx && typeof ctx.measureText === 'function') {
                ctx.font = `${size}px ${familyNormalized}`;
                const metrics = ctx.measureText(t);
                return Math.ceil(metrics.width);
            }
        }

        // Fallback to a hidden canvas element in the DOM
        if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            if (ctx) {
                ctx.font = `${size}px ${familyNormalized}`;
                const metrics = ctx.measureText(t);
                return Math.ceil(metrics.width);
            }
        }

        // Final fallback approximation: average character width ≈ 0.6 * fontSize
        return Math.ceil(t.length * size * 0.6);
    },

    escapeForR: function(text) {
        // Normalize Windows paths and escape quotes for R
        return text.replace(/\\/g, '/').replace(/"/g, '\\"');
    }
};

