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
  if (!options['private-key'] && options.unsigned !== 'true') {
    throw new Error('--private-key is required unless --unsigned true is explicitly used');
  }
  return options;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: ROOT,
    encoding: options.encoding || 'utf8',
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' },
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
    run('tar', ['-czf', artifact, '-C', work, rootName]);
    const checksum = path.join(outputDir, `${artifactName}.sha256`);
    fs.writeFileSync(checksum, `${sha256(artifact)}  ${artifactName}\n`, { mode: 0o644 });

    const result = { artifact, checksum, signature: null, publicKey: null };
    if (options['private-key']) {
      const privateKey = path.resolve(options['private-key']);
      const signature = `${artifact}.sig`;
      const publicKey = `${artifact}.pub.pem`;
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
