'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const page = fs.readFileSync(
  path.join(__dirname, '..', '..', 'site', 'dl', 'index.html'), 'utf8'
);

describe('distribution page on a phone', () => {
  it('言語切替を潰さない', () => {
    // Reported from a phone: at 375px the toggle was compressed until 日本語
    // stacked one character per line, 81px tall for a 36px control.
    assert.match(page, /\.lang\{[^}]*flex:none/s);
    assert.match(page, /\.lang button\{[^}]*white-space:nowrap/s);
  });

  it('製品名を語の途中で折り返さない', () => {
    // "Agent for macOS" was wrapping beside the logo. On a narrow screen it
    // moves to its own line instead of being wrung out.
    assert.match(page, /\.brand span\{[^}]*white-space:nowrap/s);
    assert.match(page, /@media \(max-width:560px\)[\s\S]*\.brand\{flex-wrap:wrap/);
    assert.match(page, /@media \(max-width:560px\)[\s\S]*\.brand span\{order:3; flex-basis:100%/);
  });

  it('デスクトップ用の改行を狭い画面で使わない', () => {
    // The <br> is placed for a wide line. At 375px it left a lone particle on
    // its own line, which is the thing that looked broken.
    assert.match(page, /@media \(max-width:560px\)[\s\S]*h1 br\{display:none\}/);
  });

  it('日本語は文節で折り返す', () => {
    // Japanese has no spaces, so a line may break between any two characters
    // -- including through the middle of a katakana word. auto-phrase breaks
    // at phrase boundaries; browsers that lack it are no worse off than before.
    assert.match(page, /html\[lang="ja"\] h1[^}]*word-break:auto-phrase/s);
  });
});
