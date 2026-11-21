'use strict';

// The product pages are read on phones. A grid column with a fixed minimum
// wider than a 320 px screen's content box (272 px on these pages) pushed the
// download page 34 px off the screen, and the home page's comparison table
// went 145 px over (2026-11-21). These checks keep both causes out.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const PAGES = ['site/index.html', 'site/index.ja.html', 'site/products.html', 'site/dl/index.html'];

describe('製品サイトがスマホの幅に収まる', () => {
  for (const page of PAGES) {
    it(`${page} の自動の列に、画面より広い最小幅が無い`, () => {
      const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
      const fixed = [...html.matchAll(/repeat\(auto-fit,\s*minmax\(\s*\d+px\s*,/g)].map((m) => m[0]);
      assert.deepEqual(fixed, [], `minmax(min(Npx,100%),1fr) にする: ${fixed.join(' ')}`);
    });
  }

  for (const page of ['site/index.html', 'site/index.ja.html']) {
    it(`${page} の比較の表は、ホスト名と日本語の語句で折り返せる`, () => {
      const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
      assert.match(html, /table\.cmp code\{overflow-wrap:anywhere\}/);
      const phone = html.slice(html.indexOf('@media (max-width:560px){'));
      assert.match(phone.slice(0, phone.indexOf('\n  }')), /table\.cmp\{word-break:normal\}/);
    });
  }
});
