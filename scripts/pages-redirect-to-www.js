'use strict';

// Turns the GitHub Pages build into a set of pointers to www.egressview.com.
//
// The Pages copy served every document a second time, under yo1t.github.io,
// and each of those pages named itself as the original. A crawler that finds
// the same text on two hosts, one claiming to be canonical, has good reason
// to index neither of ours: on 2026-09-29 Search Console listed 28 of the
// site's pages as discovered but not indexed, and Googlebot had fetched only
// 32 of the 48 URLs in the sitemap in five weeks. The Pages build still runs
// on every pull request, so a change that breaks Jekyll is still caught;
// only what it publishes changes.

const fs = require('node:fs');
const path = require('node:path');

const SITE = 'https://www.egressview.com';

// Files that must stay as they are: a search-engine ownership check is read
// by the service, not by a person, and would fail if it moved.
function isKept(relative) {
  return /^google[0-9a-f]+\.html$/.test(path.basename(relative));
}

function targetFor(relative) {
  const posix = relative.split(path.sep).join('/');
  if (posix === '404.html') return `${SITE}/`;
  if (posix === 'index.html') return `${SITE}/`;
  if (posix.endsWith('/index.html')) return `${SITE}/${posix.slice(0, -'index.html'.length)}`;
  return `${SITE}/${posix}`;
}

function escapeAttribute(value) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function redirectPage(target) {
  const href = escapeAttribute(target);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>EgressView has moved to www.egressview.com</title>
<link rel="canonical" href="${href}">
<meta http-equiv="refresh" content="0; url=${href}">
</head>
<body>
<p>This page is at <a href="${href}">${href}</a>.</p>
</body>
</html>
`;
}

function walk(directory, root, found = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full, root, found);
    // Forward slashes on every platform: these are also the names reported back.
    else found.push(path.relative(root, full).split(path.sep).join('/'));
  }
  return found;
}

function redirectPagesToWww(siteDir) {
  const root = path.resolve(siteDir);
  const replaced = [];
  for (const relative of walk(root, root)) {
    const full = path.join(root, relative);
    // The sitemap lists this host's URLs; a sitemap of redirects only asks
    // crawlers to fetch them.
    if (relative === 'sitemap.xml') {
      fs.rmSync(full);
      continue;
    }
    if (!relative.endsWith('.html') || isKept(relative)) continue;
    fs.writeFileSync(full, redirectPage(targetFor(relative)));
    replaced.push(relative);
  }
  return replaced;
}

if (require.main === module) {
  const siteDir = process.argv[2] || '_site';
  const replaced = redirectPagesToWww(siteDir);
  if (replaced.length === 0) {
    console.error(`No HTML pages found under ${siteDir}`);
    process.exit(1);
  }
  console.log(`Pointed ${replaced.length} pages at ${SITE}`);
}

module.exports = { redirectPagesToWww, targetFor, redirectPage };
