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
    // Grew by 7 on 2026-08-29: the threat-feed status strings (P3-54).
    // Grew by 2 on 2026-09-05: non-JSON backup API response diagnostics.
    // Grew by 5 on 2026-09-05: the log screen that revoked agents moved to (P3-56).
    // Grew by 1 on 2026-09-05: fail-closed backup cleanup safety feedback.
    // Grew by 1 on 2026-09-05: degraded-retention cleanup confirmation.
    // Grew by 1 on 2026-09-05: degraded-retention no-candidate guidance.
    // Grew by 5 on 2026-09-07: how long a source has been offline (P3-55).
    // Grew by 2 on 2026-09-19: the connection log's new-rows badge (P3-141).
    // Grew by 9 on 2026-09-21: discrete timeline modes, basis badges and tooltip labels (P3-159).
    // Grew by 2 on 2026-09-22: the timeline's "no record" band and its legend (P3-157).
    // Grew by 10 on 2026-10-14: LAN-scan detection setting and notification log (P3-191).
    // Grew by 2 on 2026-10-15: LAN probing seen by an Agent (P3-191).
    // Grew by 6 on 2026-11-02: an Agent quiet while a router sees its computer (P3-103).
    // Grew by 16 on 2026-11-14: candidates an Agent's user chose to share (P3-194).
    // Grew by 9 on 2026-11-15: the Agent tab those candidates moved to.
    // Grew by 15 on 2026-11-15: the Agent tab's overview and Agent picker.
    // Grew by 7 on 2026-11-15: Agent tab redesign (last-seen ages, Agents without candidates).
    // Grew by 11 on 2026-11-15: LAN scans aimed at each Agent's computer (P3-191).
    // Grew by 1 on 2026-11-15: the Agent tab's explanation folds away on a phone.
    // Grew by 13 on 2026-11-15: apps by sent bytes per Agent (P3-194).
    // Grew by 18 on 2026-11-15: what the Hub knows of each Agent's computer.
    // Grew by 16 on 2026-11-15: how much of the time each Agent's reports arrived.
    // Grew by 6 on 2026-11-15: the Agent tab says what period its numbers cover.
    // Grew by 4 on 2026-11-21: how much each Agent sent to the Hub.
    // Grew by 7 on 2026-11-22: answering an Agent's candidates on the Hub (P3-194 stage 2).
    // Grew by 3 on 2026-11-22: what an Agent says of its computer in the device list (P3-199).
    // Grew by 3 on 2026-11-22: the IPv6 count under the address and each address's kind (its own column went).
    // Grew by 3 on 2026-11-23: saying why a device has no IPv6 address (P3-200).
    assert.equal(jaKeys.size, 1097);
    assert.equal(enKeys.size, 1097);
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
