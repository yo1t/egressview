'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const clientRuntime = fs.readFileSync(path.join(root, 'public', 'js', 'i18n.js'), 'utf8');
const serverRuntime = fs.readFileSync(path.join(root, 'src', 'i18n-server.js'), 'utf8');
const catalog = require('../../src/data/i18n.json');

function listJsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return listJsFiles(file);
    return entry.isFile() && entry.name.endsWith('.js') ? [file] : [];
  });
}

function extractStaticCallKeys() {
  const files = [path.join(root, 'server.js'), ...listJsFiles(path.join(root, 'src')), ...listJsFiles(path.join(root, 'public', 'js'))];
  const keys = new Set();
  const re = /\b(?:t|tVars)\(\s*['"]([a-z][a-z0-9._-]+)['"]\s*(?=[,)])/g;
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    let match;
    while ((match = re.exec(source)) !== null) keys.add(match[1]);
  }
  return keys;
}

function extractDataAttributeKeys() {
  const keys = new Set();
  const re = /data-i18n(?:-html|-placeholder|-title)?="([a-z][a-z0-9._-]+)"/g;
  let match;
  while ((match = re.exec(html)) !== null) keys.add(match[1]);
  return keys;
}

describe('shared i18n catalog', () => {
  const jaKeys = new Set(Object.keys(catalog.ja));
  const enKeys = new Set(Object.keys(catalog.en));

  it('is the single source used by both runtimes', () => {
    assert.match(serverRuntime, /require\('\.\/data\/i18n\.json'\)/);
    assert.match(clientRuntime, /import I18N from '\.\/i18n-data\.js\?v=__ASSET_VERSION__'/);
    assert.doesNotMatch(serverRuntime, /const\s+STRINGS\s*=\s*\{/);
    assert.doesNotMatch(clientRuntime, /const\s+I18N\s*=\s*\{/);
  });

  it('contains the complete migrated catalog in both languages', () => {
    assert.equal(jaKeys.size, 883);
    assert.equal(enKeys.size, 883);
    assert.deepEqual([...jaKeys].sort(), [...enKeys].sort());
  });

  it('contains only non-empty string values', () => {
    for (const lang of ['ja', 'en']) {
      const invalid = Object.entries(catalog[lang]).filter(([, value]) => typeof value !== 'string' || value.length === 0);
      assert.deepEqual(invalid, [], `${lang} has invalid translation values`);
    }
  });

  it('contains no HTML markup and uses no HTML translation targets', () => {
    for (const lang of ['ja', 'en']) {
      const markupValues = Object.entries(catalog[lang])
        .filter(([, value]) => /<\/?[a-z][^>]*>/i.test(value))
        .map(([key]) => key);
      assert.deepEqual(markupValues, [], `${lang} contains HTML translations`);
    }
    assert.doesNotMatch(html, /data-i18n-html=/);
    assert.doesNotMatch(clientRuntime, /\.innerHTML\s*=/);
  });

  it('defines every statically referenced t() and tVars() key', () => {
    const used = extractStaticCallKeys();
    const missing = [...used].filter(key => !jaKeys.has(key) || !enKeys.has(key));
    assert.deepEqual(missing, [], `Missing static translation keys:\n${missing.join('\n')}`);
  });

  it('defines every data-i18n attribute key', () => {
    const used = extractDataAttributeKeys();
    const missing = [...used].filter(key => !jaKeys.has(key) || !enKeys.has(key));
    assert.deepEqual(missing, [], `Missing data-i18n keys:\n${missing.join('\n')}`);
  });

  it('server lookup switches languages, interpolates variables, and falls back safely', () => {
    const i18n = require('../../src/i18n-server');
    i18n.setLanguage('en');
    assert.equal(i18n.t('auth.rate-limited', { n: 12 }), 'Too many attempts. Retry in 12 seconds.');
    assert.equal(i18n.t('missing.test.key'), 'missing.test.key');
    i18n.setLanguage('ja');
    assert.equal(i18n.getLang(), 'ja');
  });
});

describe('i18n markup coverage', () => {
  it('all option elements with Japanese text have data-i18n', () => {
    const optionRe = /<option[^>]*>([^<]+)<\/option>/g;
    const problems = [];
    let match;
    while ((match = optionRe.exec(html)) !== null) {
      const fullTag = match[0];
      const text = match[1].trim();
      if (fullTag.includes('s-home-country') || fullTag.includes('s-language')) continue;
      if (/^[\u{1F1E0}-\u{1F1FF}]/u.test(text)) continue;
      if (/[\u3000-\u9FFF\uF900-\uFAFF]/.test(text) && !fullTag.includes('data-i18n')) problems.push(text.slice(0, 40));
    }
    assert.deepEqual([...new Set(problems)], []);
  });

  it('visible labeled elements with Japanese text have data-i18n', () => {
    const tagRe = /<(?:label|button|span|div)[^>]*class="[^"]*(?:form-label|pane-title|log-title)[^"]*"[^>]*>([^<]+)</g;
    const problems = [];
    let match;
    while ((match = tagRe.exec(html)) !== null) {
      const text = match[1].trim();
      if (/[\u3000-\u9FFF\uF900-\uFAFF]/.test(text) && !match[0].includes('data-i18n')) problems.push(text.slice(0, 40));
    }
    assert.deepEqual([...new Set(problems)], []);
  });
});
