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
  // dl has its own host and deployment. Do not publish a second download
  // site (including its robots/sitemap) under www/dl/.
  const downloadSource = path.join(output, 'dl');
  fs.rmSync(downloadSource, { recursive: true, force: true });
  fs.mkdirSync(downloadSource);
  fs.writeFileSync(path.join(downloadSource, 'index.html'), `---
layout: null
sitemap: false
permalink: /dl/
---
<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>EgressView Agent downloads</title>
<link rel="canonical" href="https://dl.egressview.com/">
<meta http-equiv="refresh" content="0; url=https://dl.egressview.com/">
</head><body><a href="https://dl.egressview.com/">Download EgressView Agent</a></body></html>
`);
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
  // README index pages inferred by a plugin were absent from the sitemap.
  // Declare the public index explicitly so Jekyll treats it as a real page.
  const docsIndex = path.join(output, 'docs', 'README.md');
  const indexBody = fs.readFileSync(docsIndex, 'utf8');
  if (!indexBody.startsWith('---\n')) {
    fs.writeFileSync(docsIndex, '---\nlayout: default\ntitle: EgressView documentation\npermalink: /docs/\n---\n' + indexBody);
  }
  return output;
}

if (require.main === module) {
  const output = preparePagesSource();
  console.log(`GitHub Pages source prepared: ${path.relative(repositoryRoot, output)}`);
}

module.exports = { preparePagesSource };
