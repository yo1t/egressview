#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

function fingerprintPublicKey(pem) {
  const serialized = Buffer.isBuffer(pem) ? pem.toString('utf8') : typeof pem === 'string' ? pem : '';
  if (pem?.type === 'private' || /-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----/.test(serialized)) {
    throw new Error('Refusing a private key; export and inspect the public key instead');
  }
  const key = pem?.type === 'public' ? pem : crypto.createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(`Expected an Ed25519 public key, received ${key.asymmetricKeyType || 'unknown'}`);
  }
  const der = key.export({ type: 'spki', format: 'der' });
  return `SHA256:${crypto.createHash('sha256').update(der).digest('hex')}`;
}

function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1) {
    throw new Error('Usage: node scripts/release-key-fingerprint.js PUBLIC_KEY.pem');
  }
  process.stdout.write(`${fingerprintPublicKey(fs.readFileSync(argv[0]))}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { fingerprintPublicKey };
