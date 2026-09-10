#!/usr/bin/env node
'use strict';

/**
 * Refuse a tracked symlink that points outside the repository.
 *
 * Symlinks are a normal thing to commit -- git stores them as mode 120000 --
 * and a relative one that stays inside the tree is portable and fine. The two
 * that are not fine are an absolute path, which is meaningless on any machine
 * but the one that made it, and a relative path that climbs out of the tree,
 * which makes a checkout able to reach files the repository does not contain.
 *
 * Written because `node_modules` was committed as a symlink to
 * `/Users/<someone>/projects/egressview/node_modules` on 2026-09-10 and sat in
 * a public repository for eight hours. `.gitignore` said `node_modules/`, and
 * the trailing slash matches directories only -- a symlink by that name is not
 * a directory. Nothing else looked: not the secret scan, not the offline
 * bundle check, not review.
 */

const path = require('node:path');
const { execFileSync } = require('node:child_process');

function trackedSymlinks() {
  // `ls-files -s` prints the mode; 120000 is a symlink. `-z` because a path
  // may contain anything a filesystem allows, including a newline.
  const out = execFileSync('git', ['ls-files', '-s', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\0').filter(Boolean).flatMap(entry => {
    const [meta, file] = entry.split('\t');
    return meta.startsWith('120000') ? [file] : [];
  });
}

function targetOf(file) {
  // The blob's content *is* the link target.
  return execFileSync('git', ['cat-file', 'blob', `:${file}`], { encoding: 'utf8' }).trim();
}

function problemWith(file, target) {
  if (path.isAbsolute(target)) return 'absolute path';
  const resolved = path.normalize(path.join(path.dirname(file), target));
  if (resolved.startsWith('..')) return 'points outside the repository';
  return null;
}

function main() {
  const offenders = [];
  for (const file of trackedSymlinks()) {
    const target = targetOf(file);
    const problem = problemWith(file, target);
    if (problem) offenders.push({ file, target, problem });
  }

  if (offenders.length) {
    process.stderr.write('Tracked symlinks that must not be committed:\n');
    for (const { file, target, problem } of offenders) {
      process.stderr.write(`  ${file} -> ${target}  (${problem})\n`);
    }
    process.stderr.write(
      '\nA committed symlink has to be relative and stay inside the tree. If this\n'
      + 'one is a stray from local work, remove it with `git rm --cached <path>`;\n'
      + 'that leaves whatever is on disk alone.\n'
    );
    process.exit(1);
  }

  const total = trackedSymlinks().length;
  process.stdout.write(`Tracked symlink check passed (${total} symlink(s), all relative and inside the tree).\n`);
}

main();
