'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const sourceFiles = ['README.md', 'README.ja.md', 'index.html', 'index.ja.html'];
const packageJson = require('../../package.json');

function localImageReferences(file) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const references = [];
  const patterns = [
    /!\[[^\]]*\]\((?!https?:\/\/)([^)\s]+)(?:\s+['"][^'"]*['"])?\)/g,
    /<img\b[^>]*\bsrc=["'](?!https?:\/\/)([^"']+)["']/gi,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) references.push(match[1]);
  }
  return references;
}

function rawGitHubImageReferences(file) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const references = [];
  const pattern = /https:\/\/raw\.githubusercontent\.com\/yo1t\/egressview\/main\/([^"'\s)]+)/g;
  let match;
  while ((match = pattern.exec(source)) !== null) references.push(match[1]);
  return references;
}

describe('repository public assets', () => {
  it('keeps every local image reference resolvable', () => {
    for (const file of sourceFiles) {
      for (const reference of localImageReferences(file)) {
        const cleanReference = decodeURIComponent(reference.split(/[?#]/, 1)[0]);
        const resolved = path.resolve(root, path.dirname(file), cleanReference);
        assert(resolved.startsWith(root + path.sep), `${file} references an image outside the repository: ${reference}`);
        assert(fs.existsSync(resolved), `${file} references a missing image: ${reference}`);
      }
    }
  });

  it('keeps raw GitHub social images aligned with repository files', () => {
    for (const file of sourceFiles) {
      for (const reference of rawGitHubImageReferences(file)) {
        assert(fs.existsSync(path.join(root, reference)), `${file} references a missing raw GitHub image: ${reference}`);
      }
    }
  });

  it('stores published screenshots under docs/assets', () => {
    const rootImages = fs.readdirSync(path.join(root, 'docs'))
      .filter(file => /\.(?:png|jpe?g|gif|webp)$/i.test(file));
    assert.deepEqual(rootImages, []);
    assert(packageJson.files.includes('docs/assets/*.png'));
    assert(!packageJson.files.includes('docs/*.png'));
  });
});
