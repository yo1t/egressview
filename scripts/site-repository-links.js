'use strict';

// These repository files are linked from docs, but are not published by Jekyll.
// Keep old crawler URLs and newly generated links pointed at the same content.
const REPOSITORY_FILE_REDIRECTS = Object.fromEntries([
  'README.md',
  'README.ja.md',
  'ROADMAP.md',
  'ROADMAP.ja.md',
  'apps/agent-macos/README.md',
  'apps/agent-macos/README.ja.md',
  'apps/agent-windows/README.en.md',
  'apps/agent-windows/README.md',
  'release-signing/trusted-fingerprints.json',
].map(file => [
  `/${file}`,
  file.endsWith('.json')
    ? `https://raw.githubusercontent.com/yo1t/egressview/main/${file}`
    : `https://github.com/yo1t/egressview/blob/main/${file}`,
]));

function rewriteRepositoryLinks(markdown, sourcePath) {
  const base = new URL(sourcePath, 'https://www.egressview.com/');
  return markdown.replace(/(\]\(<?)([^\s)>]+)(>?)/g, (match, prefix, href, suffix) => {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(href)) return match;
    const url = new URL(href, base);
    const target = REPOSITORY_FILE_REDIRECTS[url.pathname];
    return target ? `${prefix}${target}${url.search}${url.hash}${suffix}` : match;
  });
}

module.exports = { REPOSITORY_FILE_REDIRECTS, rewriteRepositoryLinks };
