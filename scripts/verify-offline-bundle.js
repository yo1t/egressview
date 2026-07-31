#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  assertSafeBundle,
  assertSafeRelativePath,
  sha256,
  verifyManifest,
} = require('./offline-bundle-lib');

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--') || i + 1 >= argv.length) {
      throw new Error(`Invalid argument: ${argv[i] || ''}`);
    }
    options[argv[i].slice(2)] = path.resolve(argv[++i]);
  }
  for (const required of ['artifact', 'checksum', 'signature', 'public-key']) {
    if (!options[required]) throw new Error(`--${required} is required`);
  }
  return options;
}

function verify(options) {
  execFileSync('openssl', [
    'pkeyutl',
    '-verify',
    '-rawin',
    '-pubin',
    '-inkey', options['public-key'],
    '-sigfile', options.signature,
    '-in', options.checksum,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  const line = fs.readFileSync(options.checksum, 'utf8').trim();
  const match = /^([0-9a-f]{64}) {2}([A-Za-z0-9._-]+)$/.exec(line);
  if (!match) throw new Error('Malformed checksum file');
  if (match[2] !== path.basename(options.artifact)) throw new Error('Checksum filename mismatch');
  if (sha256(options.artifact) !== match[1]) throw new Error('Artifact checksum mismatch');

  const listing = execFileSync('tar', ['-tzf', options.artifact], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean);
  for (const entry of listing) {
    const withoutRoot = entry.replace(/^[^/]+\/?/, '');
    if (withoutRoot) assertSafeRelativePath(withoutRoot.replace(/\/$/, ''));
  }
  const roots = new Set(listing.map((entry) => entry.split('/')[0]).filter(Boolean));
  if (roots.size !== 1) throw new Error('Artifact must contain exactly one root directory');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-offline-verify-'));
  try {
    execFileSync('tar', ['-xzf', options.artifact, '-C', temp]);
    const root = path.join(temp, [...roots][0]);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    verifyManifest(root, manifest);
    assertSafeBundle(root);
    return manifest;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    const manifest = verify(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({
      verified: true,
      releaseId: manifest.releaseId,
      files: manifest.files.length,
    })}\n`);
  } catch (error) {
    process.stderr.write(`Offline bundle verification failed: ${error.message}\n`);
    process.exit(1);
  }
}

module.exports = { parseArgs, verify };
