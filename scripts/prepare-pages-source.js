'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { rewriteRepositoryLinks } = require('./site-repository-links');

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
  // Rewrite only the build copy: repository-relative links must still work on
  // GitHub, while the website cannot serve files outside its docs/ source.
  function rewriteDocs(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) rewriteDocs(file);
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        const sourcePath = path.relative(output, file).split(path.sep).join('/');
        fs.writeFileSync(file, rewriteRepositoryLinks(fs.readFileSync(file, 'utf8'), sourcePath));
      }
    }
  }
  rewriteDocs(path.join(output, 'docs'));
  return output;
}

if (require.main === module) {
  const output = preparePagesSource();
  console.log(`GitHub Pages source prepared: ${path.relative(repositoryRoot, output)}`);
}

module.exports = { preparePagesSource };
