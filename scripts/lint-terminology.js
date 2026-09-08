#!/usr/bin/env node
'use strict';

/**
 * Refuses a small list of names the glossary retired (P3-26).
 *
 * This check was recorded as done on 2026-08-14 and did not exist. Nothing
 * noticed for three weeks, because the thing that would have noticed was the
 * check itself -- the Hub's settings tab still said "Data Sources" the whole
 * time. A decision with no way to fail is a decision that quietly stops
 * applying.
 *
 * **Only fixed, unambiguous strings.** The glossary keeps `server` legitimate
 * for a Node process, an HTTP server, an authorization server and the MCP
 * server, so banning the word would produce a check people route around.
 * What is banned is the retired product-facing wording, and nothing else.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/** Retired wording, with what replaced it. */
const RETIRED = [
  { pattern: /\bData Sources\b/, use: 'Data Enrichment', why: 'the glossary renamed the enrichment settings' },
  { pattern: /データソース/, use: 'データ補完', why: '用語集で改名した' },
  { pattern: /\bEgressView Server\b/, use: 'EgressView Hub', why: 'the central side is the Hub' },
  { pattern: /\bEgressView サーバー?\b/, use: 'EgressView Hub', why: '中央側はHub' },
];

/**
 * Where user-facing wording lives. Deliberately narrow.
 *
 * CHANGELOG, backlog and past release notes are excluded: they record what was
 * true when written, and rewriting history to satisfy a lint would make the
 * record less honest rather than the product more consistent.
 */
const INCLUDE = [
  /^README(\.[a-z]{2})?\.md$/,
  /^docs\/.*\.md$/,
  /^public\/.*\.(html|js)$/,
  /^src\/data\/i18n\.json$/,
  /^site\/.*\.(html|md)$/,
  /^apps\/agent-macos\/README(\.[a-z]{2})?\.md$/,
];

const EXCLUDE = [
  /^CHANGELOG/,
  /^backlog\//,
  /^docs\/quality-report/,
  /node_modules\//,
];

function files() {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter(Boolean)
    .filter((file) => INCLUDE.some((rule) => rule.test(file)))
    .filter((file) => !EXCLUDE.some((rule) => rule.test(file)));
}

const findings = [];
for (const file of files()) {
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full) || fs.statSync(full).size > 4 * 1024 * 1024) continue;
  const lines = fs.readFileSync(full, 'utf8').split('\n');
  lines.forEach((line, index) => {
    for (const term of RETIRED) {
      if (term.pattern.test(line)) {
        findings.push({ file, line: index + 1, use: term.use, why: term.why, text: line.trim().slice(0, 100) });
      }
    }
  });
}

if (findings.length) {
  process.stderr.write('Retired wording found. The glossary is in backlog/specs/p3-26-product-naming.md.\n\n');
  for (const finding of findings) {
    process.stderr.write(`- ${finding.file}:${finding.line} — use "${finding.use}" (${finding.why})\n`);
    process.stderr.write(`  ${finding.text}\n`);
  }
  process.exit(1);
}
process.stdout.write(`Terminology check passed (${files().length} user-facing files).\n`);
