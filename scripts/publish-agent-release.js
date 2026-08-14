#!/usr/bin/env node
'use strict';

/**
 * Publish an agent package and its signed update manifest (P3-24).
 *
 * The manifest is what every installed agent polls, so the ordering here is
 * the whole point: the package is uploaded first and the manifest last. An
 * agent that reads the manifest mid-publication must never be pointed at an
 * object that is not there yet.
 *
 * Signing follows the offline-bundle convention exactly -- a detached raw
 * Ed25519 signature produced by KMS over the literal manifest bytes. The
 * agent, and anyone else, verifies with `openssl pkeyutl -verify -rawin`
 * against the published release key. Nothing about verification needs AWS
 * access.
 *
 * The signature is detached rather than embedded because an embedded field
 * would force the agent to re-serialise the JSON byte-for-byte before
 * checking it. Signing the exact bytes that are served removes that class of
 * bug.
 */

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MANIFEST_SCHEMA_VERSION = 1;
const KMS_MAX_RAW_MESSAGE_BYTES = 4096;
// Long enough to outlast the manifest cache TTL, so a publication without an
// invalidation still verifies rather than reporting a false failure.
const VERIFY_ATTEMPTS = 12;
const VERIFY_DELAY_MS = 30_000;
const PLATFORMS = ['macos', 'windows', 'linux'];
const ARCHES = ['arm64', 'x64'];
const PACKAGE_TYPES = { '.dmg': 'dmg', '.msi': 'msi', '.exe': 'exe', '.deb': 'deb', '.rpm': 'rpm' };
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
  });
}

function parseArgs(argv) {
  const options = { packages: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (!flag.startsWith('--') || i + 1 >= argv.length) {
      throw new Error(`Invalid argument: ${flag}`);
    }
    const value = argv[++i];
    if (flag === '--package') {
      const match = /^([A-Za-z0-9_]+)=(.+)$/.exec(value);
      if (!match) throw new Error('--package must be given as <arch>=<path>');
      options.packages.push({ arch: match[1], file: path.resolve(value.slice(match[1].length + 1)) });
      continue;
    }
    options[flag.slice(2)] = value;
  }

  const config = {
    platform: options.platform,
    version: options.version,
    packages: options.packages,
    baseUrl: options['base-url'] || 'https://dl.egressview.com',
    // Read-back origin, which is not always the origin agents use. Before the
    // public name is published there is no other way to prove the object is
    // really being served.
    verifyOrigin: options['verify-origin'] || options['base-url'] || 'https://dl.egressview.com',
    bucket: options.bucket,
    distributionId: options['distribution-id'],
    keyId: options['key-id'] || 'alias/egressview-release',
    region: options.region || 'ap-northeast-1',
    profile: options.profile,
    output: options.output ? path.resolve(options.output) : null,
    dryRun: Boolean(options.dryRun),
  };

  const problems = [];
  if (!PLATFORMS.includes(config.platform)) {
    problems.push(`--platform must be one of ${PLATFORMS.join(', ')}`);
  }
  if (!SEMVER.test(String(config.version || ''))) {
    problems.push('--version must be a semantic version');
  }
  if (!config.packages.length) problems.push('at least one --package <arch>=<path> is required');
  for (const entry of config.packages) {
    if (!ARCHES.includes(entry.arch)) problems.push(`unsupported --package arch: ${entry.arch}`);
    if (!fs.existsSync(entry.file)) problems.push(`package not found: ${entry.file}`);
    if (!PACKAGE_TYPES[path.extname(entry.file).toLowerCase()]) {
      problems.push(`unsupported package type: ${path.basename(entry.file)}`);
    }
  }
  const arches = config.packages.map((entry) => entry.arch);
  if (new Set(arches).size !== arches.length) problems.push('duplicate --package arch');
  for (const [name, value] of [['--base-url', config.baseUrl], ['--verify-origin', config.verifyOrigin]]) {
    // Agents follow this URL to download an executable. Plaintext is not an
    // option even though the package is separately signed and hashed.
    if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(value)) {
      problems.push(`${name} must be an https origin without a path`);
    }
  }
  if (!config.dryRun && !config.bucket) {
    problems.push('--bucket is required unless --dry-run is given');
  }
  if (problems.length) throw new Error(problems.join('\n- '));
  return config;
}

/**
 * The manifest holds a list of packages rather than a single URL. macOS ships
 * one architecture today, but Windows will need x64 and arm64, and a shape
 * that assumes one package per platform would have to change after agents are
 * already reading it.
 */
function buildManifest(config, now = new Date()) {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    platform: config.platform,
    version: config.version,
    releasedAt: now.toISOString(),
    packages: config.packages.map((entry) => {
      const name = path.basename(entry.file);
      return {
        arch: entry.arch,
        packageType: PACKAGE_TYPES[path.extname(entry.file).toLowerCase()],
        url: `${config.baseUrl}/${config.platform}/${name}`,
        sha256: sha256(entry.file),
        sizeBytes: fs.statSync(entry.file).size,
      };
    }),
  };
}

function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function awsArgs(config, args) {
  return [
    ...args,
    ...(config.region ? ['--region', config.region] : []),
    ...(config.profile ? ['--profile', config.profile] : []),
  ];
}

function signManifest(config, manifestPath, signaturePath) {
  const size = fs.statSync(manifestPath).size;
  if (size > KMS_MAX_RAW_MESSAGE_BYTES) {
    throw new Error(`Manifest is ${size} bytes, above the KMS RAW limit of ${KMS_MAX_RAW_MESSAGE_BYTES}`);
  }
  const signature = run('aws', awsArgs(config, [
    'kms', 'sign',
    '--key-id', config.keyId,
    '--message', `fileb://${manifestPath}`,
    '--message-type', 'RAW',
    '--signing-algorithm', 'ED25519_SHA_512',
    '--query', 'Signature', '--output', 'text',
  ])).trim();
  fs.writeFileSync(signaturePath, Buffer.from(signature, 'base64'), { mode: 0o644 });
}

function publicKeyPem(config, destination) {
  const der = run('aws', awsArgs(config, [
    'kms', 'get-public-key',
    '--key-id', config.keyId,
    '--query', 'PublicKey', '--output', 'text',
  ])).trim();
  const derPath = `${destination}.der`;
  fs.writeFileSync(derPath, Buffer.from(der, 'base64'), { mode: 0o600 });
  try {
    run('openssl', ['pkey', '-pubin', '-inform', 'DER', '-in', derPath, '-out', destination]);
  } finally {
    fs.rmSync(derPath, { force: true });
  }
  return destination;
}

/**
 * Verify before uploading, with the same command the agent will use. A
 * manifest that cannot be verified must never reach the bucket -- once it is
 * served, every agent that fetches it rejects the update and there is no way
 * to tell them to look again sooner.
 */
function verifySignature(manifestPath, signaturePath, publicKeyPath) {
  run('openssl', [
    'pkeyutl', '-verify', '-rawin', '-pubin',
    '-inkey', publicKeyPath,
    '-sigfile', signaturePath,
    '-in', manifestPath,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
}

function upload(config, file, key, cacheControl, contentType) {
  run('aws', awsArgs(config, [
    's3', 'cp', file, `s3://${config.bucket}/${key}`,
    '--cache-control', cacheControl,
    '--content-type', contentType,
    '--no-progress',
  ]));
}

/**
 * Read back what CloudFront actually serves. Retried because both an
 * invalidation and an expiring cache entry take time: a mismatch in the first
 * seconds means "not yet", and only a mismatch that outlives the manifest TTL
 * means the publication is wrong.
 */
async function verifyPublished(config, manifestBytes, io = {}) {
  const url = `${config.verifyOrigin}/${config.platform}/manifest.json`;
  const sleep = io.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let last = 'no attempt was made';
  for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const served = Buffer.from(await response.arrayBuffer());
      if (served.equals(manifestBytes)) return;
      last = 'the served manifest differs from the one just published';
    } catch (error) {
      last = error.message;
    }
    if (attempt < VERIFY_ATTEMPTS) await sleep(VERIFY_DELAY_MS);
  }
  throw new Error(`${url} did not converge on the published manifest: ${last}`);
}

async function publish(config, io = {}) {
  const log = io.log || ((message) => process.stdout.write(`${message}\n`));
  const work = config.output || fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-agent-release-'));
  fs.mkdirSync(work, { recursive: true });
  const manifestPath = path.join(work, 'manifest.json');
  const signaturePath = path.join(work, 'manifest.json.sig');

  const manifest = buildManifest(config);
  const manifestBytes = Buffer.from(serializeManifest(manifest), 'utf8');
  fs.writeFileSync(manifestPath, manifestBytes, { mode: 0o644 });
  for (const entry of manifest.packages) {
    log(`${entry.arch}  ${entry.sha256}  ${path.basename(entry.url)}`);
  }

  if (config.dryRun) {
    log(`Dry run: wrote ${manifestPath} (unsigned, not uploaded)`);
    return { manifest, manifestPath, published: false };
  }

  signManifest(config, manifestPath, signaturePath);
  const publicKeyPath = publicKeyPem(config, path.join(work, 'release-key.pem'));
  verifySignature(manifestPath, signaturePath, publicKeyPath);
  log('Signature verified locally before upload');

  // Packages first, manifest last: an agent reading the manifest mid-publish
  // must never find a URL that 404s.
  for (const entry of config.packages) {
    upload(
      config,
      entry.file,
      `${config.platform}/${path.basename(entry.file)}`,
      'public, max-age=31536000, immutable',
      'application/octet-stream'
    );
  }
  upload(config, signaturePath, `${config.platform}/manifest.json.sig`,
    'public, max-age=300', 'application/octet-stream');
  upload(config, manifestPath, `${config.platform}/manifest.json`,
    'public, max-age=300', 'application/json');

  // Without an invalidation the new manifest still appears, but only after the
  // cached copy expires. That is a delay, not a failure, so a signing
  // principal without CloudFront rights can still publish.
  if (config.distributionId) {
    run('aws', awsArgs(config, [
      'cloudfront', 'create-invalidation',
      '--distribution-id', config.distributionId,
      '--paths', `/${config.platform}/manifest.json`, `/${config.platform}/manifest.json.sig`,
      '--query', 'Invalidation.Id', '--output', 'text',
    ]));
  } else {
    log('No --distribution-id: skipping invalidation, waiting for the manifest TTL instead');
  }

  await verifyPublished(config, manifestBytes, io);
  log(`Published ${config.platform} ${config.version} to ${config.baseUrl}/${config.platform}/`);
  return { manifest, manifestPath, signaturePath, published: true };
}

if (require.main === module) {
  (async () => {
    try {
      await publish(parseArgs(process.argv.slice(2)));
    } catch (error) {
      process.stderr.write(`Agent release publication failed:\n- ${error.message}\n`);
      process.exit(1);
    }
  })();
}

module.exports = {
  parseArgs,
  buildManifest,
  serializeManifest,
  MANIFEST_SCHEMA_VERSION,
};
