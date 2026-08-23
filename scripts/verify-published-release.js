#!/usr/bin/env node
'use strict';

/**
 * Check that a published release actually carries something to verify.
 *
 * This is the gate behind `scripts/publish-signed-release.js`, not a
 * replacement for it. The script makes an unsigned release hard to create; this
 * catches one created another way -- from the GitHub UI, or by hand -- and
 * catches assets that were removed or replaced after publication.
 *
 * It needs neither AWS access nor a checkout of the release: it downloads what
 * the release page serves and verifies that, which is what a downloader sees.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { fingerprintPublicKey } = require('./release-key-fingerprint');

const ROOT = path.join(__dirname, '..');
const REGISTRY = path.join(ROOT, 'release-signing', 'trusted-fingerprints.json');
// Releases that predate the one-command publisher and were never signed. They
// are recorded so this gate reports a known fact instead of failing for ever,
// which is how a gate teaches people to ignore it.
const KNOWN_UNSIGNED = path.join(ROOT, 'release-signing', 'unsigned-releases.json');
const DNS_ANCHOR = '_egressview-release.egressview.com';
// Agent releases carry a notarised .pkg signed by Apple, which is a real and
// independently checkable signature. They are not offline source bundles and
// this gate does not apply to them.
const AGENT_TAG = /^agent-v/;

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: ROOT, encoding: 'utf8', stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
  });
}

function parseArgs(argv) {
  const options = { limit: 1 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--tag') options.tag = argv[++i];
    else if (flag === '--repo') options.repo = argv[++i];
    else if (flag === '--limit') options.limit = Number(argv[++i]);
    else throw new Error(`Unknown option: ${flag}`);
  }
  options.repo = options.repo || 'yo1t/egressview';
  if (!Number.isInteger(options.limit) || options.limit < 1) {
    throw new Error('--limit must be a positive whole number of releases');
  }
  return options;
}

function knownUnsigned() {
  const policy = JSON.parse(fs.readFileSync(KNOWN_UNSIGNED, 'utf8'));
  return new Map(policy.releases.map((release) => [release.tag, release]));
}

function releasesToCheck(options) {
  if (options.tag) return [options.tag];
  // Agent releases far outnumber Hub releases and are listed alongside them,
  // so ask for many more than are wanted and filter. Asking for `limit` alone
  // returns a page of agent tags and finds no Hub release at all.
  const listed = JSON.parse(run('gh', [
    'release', 'list', '--repo', options.repo, '--limit', '100',
    '--json', 'tagName,isDraft',
  ]));
  const hubReleases = listed
    .filter((release) => !release.isDraft && !AGENT_TAG.test(release.tagName))
    .map((release) => release.tagName);
  if (!hubReleases.length && listed.length === 100) {
    throw new Error('Found no Hub release in the most recent 100; widen the listing');
  }
  return hubReleases.slice(0, options.limit);
}

function checkRelease(tag, repo) {
  const problems = [];
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-gate-'));
  try {
    try {
      run('gh', ['release', 'download', tag, '--repo', repo, '--dir', scratch, '--clobber']);
    } catch {
      return [`${tag}: has no downloadable assets at all`];
    }
    const files = fs.readdirSync(scratch);
    const artifact = files.find((f) => f.endsWith('.tar.gz'));
    if (!artifact) return [`${tag}: carries no source bundle`];
    for (const suffix of ['.sha256', '.sig', '.pub.pem']) {
      if (!files.includes(`${artifact}${suffix}`)) problems.push(`${tag}: missing ${artifact}${suffix}`);
    }
    if (problems.length) return problems;

    // Provenance arrived after some releases were published, so its absence on
    // an older one is reported rather than treated as a failure. A release
    // that has it must have one that actually verifies.
    const hasProvenance = files.includes(`${artifact}.intoto.jsonl`);

    const paths = {
      artifact: path.join(scratch, artifact),
      checksum: path.join(scratch, `${artifact}.sha256`),
      signature: path.join(scratch, `${artifact}.sig`),
      publicKey: path.join(scratch, `${artifact}.pub.pem`),
    };
    let verified;
    try {
      verified = JSON.parse(run(process.execPath, [
        path.join(ROOT, 'scripts', 'verify-offline-bundle.js'),
        '--artifact', paths.artifact, '--checksum', paths.checksum,
        '--signature', paths.signature, '--public-key', paths.publicKey,
      ]));
    } catch (error) {
      // The verifier's own message is the useful part. Reporting only "command
      // failed" hides why, which is exactly what a gate must not do.
      const detail = String(error.stderr || error.stdout || error.message).trim();
      return [`${tag}: the published assets do not verify\n  ${detail.split('\n').join('\n  ')}`];
    }
    if (!verified?.verified) return [`${tag}: the published assets do not verify`];

    // The signature is only worth as much as the key behind it, and a key
    // published only beside the artifact is not independently checkable.
    const fingerprint = fingerprintPublicKey(fs.readFileSync(paths.publicKey));
    const registry = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
    if (!registry.keys.some((key) => key.fingerprint === fingerprint)) {
      problems.push(`${tag}: signed with ${fingerprint}, which is in no trust registry entry`);
    }
    try {
      if (!run('dig', ['+short', 'TXT', DNS_ANCHOR]).includes(fingerprint)) {
        problems.push(`${tag}: ${fingerprint} is not published at ${DNS_ANCHOR}`);
      }
    } catch {
      problems.push(`${tag}: could not read the DNS trust anchor at ${DNS_ANCHOR}`);
    }
    if (hasProvenance) {
      try {
        const result = JSON.parse(run(process.execPath, [
          path.join(ROOT, 'scripts', 'verify-provenance.js'),
          '--artifact', paths.artifact,
          '--provenance', path.join(scratch, `${artifact}.intoto.jsonl`),
          '--public-key', paths.publicKey,
        ]));
        if (!result?.verified) problems.push(`${tag}: the published provenance does not verify`);
      } catch (error) {
        const detail = String(error.stderr || error.message).trim().split('\n')[0];
        problems.push(`${tag}: the published provenance does not verify\n  ${detail}`);
      }
    }

    if (!problems.length) {
      const note = hasProvenance ? 'signature, fingerprint and provenance' : 'signature and fingerprint';
      process.stderr.write(`${tag}: ${verified.files} files, ${note} check out\n`);
      if (!hasProvenance) {
        process.stderr.write(`${tag}: no provenance -- published before it existed\n`);
      }
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  return problems;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const tags = releasesToCheck(options);
  if (!tags.length) {
    process.stderr.write('No published Hub releases to check\n');
    return [];
  }
  const exempt = knownUnsigned();
  const problems = [];
  for (const tag of tags) {
    const known = exempt.get(tag);
    if (known) {
      // Reported, not skipped silently: the fact that these shipped without
      // anything to verify is part of the record.
      process.stderr.write(`${tag}: known unsigned, recorded — ${known.reason}\n`);
      continue;
    }
    problems.push(...checkRelease(tag, options.repo));
  }
  if (problems.length) {
    process.stderr.write(`\nUnverifiable release:\n- ${problems.join('\n- ')}\n\n`
      + 'Publish with `npm run release:publish -- --tag <tag>`, which cannot leave a\n'
      + 'release in this state: it uploads to a draft, verifies what the release page\n'
      + 'serves, and only then publishes.\n');
    process.exitCode = 1;
  }
  return problems;
}

if (require.main === module) main();

module.exports = { main, parseArgs, checkRelease, releasesToCheck, knownUnsigned };
