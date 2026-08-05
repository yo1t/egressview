'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const FORBIDDEN_NAMES = [
  /^\.git(?:\/|$)/,
  /^backlog\.md$/,
  /(?:^|\/)\.env(?:$|\.(?!example$|mcp\.example$|mcp-gate\.example$))/,
  /(?:^|\/)(?!\.egressview\.demo\.db$)[^/]*\.(?:db|sqlite)(?:-|$)/,
  /(?:^|\/)[^/]*\.log$/,
  /(?:^|\/)(?:id_rsa|id_ed25519)[^/]*$/,
  // Blocks key material, but not a public key: `*.pub.pem` is the published
  // release verification key and belongs in the tree. Naming alone is not
  // trusted -- SECRET_PATTERNS still scans every file for a PRIVATE KEY
  // header, so a private key renamed to `.pub.pem` is still rejected.
  /(?:^|\/)[^/]*\.key$/,
  /(?:^|\/)[^/]*(?<!\.pub)\.pem$/,
  /(?:^|\/)\.egressview-(?:backups|demo-runtime)(?:\/|$)/,
];

const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{36,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
  /\b(?:10\.41\.128|192\.168\.41)\.\d{1,3}\b/,
];

function normalizedRelative(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function listFiles(root) {
  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const relative = normalizedRelative(root, full);
      if (entry.isSymbolicLink()) {
        throw new Error(`Bundle must not contain symbolic links: ${relative}`);
      }
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) files.push(relative);
      else throw new Error(`Unsupported bundle entry: ${relative}`);
    }
  };
  visit(root);
  return files.sort();
}

function assertSafeRelativePath(value) {
  const normalized = String(value).replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) {
    throw new Error(`Unsafe bundle path: ${value}`);
  }
  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Unsafe bundle path: ${value}`);
  }
  return normalized;
}

function isForbiddenBundlePath(file) {
  return FORBIDDEN_NAMES.some((pattern) => pattern.test(String(file).replace(/\\/g, '/')));
}

function assertSafeBundle(root) {
  const files = listFiles(root);
  for (const file of files) {
    assertSafeRelativePath(file);
    if (isForbiddenBundlePath(file)) {
      throw new Error(`Forbidden runtime or credential file in bundle: ${file}`);
    }
    if (file.startsWith('app/node_modules/')) continue;
    const full = path.join(root, file);
    const stat = fs.statSync(full);
    if (stat.size > 2 * 1024 * 1024) continue;
    const content = fs.readFileSync(full);
    if (content.includes(0)) continue;
    const text = content.toString('utf8');
    if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
      throw new Error(`Potential credential or environment data in bundle: ${file}`);
    }
  }
  return files;
}

function sha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function createManifest(root, metadata) {
  const files = listFiles(root)
    .filter((file) => file !== 'manifest.json')
    .map((file) => ({
      path: file,
      bytes: fs.statSync(path.join(root, file)).size,
      sha256: sha256(path.join(root, file)),
    }));
  return {
    schemaVersion: 1,
    ...metadata,
    files,
  };
}

function verifyManifest(root, manifest) {
  if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) {
    throw new Error('Unsupported or malformed offline manifest');
  }
  const expected = new Map();
  for (const entry of manifest.files) {
    const relative = assertSafeRelativePath(entry.path);
    if (expected.has(relative)) throw new Error(`Duplicate manifest path: ${relative}`);
    expected.set(relative, entry);
  }
  const actual = listFiles(root).filter((file) => file !== 'manifest.json');
  if (actual.length !== expected.size) throw new Error('Offline manifest file count mismatch');
  for (const file of actual) {
    const entry = expected.get(file);
    if (!entry) throw new Error(`File is not declared in offline manifest: ${file}`);
    const full = path.join(root, file);
    if (fs.statSync(full).size !== entry.bytes || sha256(full) !== entry.sha256) {
      throw new Error(`Offline manifest verification failed: ${file}`);
    }
  }
}

module.exports = {
  assertSafeBundle,
  assertSafeRelativePath,
  createManifest,
  isForbiddenBundlePath,
  listFiles,
  sha256,
  verifyManifest,
};
