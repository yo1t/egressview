#!/usr/bin/env node
'use strict';

/**
 * Build, sign, and publish a Hub release in one act.
 *
 * This exists because 2.0.0, 2.0.1 and 2.0.2 were all published with no signed
 * assets. The signing pipeline never failed -- it was never run. Releasing and
 * signing were two separate things a person had to remember to do in order,
 * and three releases in a row are enough evidence that remembering is not a
 * control. The agent's release path has been a single script since it existed
 * and has never missed once.
 *
 * The ordering is the whole point:
 *
 *   1. Refuse to start unless the checkout is the tag, clean, and tested.
 *   2. Build, sign with KMS, verify locally, and prove three tamper cases fail.
 *   3. Create the release as a DRAFT with all four assets.
 *   4. Download those assets back from GitHub and verify what is actually
 *      served, not what is on this disk.
 *   5. Compare the published key's fingerprint against the DNS TXT anchor,
 *      which is served under separate credentials from the repository.
 *   6. Only then publish the draft.
 *
 * Draft-first is what makes an unsigned release impossible rather than merely
 * unlikely. If any step fails, what exists is a draft -- not a public release
 * with nothing to verify, which is exactly the state 2.0.x was left in.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { fingerprintPublicKey } = require('./release-key-fingerprint');

const ROOT = path.join(__dirname, '..');
const REGISTRY = path.join(ROOT, 'release-signing', 'trusted-fingerprints.json');
const DNS_ANCHOR = '_egressview-release.egressview.com';
const TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd || ROOT,
    encoding: 'utf8',
    env: options.env || process.env,
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
  });
}

function step(message) {
  process.stderr.write(`\n== ${message}\n`);
}

function fail(message) {
  const error = new Error(message);
  error.expected = true;
  throw error;
}

function parseArgs(argv) {
  const options = { skipTests: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--tag') options.tag = argv[++i];
    else if (flag === '--kms-key-id') options.kmsKeyId = argv[++i];
    else if (flag === '--region') options.region = argv[++i];
    else if (flag === '--repo') options.repo = argv[++i];
    // Only for rehearsing this script itself. It stops before creating
    // anything on GitHub, so it can never leave a half-published release.
    else if (flag === '--dry-run') options.dryRun = true;
    else fail(`Unknown option: ${flag}`);
  }
  options.kmsKeyId = options.kmsKeyId || 'alias/egressview-release';
  options.region = options.region || 'ap-northeast-1';
  options.repo = options.repo || 'yo1t/egressview';
  if (!TAG.test(String(options.tag || ''))) {
    fail('--tag must be a release tag such as v2.0.3');
  }
  return options;
}

/**
 * Everything that must be true before a single byte is built. A release built
 * from a dirty tree, or from a commit that is not the tag, is not the thing
 * the tag names, and no amount of signing afterwards fixes that.
 */
function assertReleasableCheckout(tag) {
  step(`Checking the working tree is exactly ${tag}`);
  let tagCommit;
  try {
    tagCommit = run('git', ['rev-parse', `${tag}^{commit}`]).trim();
  } catch {
    fail(`Tag ${tag} does not exist in this repository`);
  }
  const head = run('git', ['rev-parse', 'HEAD']).trim();
  if (head !== tagCommit) {
    fail(`HEAD is ${head.slice(0, 8)} but ${tag} is ${tagCommit.slice(0, 8)}; check out the tag`);
  }
  const dirty = run('git', ['status', '--porcelain', '--untracked-files=no']).trim();
  if (dirty) {
    fail(`Working tree has uncommitted changes:\n${dirty}`);
  }
  return tagCommit;
}

/**
 * Null when the tag has no release yet. A draft is fine to continue into; a
 * published release is not, because this script's guarantee is that a release
 * is never public before its assets have been verified.
 */
function releaseState(tag, repo) {
  try {
    return JSON.parse(run('gh', ['release', 'view', tag, '--repo', repo, '--json', 'isDraft']));
  } catch {
    return null;
  }
}

function bundlePaths(outputDir, version) {
  const artifact = path.join(outputDir, `egressview-offline-${version}.tar.gz`);
  return {
    artifact,
    checksum: `${artifact}.sha256`,
    signature: `${artifact}.sig`,
    publicKey: `${artifact}.pub.pem`,
  };
}

function verifyBundle(paths, options = {}) {
  const args = [
    path.join(ROOT, 'scripts', 'verify-offline-bundle.js'),
    '--artifact', paths.artifact,
    '--checksum', paths.checksum,
    '--signature', paths.signature,
    '--public-key', paths.publicKey,
  ];
  try {
    return JSON.parse(run(process.execPath, args, options));
  } catch (error) {
    if (options.expectFailure) return null;
    throw error;
  }
}

/**
 * Verification that only ever runs against intact files proves the happy path
 * and nothing else. These three cases are the ones that matter: a swapped
 * archive, a rewritten checksum, and a forged signature.
 */
function assertTamperCasesFail(paths) {
  step('Proving a tampered bundle fails to verify');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-tamper-'));
  try {
    const copy = {};
    for (const [name, file] of Object.entries(paths)) {
      copy[name] = path.join(scratch, path.basename(file));
      fs.copyFileSync(file, copy[name]);
    }
    if (!verifyBundle(copy)) fail('An untouched copy failed to verify');

    const cases = {
      archive: () => fs.appendFileSync(copy.artifact, 'x'),
      checksum: () => fs.writeFileSync(copy.checksum, `f${fs.readFileSync(copy.checksum, 'utf8').slice(1)}`),
      signature: () => fs.appendFileSync(copy.signature, 'x'),
    };
    for (const [name, damage] of Object.entries(cases)) {
      const original = fs.readFileSync(copy[name === 'archive' ? 'artifact' : name]);
      damage();
      if (verifyBundle(copy, { expectFailure: true })) {
        fail(`A modified ${name} still verified; the signature check is not doing its job`);
      }
      fs.writeFileSync(copy[name === 'archive' ? 'artifact' : name], original);
      process.stderr.write(`   modified ${name}: rejected\n`);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * A fingerprint published only beside the artifact proves nothing: one account
 * compromise changes both together. The DNS record is served under separate
 * credentials, so it is the comparison that actually carries the trust.
 */
function assertFingerprintAnchored(publicKeyFile) {
  step('Comparing the key fingerprint against the independent channel');
  const fingerprint = fingerprintPublicKey(fs.readFileSync(publicKeyFile));

  const registry = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  const active = registry.keys.filter((key) => key.status === 'active');
  if (active.length !== 1) fail(`Expected exactly one active key in the registry, found ${active.length}`);
  if (active[0].fingerprint !== fingerprint) {
    fail(`Signed with ${fingerprint} but the registry's active key is ${active[0].fingerprint}`);
  }

  let txt;
  try {
    txt = run('dig', ['+short', 'TXT', DNS_ANCHOR]);
  } catch {
    fail(`Could not read the DNS trust anchor at ${DNS_ANCHOR}`);
  }
  if (!txt.includes(fingerprint)) {
    fail(`${DNS_ANCHOR} does not carry ${fingerprint}; publish the fingerprint before the release`);
  }
  process.stderr.write(`   ${fingerprint}\n   matches the registry and ${DNS_ANCHOR}\n`);
  return { fingerprint, keyId: active[0].keyId };
}

/**
 * Verifying the files on this disk says nothing about what GitHub serves. An
 * upload can truncate, and an asset can be replaced. Check what a downloader
 * would actually get.
 */
function assertPublishedAssetsVerify(tag, repo, version) {
  step('Downloading the published assets and verifying those');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-published-'));
  try {
    run('gh', ['release', 'download', tag, '--repo', repo, '--dir', scratch, '--clobber'],
      { stdio: ['ignore', 'inherit', 'inherit'] });
    const downloaded = bundlePaths(scratch, version);
    for (const file of Object.values(downloaded)) {
      if (!fs.existsSync(file)) fail(`The release is missing ${path.basename(file)}`);
    }
    const result = verifyBundle(downloaded);
    if (!result?.verified) fail('The published assets did not verify');
    assertFingerprintAnchored(downloaded.publicKey);
    process.stderr.write(`   verified ${result.files} files from the release page\n`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const commit = assertReleasableCheckout(options.tag);
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

  // The bundle is named for the Hub version, which is not always the release
  // number -- 2.0.2 carries Hub 1.10.0. Say both, so release notes and asset
  // names cannot silently disagree.
  process.stderr.write(
    `\nRelease ${options.tag} carries Hub ${version} (commit ${commit.slice(0, 8)})\n`
    + `Assets will be named egressview-offline-${version}.*\n`
  );

  // Checked before anything is built, so a tag that cannot be published this
  // way does not cost a full build and a KMS signature first.
  const existing = options.dryRun ? null : releaseState(options.tag, options.repo);
  if (existing && !existing.isDraft) {
    fail(`${options.tag} is already published; upload assets to it deliberately rather than through this script`);
  }

  step('Running the release checks');
  run('npm', ['run', 'release:check'], { stdio: ['ignore', 'inherit', 'inherit'] });

  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-release-'));
  const paths = bundlePaths(outputDir, version);
  try {
    step('Building and signing with KMS');
    run(process.execPath, [
      path.join(ROOT, 'scripts', 'build-offline-bundle.js'),
      '--output', outputDir,
      '--kms-key-id', options.kmsKeyId,
      '--region', options.region,
    ], { stdio: ['ignore', 'inherit', 'inherit'] });

    step('Verifying the freshly signed bundle');
    const local = verifyBundle(paths);
    if (!local?.verified) fail('The bundle this script just produced did not verify');
    process.stderr.write(`   verified ${local.files} files\n`);

    assertTamperCasesFail(paths);
    const { fingerprint, keyId } = assertFingerprintAnchored(paths.publicKey);

    if (options.dryRun) {
      step('Dry run: stopping before anything is created on GitHub');
      return { tag: options.tag, version, fingerprint, keyId, published: false };
    }

    // Draft, not published. Everything after this point can fail without
    // leaving a public release that has nothing to verify.
    step(`Creating ${options.tag} as a draft with its assets`);
    if (!existing) {
      run('gh', ['release', 'create', options.tag, '--repo', options.repo, '--draft',
        '--title', options.tag, '--generate-notes'], { stdio: ['ignore', 'inherit', 'inherit'] });
    }
    run('gh', ['release', 'upload', options.tag, '--repo', options.repo, '--clobber',
      ...Object.values(paths)], { stdio: ['ignore', 'inherit', 'inherit'] });

    assertPublishedAssetsVerify(options.tag, options.repo, version);

    step(`Publishing ${options.tag}`);
    run('gh', ['release', 'edit', options.tag, '--repo', options.repo, '--draft=false'],
      { stdio: ['ignore', 'inherit', 'inherit'] });

    process.stderr.write(`\n${options.tag} published with signed assets (key ${keyId})\n`);
    return { tag: options.tag, version, fingerprint, keyId, published: true };
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`\nRelease publication failed: ${error.message}\n`);
    if (!error.expected && error.stack) process.stderr.write(`${error.stack}\n`);
    process.exit(1);
  }
}

module.exports = {
  main, parseArgs, assertReleasableCheckout, bundlePaths, releaseState,
  assertFingerprintAnchored, assertTamperCasesFail, assertPublishedAssetsVerify,
};
