'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const pagesConfig = path.join(root, 'site', '_config.yml');
const wwwConfig = path.join(root, 'site', '_config.www.yml');
const workflow = path.join(root, '.github', 'workflows', 'site-deploy.yml');

function value(file, key) {
  const match = fs.readFileSync(file, 'utf8')
    .match(new RegExp(`^${key}:\\s*"?([^"\\n]*)"?\\s*$`, 'm'));
  return match ? match[1] : null;
}

describe('product site Jekyll configuration', () => {
  it('wwwはbaseurlを持たない', () => {
    // One Jekyll source serves two hosts. The Pages copy lives under a path
    // and needs a baseurl; www does not, and inheriting one makes every
    // generated docs link a 404 here.
    assert.equal(value(wwwConfig, 'baseurl'), '');
    assert.equal(value(pagesConfig, 'baseurl'), '/egressview');
  });

  it('wwwのcanonicalは自分自身を指す', () => {
    // Pointing canonical at the other copy tells search engines this site is
    // the duplicate of it.
    assert.equal(value(wwwConfig, 'url'), 'https://www.egressview.com');
    assert.equal(value(pagesConfig, 'url'), 'https://yo1t.github.io');
  });

  it('デプロイがwww用の設定を適用する', () => {
    // A config that exists but is never copied over changes nothing.
    const yaml = fs.readFileSync(workflow, 'utf8');
    assert.match(yaml, /cp site\/_config\.www\.yml \.pages-source\/_config\.yml/);
    const applyAt = yaml.indexOf('_config.www.yml');
    const buildAt = yaml.indexOf('jekyll-build-pages');
    assert.ok(applyAt > 0 && buildAt > 0 && applyAt < buildAt, 'the config must be applied before the build');
  });

  it('他ホストのパスとcanonicalが混ざったら公開前に落ちる', () => {
    const yaml = fs.readFileSync(workflow, 'utf8');
    assert.match(yaml, /href="\/egressview\//);
    assert.match(yaml, /rel="canonical" href="https:\/\/yo1t\.github\.io/);
    const checkAt = yaml.indexOf('Check the links belong to this site');
    const uploadAt = yaml.indexOf('Upload the site');
    assert.ok(checkAt > 0 && uploadAt > 0 && checkAt < uploadAt, 'the check must run before the upload');
  });

  it('sitemapは手書きせずjekyll-sitemapに生成させる', () => {
    // The hand-written file listed two URLs while the site served more than
    // forty, so every documentation page was invisible to search engines. A
    // file that has to be edited whenever a page is added will go stale again.
    assert.equal(
      fs.existsSync(path.join(root, 'site', 'sitemap.xml')), false,
      'a hand-written sitemap overrides the generated one'
    );
    for (const config of [wwwConfig, pagesConfig]) {
      assert.match(fs.readFileSync(config, 'utf8'), /jekyll-sitemap/);
    }
  });

  it('索引しないページはsitemapから外す', () => {
    // A redirect, an error page and a verification token are not content.
    for (const page of ['index.ja.html', '404.html', 'google87ed3f363a004a20.html']) {
      const file = path.join(root, 'site', page);
      if (!fs.existsSync(file)) continue;
      assert.match(fs.readFileSync(file, 'utf8').slice(0, 400), /^---[\s\S]*sitemap: false/,
        `${page} is not excluded from the sitemap`);
    }
  });

  it('配布ホストは自分のsitemapを持つ', () => {
    // A sitemap entry on another host is ignored unless ownership of both is
    // verified, so dl cannot rely on the product site listing it.
    const sitemap = fs.readFileSync(path.join(root, 'site', 'dl', 'sitemap.xml'), 'utf8');
    assert.match(sitemap, /<loc>https:\/\/dl\.egressview\.com\/<\/loc>/);
    const robots = fs.readFileSync(path.join(root, 'site', 'dl', 'robots.txt'), 'utf8');
    assert.match(robots, /Sitemap: https:\/\/dl\.egressview\.com\/sitemap\.xml/);
  });

  it('sitemapの中身を公開前に検査する', () => {
    const yaml = fs.readFileSync(workflow, 'utf8');
    const checkAt = yaml.indexOf('Check the sitemap lists this site');
    const uploadAt = yaml.indexOf('Upload the site');
    assert.ok(checkAt > 0 && checkAt < uploadAt, 'the sitemap check must run before the upload');
    assert.match(yaml, /count.*-ge 20/);
  });

  it('両方の言語のページを公開対象として確認する', () => {
    const yaml = fs.readFileSync(workflow, 'utf8');
    assert.match(yaml, /docs\/agent-privacy\.html/);
    assert.match(yaml, /docs\/agent-privacy\.ja\.html/);
  });
});
