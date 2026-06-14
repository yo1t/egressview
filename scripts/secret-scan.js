#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SKIP_EXTENSIONS = new Set([
  '.db',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.mov',
  '.mp4',
  '.pdf',
  '.png',
  '.sqlite',
  '.webp',
]);
const SKIP_PATH = /^(?:\.ash|\.git|node_modules|playwright-report|test-results)\//;

const checks = [
  {
    name: 'private key',
    pattern: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/gi,
  },
  {
    name: 'AWS access key',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    name: 'GitHub token',
    pattern: /\bgh[pousr]_[A-Za-z0-9_]{36,}\b/g,
  },
  {
    name: 'Slack token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
  },
  {
    name: 'OpenAI API key',
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    name: 'environment-specific LAN IP',
    pattern: /\b(?:10\.41\.128|192\.168\.41)\.\d{1,3}\b/g,
  },
];

function extensionOf(file) {
  const dot = file.lastIndexOf('.');
  return dot === -1 ? '' : file.slice(dot).toLowerCase();
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

function isBinary(buffer) {
  return buffer.includes(0);
}

function trackedFiles() {
  return execFileSync('git', ['ls-files'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter(file => !SKIP_PATH.test(file))
    .filter(file => !SKIP_EXTENSIONS.has(extensionOf(file)));
}

const findings = [];

for (const file of trackedFiles()) {
  if (!fs.existsSync(file)) continue;
  const stats = fs.statSync(file);
  if (!stats.isFile() || stats.size > MAX_FILE_BYTES) continue;

  const buffer = fs.readFileSync(file);
  if (isBinary(buffer)) continue;

  const text = buffer.toString('utf8');
  for (const check of checks) {
    check.pattern.lastIndex = 0;
    let match;
    while ((match = check.pattern.exec(text)) !== null) {
      findings.push({
        file,
        line: lineOf(text, match.index),
        name: check.name,
        match: match[0],
      });
    }
  }
}

if (findings.length > 0) {
  console.error('Secret scan failed. Potential sensitive values found:\n');
  for (const finding of findings) {
    const value =
      finding.match.length > 40
        ? `${finding.match.slice(0, 16)}...${finding.match.slice(-8)}`
        : finding.match;
    console.error(`- ${finding.file}:${finding.line} [${finding.name}] ${value}`);
  }
  console.error('\nUse documentation-safe examples or remove the value before publishing.');
  process.exit(1);
}

console.log('Secret scan passed: no high-signal secrets or environment-specific LAN IPs found.');
