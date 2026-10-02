'use strict';

// Writes site/index.ja.html: the product page with its Japanese in the markup.
//
// site/index.html carries both languages in one document. The English is the
// markup and the Japanese sits in `data-ja`, swapped in by a script for a
// Japanese browser. That keeps the two from drifting apart, but a search
// engine reads the markup: the Japanese text was never indexed, and the
// Japanese URL was only a redirect back to the English page. Someone searching
// in Japanese -- for アウトバウンド通信, say -- had nothing on this site to find.
//
// This turns the one document into a Japanese page. Every element with
// `data-ja` gets that text as its content, and keeps its English in `data-en`
// so the language buttons still switch back. Images take their `data-ja`
// source. The head names the page in Japanese and points at its English
// version, and the English page points back.
//
// The output is committed, so the page can be read in review, and a test
// fails when it no longer matches site/index.html. Run this after editing
// the English page:  node scripts/build-site-japanese.js

const fs = require('node:fs');
const path = require('node:path');

const SITE = 'https://www.egressview.com';
const JA_URL = `${SITE}/index.ja.html`;

const JA_HEAD = Object.freeze({
  title: 'EgressView — アウトバウンド通信を、通信先とアプリごとに見える化',
  description: 'EgressViewは、ネットワークから外へ出ていくアウトバウンド通信を見える化します。'
    + 'HubはYamaha・Ciscoルーター配下の機器ごとに、Mac・Windows Agentは送信したアプリごとに通信先を記録します。'
    + '単独でも組み合わせても使えます。通信内容は収集しません。',
  ogDescription: 'ネットワークにはHub、MacとWindowsにはAgent。アウトバウンド通信の通信先と、送信したアプリが分かります。'
    + 'パケットの中身は収集しません。',
  twitterDescription: 'ネットワークにはHub、MacとWindowsにはAgent。記録するのは接続メタデータだけで、通信内容は収集しません。',
  imageAlt: 'EgressView — アウトバウンド通信を、アプリごとに自分の機器へ記録',
});

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr',
]);

function decodeAttribute(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function encodeAttribute(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Where the element whose opening tag ends at `from` closes: the index of its
// closing tag, counting nested elements of the same name.
function findClose(html, tag, from) {
  const pattern = new RegExp(`<(/?)${tag}(?=[\\s>/])[^>]*>`, 'gi');
  pattern.lastIndex = from;
  let depth = 1;
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    depth += match[1] ? -1 : 1;
    if (depth === 0) return { start: match.index, end: pattern.lastIndex };
  }
  throw new Error(`<${tag}> opened before offset ${from} is never closed`);
}

function setAttribute(openTag, name, value) {
  const existing = new RegExp(`\\s${name}="[^"]*"`);
  const attribute = ` ${name}="${encodeAttribute(value)}"`;
  if (existing.test(openTag)) return openTag.replace(existing, attribute);
  return openTag.replace(/\s*\/?>$/, match => `${attribute}${match}`);
}

/** The body with every `data-ja` element's Japanese as its content. */
function translateBody(html) {
  const opening = /<([a-zA-Z][\w-]*)(?=\s)[^>]*?\sdata-ja="([^"]*)"[^>]*>/g;
  let out = '';
  let cursor = 0;
  let translated = 0;
  for (let match = opening.exec(html); match; match = opening.exec(html)) {
    const [openTag, rawTag, japanese] = match;
    const tag = rawTag.toLowerCase();
    out += html.slice(cursor, match.index);
    if (VOID_ELEMENTS.has(tag)) {
      // An image whose Japanese is another file.
      out += tag === 'img' ? setAttribute(openTag, 'src', decodeAttribute(japanese)) : openTag;
      cursor = opening.lastIndex;
      translated += 1;
      continue;
    }
    const openEnd = opening.lastIndex;
    const close = findClose(html, tag, openEnd);
    const english = html.slice(openEnd, close.start);
    out += setAttribute(openTag, 'data-en', english) + decodeAttribute(japanese) + html.slice(close.start, close.end);
    cursor = close.end;
    opening.lastIndex = close.end;
    translated += 1;
  }
  return { html: out + html.slice(cursor), translated };
}

function replaceOnce(html, pattern, replacement, what) {
  if (!pattern.test(html)) throw new Error(`site/index.html no longer has ${what}`);
  return html.replace(pattern, replacement);
}

function translateHead(html) {
  let out = html;
  out = replaceOnce(out, /<html lang="en">/, '<html lang="ja">', 'the <html lang="en"> tag');
  out = replaceOnce(out, /<title>[^<]*<\/title>/, `<title>${JA_HEAD.title}</title>`, 'a <title>');
  out = replaceOnce(out, /(<meta name="description" content=")[^"]*(")/,
    `$1${encodeAttribute(JA_HEAD.description)}$2`, 'a meta description');
  out = replaceOnce(out, /<link rel="canonical" href="[^"]*">/,
    `<link rel="canonical" href="${JA_URL}">`, 'a canonical link');
  out = replaceOnce(out, /(<meta property="og:url" content=")[^"]*(")/, `$1${JA_URL}$2`, 'og:url');
  out = replaceOnce(out, /(<meta property="og:title" content=")[^"]*(")/,
    `$1${encodeAttribute(JA_HEAD.title)}$2`, 'og:title');
  out = replaceOnce(out, /(<meta property="og:description" content=")[^"]*(")/,
    `$1${encodeAttribute(JA_HEAD.ogDescription)}$2`, 'og:description');
  out = replaceOnce(out, /(<meta property="og:image:alt" content=")[^"]*(")/,
    `$1${encodeAttribute(JA_HEAD.imageAlt)}$2`, 'og:image:alt');
  out = replaceOnce(out, /(<meta property="og:locale" content=")[^"]*(")/, '$1ja_JP$2', 'og:locale');
  out = replaceOnce(out, /(<meta name="twitter:title" content=")[^"]*(")/,
    `$1${encodeAttribute(JA_HEAD.title)}$2`, 'twitter:title');
  out = replaceOnce(out, /(<meta name="twitter:description" content=")[^"]*(")/,
    `$1${encodeAttribute(JA_HEAD.twitterDescription)}$2`, 'twitter:description');
  return out;
}

const GENERATED_NOTICE = '<!-- Generated from site/index.html by scripts/build-site-japanese.js.\n'
  + '     Edit the English page and its data-ja text, then run the script. -->\n';

/** The Japanese page for a given English one. */
function buildJapaneseIndex(englishHtml) {
  const body = translateBody(englishHtml);
  const html = translateHead(body.html).replace(/^<!DOCTYPE html>\n/, match => match + GENERATED_NOTICE);
  return { html, translated: body.translated };
}

if (require.main === module) {
  const root = path.join(__dirname, '..');
  const english = fs.readFileSync(path.join(root, 'site', 'index.html'), 'utf8');
  const { html, translated } = buildJapaneseIndex(english);
  fs.writeFileSync(path.join(root, 'site', 'index.ja.html'), html);
  console.log(`site/index.ja.html written: ${translated} elements in Japanese`);
}

module.exports = { buildJapaneseIndex, translateBody, JA_HEAD, JA_URL };
