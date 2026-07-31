'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { describe, it } = require('node:test');
const { fingerprintPublicKey } = require('../../scripts/release-key-fingerprint');

describe('release signing key fingerprint', () => {
  it('creates a stable SHA-256 fingerprint for an Ed25519 public key', () => {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const pem = publicKey.export({ type: 'spki', format: 'pem' });
    const first = fingerprintPublicKey(pem);
    assert.match(first, /^SHA256:[a-f0-9]{64}$/);
    assert.equal(fingerprintPublicKey(pem), first);
  });

  it('rejects a non-Ed25519 public key', () => {
    const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    assert.throws(() => fingerprintPublicKey(publicKey), /Expected an Ed25519 public key/);
  });

  it('refuses private key material', () => {
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    assert.throws(() => fingerprintPublicKey(pem), /Refusing a private key/);
  });
});
