'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const page = fs.readFileSync(
  path.join(__dirname, '..', '..', 'site', 'index.html'), 'utf8'
);

describe('product site on a phone', () => {
  it('日本語は文節で折り返す', () => {
    // Japanese has no spaces, so a line may break between any two characters
    // -- including through the middle of a katakana word. Reported from a
    // phone: メタデータ was split across two lines. word-break inherits, so
    // setting it on body reaches the spans and divs the copy actually lives
    // in; browsers that lack the value are no worse off than before.
    assert.match(page, /html\[lang="ja"\] body\{[^}]*word-break:auto-phrase/s);
    assert.match(page, /html\[lang="ja"\] body\{[^}]*line-break:strict/s);
  });

  it('見出しの2行を狭い画面でも2行のまま保つ', () => {
    // Each clause of the Japanese heading is written as one line. Shrinking
    // the type keeps it that way at 320px, where the longest clause is 12
    // characters -- the alternative was a third line with one character on it.
    assert.match(page, /@media \(max-width:560px\)[\s\S]*html\[lang="ja"\] h1\{font-size:min\(1\.6rem,7vw\)\}/);
    assert.doesNotMatch(page, /h1 br\{display:none\}/);
  });

  it('セクションの上下余白が実際に効いている', () => {
    // Every section also carries .wrap, and .wrap sets padding on all four
    // sides -- so a bare `section` selector lost and the vertical padding
    // never applied, leaving the dividing line hard against the text.
    assert.match(page, /section\.wrap\{padding:64px 24px\}/);
    assert.doesNotMatch(page, /^\s*section\{padding:/m);
    assert.match(page, /@media \(max-width:560px\)[\s\S]*section\.wrap\{padding:44px 24px\}/);
  });
});
