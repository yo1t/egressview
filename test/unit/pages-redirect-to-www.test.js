'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { redirectPagesToWww, targetFor } = require('../../scripts/pages-redirect-to-www');

function site(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-redirect-'));
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), content);
  }
  return root;
}

describe('GitHub Pages のコピーを www へ向ける', () => {
  it('各ページを www の同じ場所へ向ける', () => {
    assert.equal(targetFor('index.html'), 'https://www.egressview.com/');
    assert.equal(targetFor('docs/architecture.html'), 'https://www.egressview.com/docs/architecture.html');
    assert.equal(targetFor('docs/architecture.ja.html'), 'https://www.egressview.com/docs/architecture.ja.html');
    assert.equal(targetFor('dl/index.html'), 'https://www.egressview.com/dl/');
    assert.equal(targetFor('404.html'), 'https://www.egressview.com/');
  });

  it('HTML を置き換え、canonical と即時の移動で www を指す', () => {
    const root = site({
      'index.html': '<html>top</html>',
      'docs/architecture.html': '<link rel="canonical" href="https://yo1t.github.io/egressview/docs/architecture.html">',
      'assets/css/style.css': 'body{}',
      'sitemap.xml': '<urlset><loc>https://yo1t.github.io/egressview/</loc></urlset>',
      'google87ed3f363a004a20.html': 'google-site-verification: google87ed3f363a004a20.html',
    });
    const replaced = redirectPagesToWww(root);
    assert.deepEqual(replaced.sort(), ['docs/architecture.html', 'index.html']);

    const page = fs.readFileSync(path.join(root, 'docs/architecture.html'), 'utf8');
    assert.match(page, /<link rel="canonical" href="https:\/\/www\.egressview\.com\/docs\/architecture\.html">/);
    assert.match(page, /<meta http-equiv="refresh" content="0; url=https:\/\/www\.egressview\.com\/docs\/architecture\.html">/);
    assert.doesNotMatch(page, /yo1t\.github\.io/, 'github.io を正規として名乗らない');

    assert.equal(fs.readFileSync(path.join(root, 'assets/css/style.css'), 'utf8'), 'body{}', 'HTML 以外は触らない');
    assert.equal(fs.existsSync(path.join(root, 'sitemap.xml')), false, 'github.io の URL を並べた sitemap は消す');
    assert.match(fs.readFileSync(path.join(root, 'google87ed3f363a004a20.html'), 'utf8'), /google-site-verification/,
      '所有権確認のファイルは残す');
  });
});
