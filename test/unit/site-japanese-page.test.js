'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildJapaneseIndex, translateBody, JA_HEAD, JA_URL } = require('../../scripts/build-site-japanese');

const root = path.join(__dirname, '..', '..');
const english = fs.readFileSync(path.join(root, 'site', 'index.html'), 'utf8');
const japanese = fs.readFileSync(path.join(root, 'site', 'index.ja.html'), 'utf8');

describe('製品サイトの日本語ページ', () => {
  it('site/index.ja.html は、site/index.html から生成したものと一致する', () => {
    assert.equal(japanese, buildJapaneseIndex(english).html,
      'site/index.html changed; run node scripts/build-site-japanese.js');
  });

  // The point of the page: Japanese a search engine can read, under its own
  // URL, naming what people search for.
  it('日本語の本文と見出しを持ち、アウトバウンド通信という語で探せる', () => {
    assert.match(japanese, /<html lang="ja">/);
    assert.match(japanese, new RegExp(`<title>${JA_HEAD.title}</title>`));
    assert.match(JA_HEAD.title, /アウトバウンド通信/);
    assert.match(JA_HEAD.description, /アウトバウンド通信/);
    // The attribute itself holds a literal <br>, so match the element's content.
    assert.match(japanese, /">通信先も、<br>送信したアプリも見える。<\/h1>/);
    assert.match(japanese, /<p class="lede"[^>]*>ネットワークから外へ出ていく通信（アウトバウンド通信）/);
    assert.match(japanese, new RegExp(`<link rel="canonical" href="${JA_URL}">`));
    assert.match(japanese, /<meta property="og:locale" content="ja_JP">/);
  });

  it('英語と日本語のページが、互いを同じ文書の別の言語として指す', () => {
    for (const page of [english, japanese]) {
      assert.match(page, /<link rel="alternate" hreflang="en" href="https:\/\/www\.egressview\.com\/">/);
      assert.match(page, /<link rel="alternate" hreflang="ja" href="https:\/\/www\.egressview\.com\/index\.ja\.html">/);
      assert.match(page, /<link rel="alternate" hreflang="x-default" href="https:\/\/www\.egressview\.com\/">/);
    }
    assert.match(english, /<link rel="canonical" href="https:\/\/www\.egressview\.com\/">/);
  });

  it('日本語にしたすべての要素が、英語に戻すための原文を持つ', () => {
    const translatable = english.match(/\sdata-ja="/g).length;
    const { translated } = buildJapaneseIndex(english);
    assert.equal(translated, translatable, 'every data-ja element was translated');
    const withoutEnglish = japanese.match(/<(?!img)[a-z][\w-]*\s[^>]*data-ja="[^"]*"(?![^>]*data-en=)[^>]*>/g) || [];
    assert.deepEqual(withoutEnglish, []);
  });

  it('同じ名前の要素が入れ子でも、対応する閉じタグまでを置き換える', () => {
    const { html } = translateBody('<p data-ja="外">out <span>in</span> <span>x</span></p><b data-ja="次">next</b>');
    assert.equal(html, '<p data-ja="外" data-en="out &lt;span&gt;in&lt;/span&gt; &lt;span&gt;x&lt;/span&gt;">外</p>'
      + '<b data-ja="次" data-en="next">次</b>');
    const nested = translateBody('<span data-ja="a">x <span>y</span> z</span>');
    assert.equal(nested.html, '<span data-ja="a" data-en="x &lt;span&gt;y&lt;/span&gt; z">a</span>');
  });

  it('日本語のページは、英語のブラウザで開いても日本語のままでいる', () => {
    // The crawler this page exists for reads with an English browser. Without
    // the page's own language as the default, the script turned it English.
    assert.match(english, /initial = pageLang === 'ja' \|\| \(navigator\.language/);
    assert.match(english, /if \(initial !== pageLang\) apply\(initial\);/);
  });
});
