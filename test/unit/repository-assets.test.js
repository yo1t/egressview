'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { preparePagesSource } = require('../../scripts/prepare-pages-source');

const root = path.join(__dirname, '..', '..');
const sourceFiles = ['README.md', 'README.ja.md', 'site/index.html', 'site/index.ja.html'];
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

function resolveLocalImage(file, reference) {
  const cleanReference = decodeURIComponent(reference.split(/[?#]/, 1)[0]);
  if (file.startsWith('site/')) return path.resolve(root, cleanReference);
  return path.resolve(root, path.dirname(file), cleanReference);
}

describe('repository public assets', () => {
  it('keeps every local image reference resolvable', () => {
    for (const file of sourceFiles) {
      for (const reference of localImageReferences(file)) {
        const resolved = resolveLocalImage(file, reference);
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

  it('keeps Pages source separate from application and package roots', () => {
    for (const file of ['index.html', 'index.ja.html', 'sitemap.xml', '_config.yml']) {
      assert(!fs.existsSync(path.join(root, file)), `${file} must remain under site/`);
      assert(fs.existsSync(path.join(root, 'site', file)), `site/${file} is missing`);
      assert(!packageJson.files.includes(file), `${file} must not be published in the runtime package`);
    }
  });

  it('assembles a self-contained Jekyll source without application files', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-pages-'));
    const output = path.join(tempDir, 'source');
    try {
      preparePagesSource({ rootDir: root, destination: output });
      for (const file of [
        'index.html',
        'index.ja.html',
        'sitemap.xml',
        '_config.yml',
        'docs/setup-yamaha.md',
        'docs/assets/egressview-graph-map.png',
      ]) {
        assert(fs.existsSync(path.join(output, file)), `Pages source is missing ${file}`);
      }
      assert(!fs.existsSync(path.join(output, 'public', 'index.html')));
      assert(!fs.existsSync(path.join(output, 'server.js')));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('pins every GitHub Pages action to an immutable commit', () => {
    const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'pages.yml'), 'utf8');
    const actionReferences = [...workflow.matchAll(/uses:\s+(actions\/[^@\s]+)@([^\s#]+)/g)];
    assert.equal(actionReferences.length, 5);
    for (const [, action, reference] of actionReferences) {
      assert.match(reference, /^[a-f0-9]{40}$/, `${action} must use a full commit SHA`);
    }
  });
});
