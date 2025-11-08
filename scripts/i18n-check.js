#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const localesDir = path.resolve(__dirname, '../src/i18n/locales');
const baseLang = 'en';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function flatten(obj, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flatten(v, key));
    else out[key] = String(v);
  }
  return out;
}

function main() {
  if (!fs.existsSync(localesDir)) {
    console.error(`[i18n-check] Missing locales dir: ${localesDir}`);
    process.exit(1);
  }
  const files = fs.readdirSync(localesDir).filter(f => f.endsWith('.json'));
  if (!files.includes(`${baseLang}.json`)) {
    console.error(`[i18n-check] Missing base language file: ${baseLang}.json`);
    process.exit(1);
  }
  const base = flatten(readJson(path.join(localesDir, `${baseLang}.json`)));
  const baseKeys = new Set(Object.keys(base));

  let missingTotal = 0;
  let extraTotal = 0;

  files.filter(f => f !== `${baseLang}.json`).forEach(file => {
    const lang = path.basename(file, '.json');
    const data = flatten(readJson(path.join(localesDir, file)));
    const keys = new Set(Object.keys(data));
    const missing = [...baseKeys].filter(k => !keys.has(k));
    const extra = [...keys].filter(k => !baseKeys.has(k));
    if (missing.length || extra.length) {
      console.log(`\n[${lang}]`);
      if (missing.length) {
        missingTotal += missing.length;
        console.log(`  Missing (${missing.length}):`);
        missing.forEach(k => console.log(`   - ${k}`));
      }
      if (extra.length) {
        extraTotal += extra.length;
        console.log(`  Extra (${extra.length}):`);
        extra.forEach(k => console.log(`   - ${k}`));
      }
    }
  });

  if (missingTotal) {
    console.error(`\n[i18n-check] Found ${missingTotal} missing key(s) across locales.`);
    process.exit(1);
  }
  console.log('[i18n-check] All locales are in sync with base.');
}

main();

