'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const root = path.join(__dirname, '..', '..');
const verifier = path.join(root, 'scripts', 'verify-offline-bundle.js');
const builder = path.join(root, 'scripts', 'build-offline-bundle.js');

function tarball({ withXattrs }) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-portability-'));
  const bundle = path.join(work, 'bundle');
  fs.mkdirSync(bundle, { recursive: true });
  fs.writeFileSync(path.join(bundle, 'a.txt'), 'hello\n');
  if (withXattrs && process.platform === 'darwin') {
    execFileSync('xattr', ['-w', 'com.apple.provenance', 'test', path.join(bundle, 'a.txt')]);
  }
  const artifact = path.join(work, 'bundle.tar.gz');
  const args = withXattrs
    ? ['-czf', artifact, '-C', work, 'bundle']
    : ['--no-xattrs', '-czf', artifact, '-C', work, 'bundle'];
  execFileSync('tar', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  return { work, artifact };
}

function paxKeywords(artifact) {
  const raw = zlib.gunzipSync(fs.readFileSync(artifact));
  const BLOCK = 512;
  const found = [];
  for (let offset = 0; offset + BLOCK <= raw.length; offset += BLOCK) {
    const size = parseInt(
      raw.toString('ascii', offset + 124, offset + 135).replace(/\0.*$/, '').trim(), 8
    );
    if (!Number.isFinite(size)) break;
    const typeflag = String.fromCharCode(raw[offset + 156]);
    if (typeflag === 'x' || typeflag === 'g') {
      found.push(raw.toString('utf8', offset + BLOCK, offset + BLOCK + size));
    }
    offset += Math.ceil((size || 0) / BLOCK) * BLOCK;
  }
  return found;
}

describe('offline bundle portability', () => {
  it('バンドル作成は拡張属性を書き込まない', () => {
    // A bundle built on a Mac carries macOS extended attributes that the Linux
    // host running the Hub has no use for. Measured 2026-08-23 on Ubuntu with
    // GNU tar 1.35: it extracts them anyway, exit status 0, warning once per
    // file. The reason to strip them is the noise in front of whoever is
    // installing offline -- not a failure, which is what this comment and the
    // verifier's error message both used to claim without measuring.
    const source = fs.readFileSync(builder, 'utf8');
    assert.match(source, /'--no-xattrs'/);
  });

  it('拡張属性を持つ成果物を検証器が拒否する', { skip: process.platform !== 'darwin' }, () => {
    const withXattrs = tarball({ withXattrs: true });
    try {
      assert.ok(
        paxKeywords(withXattrs.artifact).some((record) => record.includes('xattr')),
        'the fixture did not actually carry extended attributes'
      );
      assert.throws(
        () => execFileSync(process.execPath, [verifier, '--artifact', withXattrs.artifact], {
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
        /extended attributes|--artifact/
      );
    } finally {
      fs.rmSync(withXattrs.work, { recursive: true, force: true });
    }
  });

  it('拡張属性の検出はバンドル内のソース文字列に反応しない', () => {
    // Scanning the whole decompressed stream for the keyword matches the
    // verifier's own source, which ships inside the bundle. Only pax extended
    // headers may be inspected.
    const clean = tarball({ withXattrs: false });
    try {
      fs.writeFileSync(path.join(clean.work, 'decoy.txt'), "SCHILY.xattr LIBARCHIVE.xattr\n");
      const decoyArtifact = path.join(clean.work, 'decoy.tar.gz');
      execFileSync('tar', ['--no-xattrs', '-czf', decoyArtifact, '-C', clean.work, 'decoy.txt'],
        { stdio: ['ignore', 'pipe', 'pipe'] });
      assert.deepEqual(
        paxKeywords(decoyArtifact).filter((record) => record.includes('xattr')), [],
        'a file whose contents mention the keyword must not count as an extended attribute'
      );
    } finally {
      fs.rmSync(clean.work, { recursive: true, force: true });
    }
  });
});
