'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');

describe('third-party notices', () => {
  it('ships notices for every vendored browser asset', () => {
    const notice = fs.readFileSync(path.join(root, 'public/THIRD_PARTY_NOTICES.txt'), 'utf8');
    assert.match(notice, /D3\.js 7\.9\.0/);
    assert.match(notice, /TopoJSON Client 3\.1\.0/);
    assert.match(notice, /World Atlas 2\.0\.2 \/ Natural Earth/);
    assert.match(notice, /Permission to use, copy, modify/);
  });

  it('includes the canonical notice in the npm package allowlist', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.ok(pkg.files.includes('THIRD_PARTY_NOTICES.md'));
    assert.ok(pkg.files.includes('public/'));
  });
});
