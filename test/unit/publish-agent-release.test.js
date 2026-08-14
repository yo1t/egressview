'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  parseArgs,
  buildManifest,
  serializeManifest,
  MANIFEST_SCHEMA_VERSION,
} = require('../../scripts/publish-agent-release');

function withTemp(callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-agent-release-unit-'));
  try {
    return callback(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function fakePackage(dir, name, contents = 'package') {
  const file = path.join(dir, name);
  fs.writeFileSync(file, contents);
  return file;
}

function baseArgs(file) {
  return [
    '--platform', 'macos',
    '--version', '0.2.0',
    '--package', `arm64=${file}`,
    '--dry-run',
  ];
}

describe('agent release publication', () => {
  it('既定の配布元はHTTPSのdl.egressview.comである', () => {
    withTemp((dir) => {
      const config = parseArgs(baseArgs(fakePackage(dir, 'EgressViewAgent-0.2.0.dmg')));
      assert.equal(config.baseUrl, 'https://dl.egressview.com');
      assert.equal(config.keyId, 'alias/egressview-release');
    });
  });

  it('平文の配布元とパス付きの配布元を拒否する', () => {
    withTemp((dir) => {
      const file = fakePackage(dir, 'EgressViewAgent-0.2.0.dmg');
      for (const bad of ['http://dl.egressview.com', 'https://dl.egressview.com/macos']) {
        assert.throws(
          () => parseArgs([...baseArgs(file), '--base-url', bad]),
          /--base-url must be an https origin/
        );
      }
    });
  });

  it('不正なplatform・version・アーキテクチャ重複を拒否する', () => {
    withTemp((dir) => {
      const file = fakePackage(dir, 'EgressViewAgent-0.2.0.dmg');
      assert.throws(
        () => parseArgs(['--platform', 'macosx', '--version', '0.2.0', '--package', `arm64=${file}`, '--dry-run']),
        /--platform must be one of/
      );
      assert.throws(
        () => parseArgs(['--platform', 'macos', '--version', 'v0.2', '--package', `arm64=${file}`, '--dry-run']),
        /--version must be a semantic version/
      );
      assert.throws(
        () => parseArgs([...baseArgs(file), '--package', `arm64=${file}`]),
        /duplicate --package arch/
      );
    });
  });

  it('存在しないパッケージと未知の拡張子を拒否する', () => {
    withTemp((dir) => {
      assert.throws(
        () => parseArgs(['--platform', 'macos', '--version', '0.2.0', '--package', `arm64=${path.join(dir, 'missing.dmg')}`, '--dry-run']),
        /package not found/
      );
      assert.throws(
        () => parseArgs(baseArgs(fakePackage(dir, 'EgressViewAgent-0.2.0.zip'))),
        /unsupported package type/
      );
    });
  });

  it('アップロード先を伴わない実publishを拒否する', () => {
    withTemp((dir) => {
      const file = fakePackage(dir, 'EgressViewAgent-0.2.0.dmg');
      assert.throws(
        () => parseArgs(['--platform', 'macos', '--version', '0.2.0', '--package', `arm64=${file}`]),
        /--bucket is required/
      );
    });
  });

  it('CloudFront権限が無くても公開できるようdistribution-idは任意である', () => {
    withTemp((dir) => {
      const file = fakePackage(dir, 'EgressViewAgent-0.2.0.dmg');
      const config = parseArgs([
        '--platform', 'macos', '--version', '0.2.0',
        '--package', `arm64=${file}`, '--bucket', 'example-bucket',
      ]);
      assert.equal(config.bucket, 'example-bucket');
      assert.equal(config.distributionId, undefined);
    });
  });

  it('manifestはプラットフォーム配下のURLを指し、ルート直下に置かれない', () => {
    withTemp((dir) => {
      const file = fakePackage(dir, 'EgressViewAgent-0.2.0.dmg');
      const manifest = buildManifest(parseArgs(baseArgs(file)));
      assert.equal(manifest.schemaVersion, MANIFEST_SCHEMA_VERSION);
      assert.equal(manifest.platform, 'macos');
      assert.equal(
        manifest.packages[0].url,
        'https://dl.egressview.com/macos/EgressViewAgent-0.2.0.dmg'
      );
    });
  });

  it('manifestはアーキテクチャごとのパッケージ配列を持ち、1パッケージ前提にしない', () => {
    withTemp((dir) => {
      const arm = fakePackage(dir, 'EgressViewAgent-0.2.0-arm64.msi', 'arm');
      const x64 = fakePackage(dir, 'EgressViewAgent-0.2.0-x64.msi', 'x64');
      const manifest = buildManifest(parseArgs([
        '--platform', 'windows',
        '--version', '0.2.0',
        '--package', `arm64=${arm}`,
        '--package', `x64=${x64}`,
        '--dry-run',
      ]));
      assert.deepEqual(manifest.packages.map((entry) => entry.arch), ['arm64', 'x64']);
      assert.deepEqual(manifest.packages.map((entry) => entry.packageType), ['msi', 'msi']);
      assert.notEqual(manifest.packages[0].sha256, manifest.packages[1].sha256);
      assert.equal(new Set(manifest.packages.map((entry) => entry.url)).size, 2);
    });
  });

  it('記録するSHA-256とサイズが実ファイルと一致する', () => {
    withTemp((dir) => {
      const file = fakePackage(dir, 'EgressViewAgent-0.2.0.dmg', 'egressview agent payload');
      const manifest = buildManifest(parseArgs(baseArgs(file)));
      const expected = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      assert.equal(manifest.packages[0].sha256, expected);
      assert.equal(manifest.packages[0].sizeBytes, fs.statSync(file).size);
    });
  });

  it('署名対象のバイト列は決定的で、KMSのRAW上限に収まる', () => {
    withTemp((dir) => {
      const file = fakePackage(dir, 'EgressViewAgent-0.2.0.dmg');
      const config = parseArgs(baseArgs(file));
      const fixed = new Date('2026-08-14T00:00:00.000Z');
      const first = serializeManifest(buildManifest(config, fixed));
      const second = serializeManifest(buildManifest(config, fixed));
      assert.equal(first, second);
      assert.ok(first.endsWith('\n'));
      assert.ok(Buffer.byteLength(first) < 4096);
    });
  });
});
