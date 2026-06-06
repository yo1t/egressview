// Unit tests for i18n completeness
// Verifies all translation keys exist in both ja and en locales
// Run: node --test test/unit/i18n.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');

// Extract I18N object from the HTML
function extractI18nKeys(locale) {
  // Match the locale block: "ja: {" ... "}" or "en: {" ... "}"
  const re = new RegExp(`\\b${locale}:\\s*\\{([^}]+(?:\\{[^}]*\\}[^}]*)*)\\}`, 'g');
  const keys = new Set();
  // Simpler approach: find all 'key.name': patterns within the locale block
  const localeStart = html.indexOf(`  ${locale}: {`);
  if (localeStart === -1) return keys;
  const localeEnd = html.indexOf('\n  },', localeStart);
  const block = html.substring(localeStart, localeEnd);
  const keyRe = /'([a-z][a-z0-9._]+)'\s*:/g;
  let m;
  while ((m = keyRe.exec(block)) !== null) {
    keys.add(m[1]);
  }
  return keys;
}

// Extract all keys used in t('key') calls
function extractUsedKeys() {
  const keys = new Set();
  const re = /\bt\('([a-z][a-z0-9._]+)'\)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    keys.add(m[1]);
  }
  return keys;
}

// Extract all data-i18n="key" attributes
function extractDataI18nKeys() {
  const keys = new Set();
  const re = /data-i18n="([a-z][a-z0-9._]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    keys.add(m[1]);
  }
  // data-i18n-html
  const re2 = /data-i18n-html="([a-z][a-z0-9._]+)"/g;
  while ((m = re2.exec(html)) !== null) {
    keys.add(m[1]);
  }
  // data-i18n-placeholder
  const re3 = /data-i18n-placeholder="([a-z][a-z0-9._]+)"/g;
  while ((m = re3.exec(html)) !== null) {
    keys.add(m[1]);
  }
  return keys;
}

describe('i18n completeness', () => {
  const jaKeys = extractI18nKeys('ja');
  const enKeys = extractI18nKeys('en');
  const usedKeys = extractUsedKeys();
  const dataKeys = extractDataI18nKeys();
  const allUsed = new Set([...usedKeys, ...dataKeys]);

  it('ja locale has keys defined', () => {
    assert(jaKeys.size > 50, `Expected >50 ja keys, got ${jaKeys.size}`);
  });

  it('en locale has keys defined', () => {
    assert(enKeys.size > 50, `Expected >50 en keys, got ${enKeys.size}`);
  });

  it('all ja keys exist in en', () => {
    const missing = [...jaKeys].filter(k => !enKeys.has(k));
    assert.equal(missing.length, 0, `Keys in ja but not en:\n  ${missing.join('\n  ')}`);
  });

  it('all en keys exist in ja', () => {
    const missing = [...enKeys].filter(k => !jaKeys.has(k));
    assert.equal(missing.length, 0, `Keys in en but not ja:\n  ${missing.join('\n  ')}`);
  });

  it('all t() calls have corresponding ja key', () => {
    const missing = [...usedKeys].filter(k => !jaKeys.has(k));
    assert.equal(missing.length, 0, `t() keys not in ja:\n  ${missing.join('\n  ')}`);
  });

  it('all t() calls have corresponding en key', () => {
    const missing = [...usedKeys].filter(k => !enKeys.has(k));
    assert.equal(missing.length, 0, `t() keys not in en:\n  ${missing.join('\n  ')}`);
  });

  it('all data-i18n attributes have corresponding ja key', () => {
    const missing = [...dataKeys].filter(k => !jaKeys.has(k));
    assert.equal(missing.length, 0, `data-i18n keys not in ja:\n  ${missing.join('\n  ')}`);
  });

  it('all data-i18n attributes have corresponding en key', () => {
    const missing = [...dataKeys].filter(k => !enKeys.has(k));
    assert.equal(missing.length, 0, `data-i18n keys not in en:\n  ${missing.join('\n  ')}`);
  });
});
