'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { publicKeyPemFromDer, signDetached, verifyDetached } = require('../../scripts/ed25519-signature');
const { verifySignature } = require('../../scripts/publish-agent-release');

describe('Ed25519 release signatures without an OpenSSL CLI', () => {
  it('verifies the exact manifest bytes and rejects tampering or another key', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-ed25519-'));
    try {
      const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
      const other = crypto.generateKeyPairSync('ed25519').publicKey;
      const privatePath = path.join(dir, 'private.pem');
      const publicPath = path.join(dir, 'public.pem');
      const manifestPath = path.join(dir, 'manifest.json');
      const signaturePath = path.join(dir, 'manifest.json.sig');
      fs.writeFileSync(privatePath, privateKey.export({ format: 'pem', type: 'pkcs8' }));
      fs.writeFileSync(publicPath, publicKeyPemFromDer(publicKey.export({ format: 'der', type: 'spki' })));
      fs.writeFileSync(manifestPath, '{"version":"1.0.0"}\n');
      fs.writeFileSync(signaturePath, signDetached(fs.readFileSync(manifestPath), privatePath));
      assert.doesNotThrow(() => verifySignature(manifestPath, signaturePath, publicPath));
      fs.appendFileSync(manifestPath, ' ');
      assert.throws(() => verifySignature(manifestPath, signaturePath, publicPath), /verification failed/);
      fs.writeFileSync(manifestPath, '{"version":"1.0.0"}\n');
      fs.writeFileSync(publicPath, other.export({ format: 'pem', type: 'spki' }));
      assert.throws(() => verifySignature(manifestPath, signaturePath, publicPath), /verification failed/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects non-Ed25519 public keys and malformed signatures', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-ed25519-'));
    try {
      const publicPath = path.join(dir, 'public.pem');
      const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      fs.writeFileSync(publicPath, publicKey.export({ format: 'pem', type: 'spki' }));
      assert.throws(() => verifyDetached(Buffer.from('x'), Buffer.alloc(64), publicPath), /Ed25519 key/);
      assert.throws(() => publicKeyPemFromDer(publicKey.export({ format: 'der', type: 'spki' })), /Ed25519 key/);
      const ed = crypto.generateKeyPairSync('ed25519').publicKey;
      fs.writeFileSync(publicPath, ed.export({ format: 'pem', type: 'spki' }));
      assert.throws(() => verifyDetached(Buffer.from('x'), Buffer.alloc(63), publicPath), /verification failed/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
