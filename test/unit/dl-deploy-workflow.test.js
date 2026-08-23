'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const workflow = fs.readFileSync(
  path.join(root, '.github', 'workflows', 'dl-deploy.yml'), 'utf8'
);
const page = fs.readFileSync(path.join(root, 'site', 'dl', 'index.html'), 'utf8');

describe('distribution page deploy', () => {
  // Comments explain what the job must not do and name those things; only what
  // actually runs is under test.
  const executable = workflow
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

  it('パッケージの公開経路には触れない', () => {
    // scripts/publish-agent-release.js owns that path. A page deploy that
    // could also write a .pkg or the manifest would own the update path.
    assert.equal(
      /aws s3 [a-z]+[^\n]*\.pkg/.test(executable), false,
      'the workflow writes a package'
    );
    assert.equal(
      /aws s3 [a-z]+[^\n]*manifest\.json/.test(executable), false,
      'the workflow writes the manifest'
    );
    assert.equal(/aws s3 sync/.test(executable), false, 'sync would reconcile the whole bucket');
    assert.equal(/--recursive/.test(executable), false);
  });

  it('名前を挙げた3ファイルだけをアップロードする', () => {
    const uploaded = [...workflow.matchAll(/aws s3 cp site\/dl\/(\S+)/g)].map((m) => m[1]);
    assert.deepEqual(uploaded.sort(), ['index.html', 'robots.txt', 'sitemap.xml']);
  });

  it('invalidationを待ってから検証する', () => {
    // Verifying before the cache clears would check the old page and pass.
    const waitAt = workflow.indexOf('wait invalidation-completed');
    const verifyAt = workflow.indexOf('Verify what is actually being served');
    assert.ok(waitAt > 0 && verifyAt > waitAt);
  });

  it('ページが描く版をHTMLから読もうとしない', () => {
    // The version is drawn by script from the manifest, so it is not in the
    // served HTML. A check that grepped for it would fail every time.
    assert.match(page, /fetch\('\/macos\/manifest\.json'/);
    assert.equal(
      /grep -q "\$version"/.test(workflow), false,
      'the workflow greps the served HTML for a version it cannot contain'
    );
    // What it checks instead: the page still asks the manifest, and what the
    // manifest offers can actually be downloaded.
    assert.match(workflow, /grep -q "\/macos\/manifest\.json" served-page\.html/);
    assert.match(workflow, /packages"\]\[0\]\["url"\]/);
  });

  it('取得したものを解釈器へ流し込まない', () => {
    // Nothing fetched here is executed, but piping a download into an
    // interpreter is the shape of the pattern that would be. Files, then read.
    assert.equal(
      /curl[^\n|]*\|\s*(python3|sh|bash|node)/.test(executable), false,
      'a download is piped into an interpreter'
    );
    // Without --fail an error page is something to parse rather than a
    // failure. Only where the body is kept: the status-code checks write to
    // /dev/null on purpose and must not fail, since reading the code is the
    // whole point of them.
    const keepsBody = executable.split('\n')
      .filter((l) => /curl/.test(l) && /-o \S+/.test(l) && !/-o \/dev\/null/.test(l));
    assert.ok(keepsBody.length >= 2, 'expected the page and the manifest to be downloaded');
    for (const line of keepsBody) {
      assert.match(line, /--fail/, `curl without --fail: ${line.trim()}`);
    }
  });
});
