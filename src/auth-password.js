// Password hashing for the single-admin login (P2-23).
// Uses Node's built-in scrypt — no external dependency.
'use strict';

const crypto = require('crypto');

const KEYLEN = 64;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 };  // interactive-login strength
const RECORD_VERSION = 1;

/**
 * Hash a password with a fresh random salt.
 * @returns {{ salt: string, hash: string, record: object }} hex-encoded
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, KEYLEN, SCRYPT_OPTS).toString('hex');
  return {
    salt,
    hash,
    record: {
      algorithm: 'scrypt',
      version: RECORD_VERSION,
      salt,
      hash,
      keylen: KEYLEN,
      ...SCRYPT_OPTS,
    },
  };
}

/**
 * Timing-safe verification against a stored salt+hash pair.
 */
function verifyPassword(password, saltOrRecord, legacyHash) {
  const record = typeof saltOrRecord === 'object' && saltOrRecord
    ? saltOrRecord
    : {
        algorithm: 'scrypt',
        salt: saltOrRecord,
        hash: legacyHash,
        keylen: KEYLEN,
        ...SCRYPT_OPTS,
      };
  if (record.algorithm !== 'scrypt') return false;
  const salt = record.salt;
  const hash = record.hash;
  if (!password || !salt || !hash) return false;
  try {
    const keylen = Number(record.keylen) || KEYLEN;
    const opts = {
      N: Number(record.N) || SCRYPT_OPTS.N,
      r: Number(record.r) || SCRYPT_OPTS.r,
      p: Number(record.p) || SCRYPT_OPTS.p,
    };
    const candidate = crypto.scryptSync(String(password), salt, keylen, opts);
    const stored    = Buffer.from(hash, 'hex');
    return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
  } catch {
    return false;
  }
}

function needsRehash(record) {
  return !record ||
    record.algorithm !== 'scrypt' ||
    record.version !== RECORD_VERSION ||
    record.keylen !== KEYLEN ||
    record.N !== SCRYPT_OPTS.N ||
    record.r !== SCRYPT_OPTS.r ||
    record.p !== SCRYPT_OPTS.p;
}

/**
 * Generate a readable initial password (no ambiguous characters),
 * printed once to the console on first startup.
 */
function generateInitialPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzACDEFHJKLMNPQRTUVWXY3479';
  const bytes = crypto.randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

module.exports = {
  generateInitialPassword,
  hashPassword,
  needsRehash,
  verifyPassword,
  RECORD_VERSION,
};
