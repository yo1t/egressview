'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const policyFile = path.join(root, 'release-signing', 'withdrawn-agent-releases.json');
const publisher = path.join(root, 'scripts', 'publish-agent-release.js');

const policy = JSON.parse(fs.readFileSync(policyFile, 'utf8'));

describe('withdrawn agent releases', () => {
  it('取り下げた版は理由と後継を伴って記録されている', () => {
    // A withdrawal with no reason cannot be judged, and one with no
    // successor cannot be acted on: "do not use this" is only half an
    // instruction if there is nothing to move to.
    assert.ok(policy.releases.length > 0);
    for (const release of policy.releases) {
      assert.match(release.platform, /^(?:windows|macos)$/);
      assert.match(release.version, /^\d+\.\d+\.\d+$/);
      assert.match(release.kind, /^(?:published-and-withdrawn|ambiguous-build)$/);
      assert.ok(release.reason && release.reason.length > 60, `${release.version} has no real reason`);
      assert.match(release.supersededBy, /^\d+\.\d+\.\d+$/);
      assert.match(release.recordedAt, /^\d{4}-\d{2}-\d{2}$/);
      if (release.publishedAt !== null) assert.match(release.publishedAt, /^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('後継は取り下げた版より新しい', () => {
    // Pointing at something older, or at itself, sends a reader back to the
    // defect they are being moved away from.
    const order = (value) => value.split('.').map(Number);
    for (const release of policy.releases) {
      const from = order(release.version);
      const to = order(release.supersededBy);
      assert.ok(
        to[0] > from[0] || (to[0] === from[0] && (to[1] > from[1] || (to[1] === from[1] && to[2] > from[2]))),
        `${release.version} is superseded by ${release.supersededBy}, which is not newer`
      );
    }
  });

  it('後継そのものが取り下げられていない', () => {
    // A chain of withdrawals that ends in another withdrawal leaves the
    // reader with nowhere to go, and the list would still look complete.
    const withdrawn = new Set(policy.releases.map((r) => `${r.platform} ${r.version}`));
    for (const release of policy.releases) {
      assert.ok(
        !withdrawn.has(`${release.platform} ${release.supersededBy}`),
        `${release.version} points at ${release.supersededBy}, which is itself withdrawn`
      );
    }
  });

  it('公開スクリプトが取り下げた版を実際に拒否する', () => {
    // Run it, do not read it. The first version of this test grepped the
    // source for the message and passed with the call replaced by null --
    // every string it looked for was still there. A gate that is only
    // mentioned is not a gate.
    const withdrawn = policy.releases[0];
    const result = spawnSync(process.execPath, [
      publisher,
      '--platform', withdrawn.platform,
      '--version', withdrawn.version,
      // Any existing file: the run must fail on the withdrawal, and it must
      // do so before anything is uploaded, so --dry-run is enough.
      '--package', `x64=${policyFile}`,
      '--dry-run',
    ], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, 'publishing a withdrawn version succeeded');
    assert.match(
      `${result.stdout}${result.stderr}`,
      new RegExp(`${withdrawn.platform} ${withdrawn.version.replace(/\./g, '\.')} is withdrawn`)
    );
  });

  it('取り下げていない版は通る', () => {
    // The refusal has to be about the list, not about refusing everything.
    const result = spawnSync(process.execPath, [
      publisher, '--platform', 'windows', '--version', '99.99.99',
      '--package', `x64=${policyFile}`, '--dry-run',
    ], { encoding: 'utf8' });
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /is withdrawn/);
  });
});
