'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { REPOSITORY_FILE_REDIRECTS } = require('./site-repository-links');

function checkSiteRepositoryLinks(directory) {
  const failures = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.endsWith('.html')) {
        const relative = path.relative(directory, file).split(path.sep).join('/');
        for (const [, href] of fs.readFileSync(file, 'utf8').matchAll(/\bhref=["']([^"']+)["']/g)) {
          if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(href)) continue;
          const uri = new URL(href, `https://www.egressview.com/${relative}`).pathname.replace(/^\/egressview\//, '/');
          if (REPOSITORY_FILE_REDIRECTS[uri]) failures.push(`${relative}: ${href}`);
        }
      }
    }
  }
  visit(directory);
  return failures;
}

if (require.main === module) {
  const failures = checkSiteRepositoryLinks(path.resolve(process.argv[2] || '_site'));
  if (failures.length) {
    console.error(`Unpublished repository links in the site:\n${failures.join('\n')}`);
    process.exitCode = 1;
  }
}

module.exports = { checkSiteRepositoryLinks };
