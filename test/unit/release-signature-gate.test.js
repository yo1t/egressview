'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const policyFile = path.join(root, 'release-signing', 'unsigned-releases.json');
const workflow = path.join(root, '.github', 'workflows', 'release-gate.yml');
const publisher = path.join(root, 'scripts', 'publish-signed-release.js');

const policy = JSON.parse(fs.readFileSync(policyFile, 'utf8'));

describe('release signature gate', () => {
  it('旧リリースの例外は種別と理由付きで記録されている', () => {
    // An exemption without a reason is indistinguishable from silencing a
    // failure, which is the one thing this list must not become.
    assert.ok(policy.releases.length > 0);
    for (const release of policy.releases) {
      assert.match(release.tag, /^v\d+\.\d+\.\d+$/);
      assert.match(release.kind, /^(?:unsigned|legacy-package-policy)$/);
      assert.ok(release.reason && release.reason.length > 30, `${release.tag} has no real reason`);
      assert.match(release.publishedAt, /^\d{4}-\d{2}-\d{2}$/);
      assert.match(release.recordedAt, /^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('方針の発効日以降のリリースは免除できない', () => {
    // The list exists to record what already happened. A release published
    // after the one-command publisher landed has no excuse, and adding one
    // here would turn the record into an escape hatch.
    assert.match(policy.policyEffectiveFrom, /^\d{4}-\d{2}-\d{2}$/);
    for (const release of policy.releases) {
      assert.ok(
        release.publishedAt < policy.policyEffectiveFrom,
        `${release.tag} was published on or after ${policy.policyEffectiveFrom} and cannot be exempted`
      );
    }
  });

  it('ゲートはreleaseの公開と編集の両方で走る', () => {
    // Publication alone is not enough: an asset removed or replaced afterwards
    // leaves a release that no longer verifies.
    const yaml = fs.readFileSync(workflow, 'utf8');
    assert.match(yaml, /types:\s*\[published,\s*edited\]/);
    assert.match(yaml, /schedule:/);
  });

  it('公開はdraftを経由し、配信物を検証してから公開に切り替える', () => {
    // Draft-first is what makes an unsigned release impossible rather than
    // merely unlikely: a failure anywhere leaves a draft, not a public release
    // with nothing to verify.
    const source = fs.readFileSync(publisher, 'utf8');
    const draftAt = source.indexOf("'--draft'");
    const verifyAt = source.indexOf('assertPublishedAssetsVerify(options.tag');
    const publishAt = source.indexOf("'--draft=false'");
    assert.ok(draftAt > 0 && verifyAt > 0 && publishAt > 0);
    assert.ok(draftAt < verifyAt, 'the draft must be created before it is verified');
    assert.ok(verifyAt < publishAt, 'the release must be verified before it is published');
  });

  it('イベント由来のタグをシェルへ展開しない', () => {
    // Anyone who can create a release chooses the tag name. Interpolated into
    // a run: block it would be executed; through the environment it stays a
    // value.
    const yaml = fs.readFileSync(workflow, 'utf8');
    const runBlocks = yaml.split(/^\s{6}- name:/m).filter((block) => block.includes('run: |'));
    for (const block of runBlocks) {
      const script = block.slice(block.indexOf('run: |'));
      assert.equal(
        /\$\{\{\s*(github\.event|inputs)\./.test(script), false,
        'an event value is interpolated directly into a run: script'
      );
    }
    assert.match(yaml, /RELEASE_TAG:\s*\$\{\{\s*github\.event\.release\.tag_name\s*\}\}/);
  });

  it('手動実行に検査対象を選ばせない', () => {
    // A gate whose operator picks what gets checked is not a gate. A manual run
    // sweeps the most recent releases, same as the schedule.
    const yaml = fs.readFileSync(workflow, 'utf8');
    assert.match(yaml, /workflow_dispatch:\s*$/m);
    assert.equal(/workflow_dispatch:\s*\n\s+inputs:/.test(yaml), false);
  });

  it('タグは引数として渡り、シェル語にならない', () => {
    // execFileSync with an argv array, never a shell string, so a tag
    // containing shell metacharacters is data.
    for (const file of ['scripts/verify-published-release.js', 'scripts/publish-signed-release.js']) {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      assert.equal(/\bexecSync\b/.test(source), false, `${file} uses execSync`);
      assert.equal(/shell:\s*true/.test(source), false, `${file} spawns a shell`);
    }
    const { parseArgs } = require('../../scripts/verify-published-release.js');
    assert.equal(parseArgs(['--tag', 'v1.0.0; rm -rf /']).tag, 'v1.0.0; rm -rf /');
  });

  it('タグと一致しない作業ツリーからは公開しない', () => {
    const { assertReleasableCheckout } = require('../../scripts/publish-signed-release.js');
    assert.throws(
      () => assertReleasableCheckout('v0.0.0-does-not-exist'),
      /does not exist/
    );
  });
});
