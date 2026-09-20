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
  assertPublishableTree,
  releaseTag,
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

  it('macOSのインストーラパッケージを受け付ける', () => {
    // `.pkg` はドラッグではなくその場で置き換える。Sandbox内のAgentが書いた
    // ものから取り出したアプリはmacOSが起動を拒否するため、DMGの手順では
    // 更新が完成しない。
    withTemp((dir) => {
      const manifest = buildManifest(parseArgs(baseArgs(fakePackage(dir, 'egressview-agent-0.3.8.pkg'))));
      assert.equal(manifest.packages[0].packageType, 'pkg');
      assert.match(manifest.packages[0].url, /\/macos\/egressview-agent-0\.3\.8\.pkg$/);
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
      assert.deepEqual(manifest.packages.map((entry) => entry.publisher), ['EgressView', 'EgressView']);
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

  // `publish` is not exported -- it shells out to aws and uploads -- so these
  // read the source. What they protect is small and was got wrong: the comment
  // said an invalidation failure is "a delay, not a failure" while the code
  // threw, so every publication with a signing role that lacks
  // cloudfront:CreateInvalidation ended in "publication failed" after the
  // upload had already succeeded. A release process that cannot tell success
  // from failure is how a bad release ships.
  it('invalidationの失敗で公開を失敗扱いにしない', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', 'scripts', 'publish-agent-release.js'), 'utf8'
    );
    const block = source.slice(
      source.indexOf('if (config.distributionId) {'),
      source.indexOf('await verifyPublished(')
    );
    assert.ok(block.length > 0, 'invalidation block not found');
    assert.match(block, /try \{/);
    assert.match(block, /\} catch \(error\) \{/);
    assert.match(block, /continuing/);
  });

  it('読み戻し検証はinvalidationの後に必ず実行される', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', 'scripts', 'publish-agent-release.js'), 'utf8'
    );
    const invalidation = source.indexOf('create-invalidation');
    const verify = source.indexOf('await verifyPublished(');
    assert.ok(invalidation > 0 && verify > invalidation, '検証がinvalidationより前にある');
    // Not inside the branch: it runs whether or not the cache was invalidated.
    const between = source.slice(invalidation, verify);
    assert.doesNotMatch(between, /process\.exit|throw /);
  });
});

describe('a release must be the tag it claims to be', () => {
  // Agent packages had no such check. The offline bundle's publisher learned
  // it the hard way -- 2.0.0, 2.0.1 and 2.0.2 all went out with no signed
  // assets and nothing failed, because releasing and signing were two things
  // a person had to remember in order. The record for the agent path says the
  // same in fewer words: the two distribution paths drifted "because it is
  // manual".
  const asking = (_cmd, args) => args[0];
  const clean = (cmd, args) => (asking(cmd, args) === 'status' ? '' : 'agent-windows/v0.1.86');
  const base = {
    platform: 'windows',
    version: '0.1.86',
    dryRun: false,
    packages: [{ arch: 'x64', file: '/tmp/EgressView-Agent-Windows-0.1.86-unsigned.msi' }],
  };

  it('タグの上でクリーンなら通す', () => {
    assert.doesNotThrow(() => assertPublishableTree(base, clean));
  });

  it('作業ツリーが汚れていれば拒む', () => {
    const dirty = (cmd, args) => (asking(cmd, args) === 'status' ? ' M src/thing.cs' : 'agent-windows/v0.1.86');
    assert.throws(() => assertPublishableTree(base, dirty), /uncommitted changes/);
  });

  it('HEADにそのタグが無ければ拒む', () => {
    const untagged = () => '';
    assert.throws(() => assertPublishableTree(base, untagged), /not tagged agent-windows/);
    const wrongTag = (cmd, args) => (asking(cmd, args) === 'status' ? '' : 'agent-windows/v0.1.85');
    assert.throws(() => assertPublishableTree(base, wrongTag), /not tagged/);
  });

  it('別のバージョンのファイルを指していれば拒む', () => {
    // The mistake that looks right in every log line: this version's manifest
    // pointing at the previous version's package.
    const mismatched = {
      ...base,
      packages: [{ arch: 'x64', file: '/tmp/EgressView-Agent-Windows-0.1.85-unsigned.msi' }],
    };
    assert.throws(() => assertPublishableTree(mismatched, clean), /does not carry the version/);
  });

  it('dry runは免除する', () => {
    // Producing a manifest to look at is how you check the shape of a release
    // before making one. Requiring a tag for that would teach people to tag
    // early, which is worse than not checking.
    const refuseEverything = () => { throw new Error('git should not have been consulted'); };
    assert.doesNotThrow(() => assertPublishableTree({ ...base, dryRun: true }, refuseEverything));
  });

  it('macOSにも同じ規則が当たる', () => {
    // One script, one rule. The agent versions differ from the repository's
    // own vX.Y.Z tags and from each other, so the tag names the platform too.
    assert.equal(releaseTag('macos', '0.5.59'), 'agent-macos/v0.5.59');
    assert.equal(releaseTag('windows', '0.1.86'), 'agent-windows/v0.1.86');
    const mac = {
      ...base,
      platform: 'macos',
      version: '0.5.59',
      packages: [{ arch: 'arm64', file: '/tmp/egressview-agent-0.5.59.pkg' }],
    };
    assert.throws(() => assertPublishableTree(mac, clean), /not tagged agent-macos/);
  });
});
