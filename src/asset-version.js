'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * A version for the browser assets taken from their content: everything under
 * public/ plus the translation catalogue served as js/i18n-data.js. A restart
 * that changes nothing keeps the version, so open pages are not told to
 * reload and browsers keep their cached scripts; a deploy that changes any of
 * them gets a new one.
 */
function computeAssetVersion(appRoot) {
  const hash = crypto.createHash('sha256');
  const publicDir = path.join(appRoot, 'public');
  const files = listFiles(publicDir)
    .map(file => [path.relative(appRoot, file).split(path.sep).join('/'), file])
    .concat([['src/data/i18n.json', path.join(appRoot, 'src', 'data', 'i18n.json')]])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [name, file] of files) {
    const content = fs.readFileSync(file);
    hash.update(`${name}\0${content.length}\0`);
    hash.update(content);
  }
  return hash.digest('hex').slice(0, 16);
}

module.exports = { computeAssetVersion };
