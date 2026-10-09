'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { buildSiteViewerRequestCode } = require('../../scripts/site-viewer-request');
const { REPOSITORY_FILE_REDIRECTS, rewriteRepositoryLinks } = require('../../scripts/site-repository-links');
const { preparePagesSource } = require('../../scripts/prepare-pages-source');
const { checkSiteRepositoryLinks } = require('../../scripts/check-site-repository-links');

const root = path.join(__dirname, '..', '..');

it('rejects unpublished links in rendered HTML on either host', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'site-link-check-'));
  try {
    fs.mkdirSync(path.join(temp, 'docs'));
    fs.writeFileSync(path.join(temp, 'docs/index.html'),
      '<a href="../README.md#run-the-hub">Hub</a><a href="/egressview/ROADMAP.ja.md">Plans</a>');
    assert.equal(checkSiteRepositoryLinks(temp).length, 2);
    fs.writeFileSync(path.join(temp, 'docs/index.html'),
      `<a href="${REPOSITORY_FILE_REDIRECTS['/README.md']}">Hub</a><a href="architecture.html">Docs</a>`);
    assert.deepEqual(checkSiteRepositoryLinks(temp), []);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

it('edge redirects all legacy files in one hop and leaves missing files as missing', () => {
  const context = vm.createContext({});
  const code = buildSiteViewerRequestCode('www.egressview.com');
  // CloudFront JS 2.0 supports const/let, but not for-of. Node's VM accepts
  // for-of, so execution tests alone cannot catch that deployment failure.
  assert.doesNotMatch(code, /\bfor\s*\([^)]*\bof\b/);
  vm.runInContext(code, context);
  for (const host of ['www.egressview.com', 'egressview.com']) {
    for (const [uri, target] of Object.entries(REPOSITORY_FILE_REDIRECTS)) {
      const result = context.handler({ request: {
        uri, headers: { host: { value: host } },
        querystring: { lang: { value: 'en', multiValue: [{ value: 'en' }, { value: 'ja' }] } },
      } });
      assert.equal(result.statusCode, 301);
      assert.equal(result.headers.location.value, `${target}?lang=en&lang=ja`);
    }
  }
  const request = { uri: '/missing.md', headers: { host: { value: 'www.egressview.com' } }, querystring: {} };
  for (const uri of ['/dl', '/dl/', '/dl/index.html']) {
    const result = context.handler({ request: { ...request, uri } });
    assert.equal(result.statusCode, 301);
    assert.equal(result.headers.location.value, 'https://dl.egressview.com/');
  }
  assert.equal(context.handler({ request }).uri, '/missing.md');
  assert.equal(context.handler({ request: { ...request, uri: '/docs/' } }).uri, '/docs/index.html');
  const alias = context.handler({ request: { ...request, uri: '/docs/architecture.html', headers: { host: { value: 'egressview.com' } } } });
  assert.equal(alias.headers.location.value, 'https://www.egressview.com/docs/architecture.html');
});

it('replaces unpublished repository links in the build copy, preserving fragments', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'site-links-'));
  const original = fs.readFileSync(path.join(root, 'docs/README.md'), 'utf8');
  try {
    preparePagesSource({ destination: path.join(temp, 'source') });
    const index = fs.readFileSync(path.join(temp, 'source/docs/README.md'), 'utf8');
    assert.match(index, /^---\nlayout: default\ntitle: EgressView documentation\npermalink: \/docs\/\n---\n/);
    const download = fs.readFileSync(path.join(temp, 'source/dl/index.html'), 'utf8');
    assert.match(download, /^---\nlayout: null\nsitemap: false\n/);
    assert.match(download, /rel="canonical" href="https:\/\/dl\.egressview\.com\/"/);
    assert.doesNotMatch(download, /manifest\.json/);
    assert.equal(fs.existsSync(path.join(temp, 'source/dl/sitemap.xml')), false);
    assert.equal(fs.existsSync(path.join(temp, 'source/dl/robots.txt')), false);
    for (const [uri, target] of Object.entries(REPOSITORY_FILE_REDIRECTS)) {
      if (uri.endsWith('.json')) continue;
      assert.ok(index.includes(`](${target}`), `${uri} still has a broken site link`);
      assert.doesNotMatch(index, new RegExp(`\\]\\(\\.\\.${uri.replaceAll('.', '\\.')}(?:[)#])`));
    }
    assert.ok(index.includes(`${REPOSITORY_FILE_REDIRECTS['/README.md']}#run-the-hub`));
    assert.ok(index.includes('](setup-yamaha.md)'), 'published docs links must stay local');
    for (const file of ['offline-distribution.md', 'offline-distribution.ja.md']) {
      const doc = fs.readFileSync(path.join(temp, 'source/docs', file), 'utf8');
      assert.ok(doc.includes(REPOSITORY_FILE_REDIRECTS['/release-signing/trusted-fingerprints.json']));
    }
    assert.equal(fs.readFileSync(path.join(root, 'docs/README.md'), 'utf8'), original);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

it('leaves external URLs and anchors alone and resolves nested relative paths', () => {
  const markdown = '[local](../../README.md?view=1#run-the-hub) [external](https://example.org/README.md) [anchor](#hello)';
  assert.equal(rewriteRepositoryLinks(markdown, 'docs/nested/guide.md'),
    `[local](${REPOSITORY_FILE_REDIRECTS['/README.md']}?view=1#run-the-hub) [external](https://example.org/README.md) [anchor](#hello)`);
});

it('only redirects real repository files, including both Mac guide languages', () => {
  assert.equal(Object.keys(REPOSITORY_FILE_REDIRECTS).length, 9);
  for (const uri of Object.keys(REPOSITORY_FILE_REDIRECTS)) {
    assert.ok(fs.existsSync(path.join(root, uri.slice(1))), `redirect target does not exist: ${uri}`);
  }
});
