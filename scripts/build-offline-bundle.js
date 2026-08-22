#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  assertSafeBundle,
  createManifest,
  sha256,
} = require('./offline-bundle-lib');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--') || i + 1 >= argv.length) throw new Error(`Invalid argument: ${key}`);
    options[key.slice(2)] = argv[++i];
  }
  if (!options.output) throw new Error('--output is required');
  const signers = ['private-key', 'kms-key-id'].filter(name => options[name]);
  if (signers.length > 1) {
    throw new Error('--private-key and --kms-key-id are mutually exclusive');
  }
  if (signers.length === 0 && options.unsigned !== 'true') {
    throw new Error(
      '--private-key or --kms-key-id is required unless --unsigned true is explicitly used'
    );
  }
  return options;
}

// KMS caps a RAW message at 4096 bytes. The checksum file is one line, but
// check rather than assume: exceeding it fails inside AWS with an error that
// does not name the cause.
const KMS_MAX_RAW_MESSAGE_BYTES = 4096;

/**
 * Sign the checksum file with an asymmetric KMS key and write the detached
 * signature plus the public key beside the artifact.
 *
 * The signature is byte-identical in form to the openssl path: raw Ed25519
 * over the checksum file. Verification therefore stays `openssl pkeyutl
 * -verify -rawin -pubin` and needs neither AWS access nor a code change, which
 * is the reason KMS was chosen over a scheme that changes the verifier.
 */
function signWithKms(keyId, region, checksumPath, signaturePath, publicKeyPath) {
  const size = fs.statSync(checksumPath).size;
  if (size > KMS_MAX_RAW_MESSAGE_BYTES) {
    throw new Error(
      `Checksum file is ${size} bytes, above the KMS RAW limit of ${KMS_MAX_RAW_MESSAGE_BYTES}`
    );
  }
  const regionArgs = region ? ['--region', region] : [];

  const signature = run('aws', [
    'kms', 'sign', ...regionArgs,
    '--key-id', keyId,
    '--message', `fileb://${path.resolve(checksumPath)}`,
    '--message-type', 'RAW',
    '--signing-algorithm', 'ED25519_SHA_512',
    '--query', 'Signature', '--output', 'text',
  ]).trim();
  fs.writeFileSync(signaturePath, Buffer.from(signature, 'base64'), { mode: 0o644 });

  // KMS returns SPKI DER; ship PEM so the documented verification command
  // works unchanged for anyone who does not have the AWS CLI.
  const publicDer = run('aws', [
    'kms', 'get-public-key', ...regionArgs,
    '--key-id', keyId,
    '--query', 'PublicKey', '--output', 'text',
  ]).trim();
  const derPath = `${publicKeyPath}.der`;
  fs.writeFileSync(derPath, Buffer.from(publicDer, 'base64'), { mode: 0o600 });
  try {
    run('openssl', ['pkey', '-pubin', '-inform', 'DER', '-in', derPath, '-out', publicKeyPath]);
  } finally {
    fs.rmSync(derPath, { force: true });
  }
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: ROOT,
    encoding: options.encoding || 'utf8',
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
    env: {
      ...(options.env || process.env),
      npm_config_audit: 'false',
      npm_config_fund: 'false',
    },
  });
}

function build(options) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  const outputDir = path.resolve(options.output);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-offline-build-'));
  const releaseId = packageJson.version;
  const rootName = `egressview-offline-${releaseId}`;
  const bundleRoot = path.join(work, rootName);
  const appRoot = path.join(bundleRoot, 'app');
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o755 });

  try {
    const packJson = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', work]));
    const packageTar = path.join(work, packJson[0].filename);
    fs.mkdirSync(bundleRoot);
    run('tar', ['-xzf', packageTar, '-C', bundleRoot]);
    fs.renameSync(path.join(bundleRoot, 'package'), appRoot);
    fs.copyFileSync(path.join(ROOT, 'package-lock.json'), path.join(appRoot, 'package-lock.json'));

    const sbom = execFileSync('npm', [
      'sbom',
      '--package-lock-only',
      '--omit=dev',
      '--sbom-format=cyclonedx',
      '--sbom-type=application',
    ], { cwd: appRoot, encoding: 'utf8' });
    fs.writeFileSync(path.join(bundleRoot, 'sbom.cdx.json'), sbom, { mode: 0o644 });
    fs.copyFileSync(path.join(ROOT, 'scripts/offline-install.js'), path.join(bundleRoot, 'offline-install.js'));
    fs.copyFileSync(
      path.join(ROOT, 'scripts/offline-bundle-lib.js'),
      path.join(bundleRoot, 'offline-bundle-lib.js')
    );

    assertSafeBundle(bundleRoot);
    const manifest = createManifest(bundleRoot, {
      name: packageJson.name,
      version: packageJson.version,
      releaseId,
      platform: 'any',
      arch: 'any',
      nodeRequirement: packageJson.engines.node,
      installRequiresInternet: true,
      dependencyLockSha256: sha256(path.join(ROOT, 'package-lock.json')),
    });
    fs.writeFileSync(
      path.join(bundleRoot, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o644 }
    );

    const artifactName = `${rootName}.tar.gz`;
    const artifact = path.join(outputDir, artifactName);
    // Built on whatever host a maintainer happens to use, extracted on the
    // Linux host that will run the Hub. macOS stores extended attributes that
    // bsdtar writes into the archive and GNU tar refuses, exiting non-zero on
    // extraction -- so a bundle built on a Mac fails to unpack where it is
    // meant to be installed. Neither the xattrs nor AppleDouble sidecars are
    // part of what is being distributed.
    run('tar', ['--no-xattrs', '-czf', artifact, '-C', work, rootName], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    const checksum = path.join(outputDir, `${artifactName}.sha256`);
    fs.writeFileSync(checksum, `${sha256(artifact)}  ${artifactName}\n`, { mode: 0o644 });

    const result = { artifact, checksum, signature: null, publicKey: null };
    const signature = `${artifact}.sig`;
    const publicKey = `${artifact}.pub.pem`;
    if (options['kms-key-id']) {
      signWithKms(options['kms-key-id'], options.region, checksum, signature, publicKey);
      result.signature = signature;
      result.publicKey = publicKey;
    } else if (options['private-key']) {
      const privateKey = path.resolve(options['private-key']);
      run('openssl', ['pkeyutl', '-sign', '-rawin', '-inkey', privateKey, '-in', checksum, '-out', signature]);
      run('openssl', ['pkey', '-in', privateKey, '-pubout', '-out', publicKey]);
      result.signature = signature;
      result.publicKey = publicKey;
    }
    return result;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    const result = build(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`Offline bundle build failed: ${error.message}\n`);
    process.exit(1);
  }
}

module.exports = { build, parseArgs };
