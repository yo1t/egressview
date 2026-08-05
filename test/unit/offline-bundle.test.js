'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  assertSafeBundle,
  assertSafeRelativePath,
  createManifest,
  verifyManifest,
} = require('../../scripts/offline-bundle-lib');
const {
  assertNodeRequirement,
  DEPENDENCY_INSTALL_ENV,
  installRelease,
  parseArgs,
  rollback,
  status,
} = require('../../scripts/offline-install');

function withTemp(callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-offline-unit-'));
  try {
    return callback(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function createBundle(root, releaseId, marker) {
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app', 'marker.txt'), marker);
  fs.writeFileSync(path.join(root, 'offline-install.js'), 'installer');
  fs.writeFileSync(path.join(root, 'offline-bundle-lib.js'), 'library');
  fs.writeFileSync(path.join(root, 'sbom.cdx.json'), '{}');
  const manifest = createManifest(root, {
    name: 'egressview',
    version: releaseId.split('-')[0],
    releaseId,
    platform: 'linux',
    arch: 'x64',
  });
  fs.writeFileSync(path.join(root, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
}

describe('offline bundle safety', () => {
  it('rejects traversal and absolute paths', () => {
    for (const value of ['../secret', '/etc/passwd', 'app/../../secret', 'app//file']) {
      assert.throws(() => assertSafeRelativePath(value), /Unsafe bundle path/);
    }
  });

  it('rejects credentials, databases, logs, and private keys by filename', () => withTemp((root) => {
    for (const name of ['.env', 'runtime.db', 'server.log', 'signing.key', 'backlog.md']) {
      const target = path.join(root, name);
      fs.writeFileSync(target, 'sensitive');
      assert.throws(() => assertSafeBundle(root), /Forbidden runtime or credential file/);
      fs.unlinkSync(target);
    }
  }));

  it('detects changed and undeclared files in the manifest', () => withTemp((root) => {
    fs.writeFileSync(path.join(root, 'file.txt'), 'original');
    const manifest = createManifest(root, { releaseId: '1.0.0-linux-x64' });
    verifyManifest(root, manifest);
    fs.writeFileSync(path.join(root, 'file.txt'), 'changed');
    assert.throws(() => verifyManifest(root, manifest), /verification failed/);
  }));
});

describe('offline atomic installation', () => {
  it('enforces the release Node.js requirement', () => {
    assert.doesNotThrow(() => assertNodeRequirement('>=22', '22.1.0'));
    assert.throws(() => assertNodeRequirement('>=24', '22.1.0'), /Node\.js >=24 is required/);
    assert.throws(() => assertNodeRequirement('^22', '22.1.0'), /Unsupported Node\.js requirement/);
  });

  it('installs, upgrades, and rolls back without touching external data', () => withTemp((root) => {
    const prefix = path.join(root, 'prefix');
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    createBundle(first, '1.0.0-linux-x64', 'one');
    createBundle(second, '1.1.0-linux-x64', 'two');

    installRelease({ bundleRoot: first, prefix, installDependencies: false });
    assert.match(status(prefix).current, /1\.0\.0-linux-x64$/);
    installRelease({ bundleRoot: second, prefix, installDependencies: false });
    assert.match(status(prefix).current, /1\.1\.0-linux-x64$/);
    assert.match(status(prefix).previous, /1\.0\.0-linux-x64$/);

    rollback(prefix);
    assert.match(status(prefix).current, /1\.0\.0-linux-x64$/);
    assert.equal(
      fs.readFileSync(path.join(prefix, status(prefix).current, 'marker.txt'), 'utf8'),
      'one'
    );
  }));

  it('keeps the current release and removes partial files when dependency install fails',
    () => withTemp((root) => {
      const prefix = path.join(root, 'prefix');
      const first = path.join(root, 'first');
      const second = path.join(root, 'second');
      createBundle(first, '1.0.0-linux-x64', 'one');
      createBundle(second, '1.1.0-linux-x64', 'two');
      installRelease({ bundleRoot: first, prefix, installDependencies: false });

      assert.throws(() => installRelease({
        bundleRoot: second,
        prefix,
        dependencyInstaller: () => {
          throw new Error('registry unavailable');
        },
      }), /registry unavailable/);

      assert.match(status(prefix).current, /1\.0\.0-linux-x64$/);
      assert.equal(status(prefix).previous, null);
      assert.equal(fs.existsSync(path.join(prefix, 'releases', '1.1.0-linux-x64')), false);
      assert.deepEqual(
        fs.readdirSync(path.join(prefix, 'releases')).filter((name) => name.includes('.install-')),
        []
      );
    }));

  it('refuses rollback when a release target is missing', () => withTemp((root) => {
    const prefix = path.join(root, 'prefix');
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    createBundle(first, '1.0.0-linux-x64', 'one');
    createBundle(second, '1.1.0-linux-x64', 'two');
    installRelease({ bundleRoot: first, prefix, installDependencies: false });
    installRelease({ bundleRoot: second, prefix, installDependencies: false });
    const before = status(prefix);

    fs.rmSync(path.resolve(prefix, before.previous), { recursive: true });
    assert.throws(() => rollback(prefix), /target is missing/);
    assert.equal(status(prefix).current, before.current);
  }));

  it('requires an explicit prefix and known command', () => {
    assert.throws(() => parseArgs(['install']), /--prefix is required/);
    assert.throws(() => parseArgs(['remove', '--prefix', '/tmp/example']), /Command must be/);
  });

  it('依存インストールで install script を実行しない', () => {
    // better-sqlite3 ships a binding.gyp with no install script, and npm reads
    // that as an implicit `node-gyp rebuild`. Without this flag a target
    // without Python and a C++ toolchain cannot install, even though the
    // bundled prebuild would have worked. The repository .npmrc cannot cover
    // this: `npm pack` strips .npmrc from the tarball the bundle is built
    // from, so the setting has to travel with the installer.
    assert.equal(DEPENDENCY_INSTALL_ENV.npm_config_ignore_scripts, 'true');
  });
});
