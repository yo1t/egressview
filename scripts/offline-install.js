#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {
  assertSafeBundle,
  sha256,
  verifyManifest,
} = require('./offline-bundle-lib');

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    if (!rest[i].startsWith('--') || i + 1 >= rest.length) {
      throw new Error(`Invalid argument: ${rest[i] || ''}`);
    }
    options[rest[i].slice(2)] = rest[++i];
  }
  if (!['install', 'upgrade', 'rollback', 'status'].includes(command)) {
    throw new Error('Command must be install, upgrade, rollback, or status');
  }
  if (!options.prefix) throw new Error('--prefix is required');
  return { command, prefix: path.resolve(options.prefix) };
}

function readManifest(bundleRoot) {
  const manifestPath = path.join(bundleRoot, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  verifyManifest(bundleRoot, manifest);
  assertSafeBundle(bundleRoot);
  if (!/^[A-Za-z0-9._-]+$/.test(manifest.releaseId || '')) {
    throw new Error('Offline manifest has an invalid releaseId');
  }
  if (manifest.dependencyLockSha256) {
    const lock = path.join(bundleRoot, 'app', 'package-lock.json');
    if (!fs.existsSync(lock) || sha256(lock) !== manifest.dependencyLockSha256) {
      throw new Error('Offline dependency lock does not match the manifest');
    }
  }
  return manifest;
}

function assertNodeRequirement(requirement, version = process.versions.node) {
  if (!requirement) return;
  const match = /^>=(\d+)$/.exec(requirement);
  if (!match) throw new Error(`Unsupported Node.js requirement: ${requirement}`);
  const actualMajor = Number.parseInt(String(version).split('.')[0], 10);
  if (!Number.isInteger(actualMajor) || actualMajor < Number(match[1])) {
    throw new Error(`Node.js ${requirement} is required; found ${version}`);
  }
}

function readManagedLink(prefix, name) {
  const link = path.join(prefix, name);
  try {
    const target = fs.readlinkSync(link);
    const resolved = path.resolve(prefix, target);
    const releases = path.join(prefix, 'releases') + path.sep;
    if (!resolved.startsWith(releases)) throw new Error(`${name} points outside the release directory`);
    return target;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function replaceLink(prefix, name, target) {
  const destination = path.join(prefix, name);
  const temporary = path.join(prefix, `.${name}-${process.pid}-${Date.now()}`);
  fs.symlinkSync(target, temporary);
  fs.renameSync(temporary, destination);
}

function installProductionDependencies(releaseDir) {
  execFileSync('npm', ['ci', '--omit=dev'], {
    cwd: releaseDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      npm_config_audit: 'false',
      npm_config_fund: 'false',
    },
  });
  execFileSync(process.execPath, [
    '-e',
    "const Database=require('better-sqlite3');const db=new Database(':memory:');db.close()",
  ], { cwd: releaseDir, stdio: 'ignore' });
}

function installRelease({
  bundleRoot,
  prefix,
  installDependencies = true,
  dependencyInstaller = installProductionDependencies,
}) {
  const manifest = readManifest(bundleRoot);
  assertNodeRequirement(manifest.nodeRequirement);
  const releasesDir = path.join(prefix, 'releases');
  const releaseDir = path.join(releasesDir, manifest.releaseId);
  fs.mkdirSync(releasesDir, { recursive: true, mode: 0o755 });

  if (!fs.existsSync(releaseDir)) {
    const temporary = `${releaseDir}.install-${process.pid}`;
    fs.rmSync(temporary, { recursive: true, force: true });
    try {
      fs.cpSync(path.join(bundleRoot, 'app'), temporary, {
        recursive: true,
        errorOnExist: true,
      });
      if (installDependencies) dependencyInstaller(temporary);
      fs.writeFileSync(path.join(temporary, '.offline-release.json'), `${JSON.stringify({
        releaseId: manifest.releaseId,
        version: manifest.version,
        platform: manifest.platform,
        arch: manifest.arch,
      }, null, 2)}\n`, { mode: 0o644 });
      fs.renameSync(temporary, releaseDir);
    } catch (error) {
      fs.rmSync(temporary, { recursive: true, force: true });
      throw error;
    }
  }

  const toolsDir = path.join(prefix, 'tools');
  fs.mkdirSync(toolsDir, { recursive: true, mode: 0o755 });
  for (const name of ['offline-install.js', 'offline-bundle-lib.js']) {
    const source = path.join(bundleRoot, name);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(toolsDir, name));
  }

  const target = path.relative(prefix, releaseDir);
  const current = readManagedLink(prefix, 'current');
  if (current && current !== target) replaceLink(prefix, 'previous', current);
  if (current !== target) replaceLink(prefix, 'current', target);
  return { current: target, previous: readManagedLink(prefix, 'previous') };
}

function rollback(prefix) {
  const current = readManagedLink(prefix, 'current');
  const previous = readManagedLink(prefix, 'previous');
  if (!current || !previous) throw new Error('Rollback requires both current and previous releases');
  if (!fs.existsSync(path.resolve(prefix, current))
      || !fs.existsSync(path.resolve(prefix, previous))) {
    throw new Error('Rollback release target is missing');
  }
  replaceLink(prefix, 'current', previous);
  replaceLink(prefix, 'previous', current);
  return { current: previous, previous: current };
}

function status(prefix) {
  return {
    current: readManagedLink(prefix, 'current'),
    previous: readManagedLink(prefix, 'previous'),
  };
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    let result;
    if (args.command === 'rollback') result = rollback(args.prefix);
    else if (args.command === 'status') result = status(args.prefix);
    else result = installRelease({ bundleRoot: __dirname, prefix: args.prefix });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`Offline installation failed: ${error.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  assertNodeRequirement,
  installProductionDependencies,
  installRelease,
  parseArgs,
  readManifest,
  rollback,
  status,
};
