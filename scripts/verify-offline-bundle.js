#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
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

/**
 * The payloads of pax extended headers ('x' local, 'g' global), which is where
 * a tar records extended attributes. Walking the 512-byte block structure is
 * exact where a text search over the whole archive is not.
 */
function paxHeaderRecords(raw) {
  const BLOCK = 512;
  const records = [];
  for (let offset = 0; offset + BLOCK <= raw.length; offset += BLOCK) {
    const size = parseInt(raw.toString('ascii', offset + 124, offset + 135).replace(/\0.*$/, '').trim(), 8);
    if (!Number.isFinite(size)) break;
    const typeflag = String.fromCharCode(raw[offset + 156]);
    const dataBlocks = Math.ceil((size || 0) / BLOCK);
    if (typeflag === 'x' || typeflag === 'g') {
      records.push(raw.toString('utf8', offset + BLOCK, offset + BLOCK + size));
    }
    offset += dataBlocks * BLOCK;
  }
  return records;
}

/**
 * A bundle built on a Mac can carry macOS extended attributes, which GNU tar
 * rejects on extraction -- so it fails to unpack on exactly the Linux hosts it
 * is built for. The build strips them; this refuses an artifact where that did
 * not happen, so the property does not depend on who ran the build.
 */
function assertPortableArchive(artifact) {
  // Read the archive rather than asking tar: bsdtar does not name the
  // attributes in its listing and GNU tar only warns, so neither reports this
  // the same way on both platforms.
  //
  // Only pax extended headers are inspected. Scanning the whole decompressed
  // stream for the keyword matches this file's own source, which ships inside
  // the bundle -- a mistake worth naming, because it makes the check report
  // every bundle as broken.
  const raw = zlib.gunzipSync(fs.readFileSync(artifact));
  const marker = paxHeaderRecords(raw).some(
    (record) => record.includes('SCHILY.xattr') || record.includes('LIBARCHIVE.xattr')
  );
  if (marker) {
    throw new Error(
      'Artifact carries extended attributes; rebuild it with tar --no-xattrs '
      + 'so it extracts on Linux, where GNU tar exits non-zero on them'
    );
  }
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
  assertPortableArchive(options.artifact);

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
