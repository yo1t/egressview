'use strict';

const fs = require('node:fs');
const path = require('node:path');

const repositoryRoot = path.join(__dirname, '..');

function preparePagesSource({ rootDir = repositoryRoot, destination } = {}) {
  const root = path.resolve(rootDir);
  const output = path.resolve(destination || path.join(root, '.pages-source'));
  const protectedPaths = [root, path.join(root, 'site'), path.join(root, 'docs')];
  if (protectedPaths.includes(output)) {
    throw new Error(`Refusing to replace Pages source directory: ${output}`);
  }

  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  fs.cpSync(path.join(root, 'site'), output, { recursive: true });
  fs.cpSync(path.join(root, 'docs'), path.join(output, 'docs'), { recursive: true });
  return output;
}

if (require.main === module) {
  const output = preparePagesSource();
  console.log(`GitHub Pages source prepared: ${path.relative(repositoryRoot, output)}`);
}

module.exports = { preparePagesSource };
