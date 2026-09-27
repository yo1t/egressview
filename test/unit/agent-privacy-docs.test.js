'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

describe('Agent privacy documentation', () => {
  it('names optional third-party destinations in both macOS languages', () => {
    for (const file of ['docs/agent-privacy.md', 'docs/agent-privacy.ja.md']) {
      const source = read(file);
      for (const host of ['download.maxmind.com', 'ipwho.is', 'api.openai.com', 'api.anthropic.com']) {
        assert(source.includes(host), `${file} must disclose ${host}`);
      }
    }
  });

  it('does not describe optional lookups or cloud AI as impossible', () => {
    const page = read('site/dl/index.html');
    assert.match(page, /ipwho\.is/);
    assert.match(page, /cloud AI/);
    assert.match(page, /クラウドAI/);
    assert.doesNotMatch(page, /nothing is sent anywhere/i);

    const macEn = read('apps/agent-macos/README.md');
    const macJa = read('apps/agent-macos/README.ja.md');
    assert.doesNotMatch(macEn, /never decrypts traffic|Not destination host names/);
    assert.doesNotMatch(macJa, /復号せず|宛先ホスト名は含みません/);
    assert.match(macEn, /QUIC Initial/);
    assert.match(macJa, /QUIC Initial/);
  });

  it('distinguishes location IP disclosure from cloud AI context on Windows', () => {
    for (const file of ['docs/agent-privacy-windows.md', 'docs/agent-privacy-windows.ja.md']) {
      const source = read(file);
      assert(source.includes('ipwho.is'));
      assert(source.includes('api.openai.com'));
      assert(source.includes('api.anthropic.com'));
    }
    assert.doesNotMatch(read('docs/agent-privacy-windows.md'), /No other row does/);
    assert.doesNotMatch(read('docs/agent-privacy-windows.ja.md'), /他のどの行も送りません/);
  });
});
