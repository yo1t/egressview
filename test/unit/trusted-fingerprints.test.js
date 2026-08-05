// Trust registry validation (P2-70)
// Run: node --test test/unit/trusted-fingerprints.test.js
//
// release-signing/trusted-fingerprints.json is the pinned list of keys allowed
// to sign an official release. Until now nothing read it, so a fingerprint that
// did not match the committed public key -- a typo, a stale entry after
// rotation, or a key swapped without updating the record -- would only be
// caught by a human comparing 64 hex characters by eye.
//
// These cases recompute every enrolled fingerprint from the file it names and
// fail on any disagreement, and refuse private key material in the directory.
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { fingerprintPublicKey } = require('../../scripts/release-key-fingerprint');

const ROOT = path.join(__dirname, '..', '..');
const REGISTRY_PATH = path.join(ROOT, 'release-signing', 'trusted-fingerprints.json');
const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));

const STATUSES = new Set(['active', 'retired', 'revoked']);

describe('trust registry: 形式', () => {
  it('schemaVersion と keys 配列を持つ', () => {
    assert.equal(registry.schemaVersion, 1);
    assert.ok(Array.isArray(registry.keys));
  });

  it('keyId が一意', () => {
    const ids = registry.keys.map(k => k.keyId);
    assert.deepEqual(ids, [...new Set(ids)], 'keyId の重複はどの鍵を指すか曖昧にする');
  });

  it('各レコードが必須フィールドを持ち、値の形式が正しい', () => {
    for (const key of registry.keys) {
      assert.match(key.keyId, /^[a-z0-9-]+$/, `keyId: ${key.keyId}`);
      assert.ok(STATUSES.has(key.status), `未知の status: ${key.status}`);
      // Prefix-or-suffix comparison is explicitly not enough, so the record
      // has to carry the whole value.
      assert.match(
        key.fingerprint,
        /^SHA256:[0-9a-f]{64}$/,
        `fingerprint は SHA256:<64桁小文字hex> であること: ${key.keyId}`
      );
      assert.match(key.createdAt, /^\d{4}-\d{2}-\d{2}$/, `createdAt: ${key.keyId}`);
      assert.ok(key.publicKey, `publicKey パス未設定: ${key.keyId}`);
    }
  });

  it('active な鍵は高々1つ', () => {
    const active = registry.keys.filter(k => k.status === 'active');
    // More than one active key during a planned rotation is expected only for
    // the overlap release; outside that it means a retired key was never
    // marked, which widens what a verifier will accept.
    assert.ok(active.length <= 1, `active が ${active.length} 件ある`);
  });
});

describe('trust registry: 公開鍵との一致', () => {
  it('登録された fingerprint が実ファイルから再計算した値と一致する', () => {
    for (const key of registry.keys) {
      const pemPath = path.join(ROOT, key.publicKey);
      assert.ok(fs.existsSync(pemPath), `公開鍵が見つからない: ${key.publicKey}`);
      const actual = fingerprintPublicKey(fs.readFileSync(pemPath));
      assert.equal(
        actual,
        key.fingerprint,
        `${key.keyId}: 登録値と実ファイルが一致しない`
      );
    }
  });

  it('公開鍵は Ed25519 である', () => {
    for (const key of registry.keys) {
      const pem = fs.readFileSync(path.join(ROOT, key.publicKey), 'utf8');
      assert.match(pem, /^-----BEGIN PUBLIC KEY-----/);
      // fingerprintPublicKey throws for anything that is not Ed25519.
      assert.doesNotThrow(() => fingerprintPublicKey(pem), `${key.keyId}`);
    }
  });
});

describe('trust registry: 秘密鍵の混入防止', () => {
  it('release-signing/ に秘密鍵が置かれていない', () => {
    const dir = path.join(ROOT, 'release-signing');
    for (const name of fs.readdirSync(dir)) {
      const body = fs.readFileSync(path.join(dir, name), 'utf8');
      assert.equal(
        /-----BEGIN (?:ENCRYPTED )?(?:\w+ )?PRIVATE KEY-----/.test(body),
        false,
        `${name} に秘密鍵が含まれている`
      );
    }
  });

  it('公開鍵ファイルは .pub.pem 命名に従う', () => {
    for (const key of registry.keys) {
      assert.match(key.publicKey, /\.pub\.pem$/, `${key.keyId}`);
    }
  });
});

describe('trust registry: 配布物のcontent policy', () => {
  const { assertSafeBundle } = require('../../scripts/offline-bundle-lib');
  const os = require('node:os');

  function withBundle(files, run) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-policy-'));
    try {
      fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
      for (const [name, body] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, 'app', name), body);
      }
      return run(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  const publicKey = fs.readFileSync(
    path.join(ROOT, registry.keys[0].publicKey), 'utf8'
  );

  it('公開鍵(.pub.pem)は配布物に含められる', () => {
    // Enrolling the key broke `offline:bundle` outright: the policy blocked
    // every *.pem, so committing the public verification key made the release
    // build fail. The exception exists for exactly this file.
    withBundle({ 'release.pub.pem': publicKey }, (dir) => {
      assert.doesNotThrow(() => assertSafeBundle(dir));
    });
  });

  it('秘密鍵は .pub.pem という名前でも拒否される', () => {
    // The name is not trusted; the content scan is what decides.
    // Assemble the PEM markers at runtime so the private-key header never
    // appears verbatim in source (the repo secret scanners flag it on sight).
    // assertSafeBundle still sees the full marker in the written file.
    const marker = 'PRIVATE KEY';
    const priv = `-----BEGIN ${marker}-----\nMC4CAQAwBQYDK2VwBCIEIA==\n-----END ${marker}-----\n`;
    withBundle({ 'evil.pub.pem': priv }, (dir) => {
      assert.throws(() => assertSafeBundle(dir), /credential|Forbidden/i);
    });
  });

  it('通常の .pem と .key は引き続き拒否される', () => {
    for (const name of ['server.pem', 'server.key', 'x.pub.key']) {
      withBundle({ [name]: 'placeholder\n' }, (dir) => {
        assert.throws(() => assertSafeBundle(dir), /Forbidden/, name);
      });
    }
  });
});
