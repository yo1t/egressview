'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

function assertEd25519(key) {
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('Expected an Ed25519 key');
  }
  return key;
}

function publicKeyPemFromDer(der) {
  const key = assertEd25519(crypto.createPublicKey({ key: der, format: 'der', type: 'spki' }));
  return key.export({ format: 'pem', type: 'spki' });
}

function signDetached(message, privateKeyPath) {
  const key = assertEd25519(crypto.createPrivateKey(fs.readFileSync(privateKeyPath)));
  return crypto.sign(null, message, key);
}

function verifyDetached(message, signature, publicKeyPath) {
  const key = assertEd25519(crypto.createPublicKey(fs.readFileSync(publicKeyPath)));
  if (signature.length !== 64 || !crypto.verify(null, message, key, signature)) {
    throw new Error('Ed25519 signature verification failed');
  }
}

module.exports = { publicKeyPemFromDer, signDetached, verifyDetached };
