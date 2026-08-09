'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const ROOT = path.resolve(__dirname, '../..');

describe('public demo image', () => {
  it('enables read-only mode in the image instead of relying on Fly configuration', () => {
    const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile.demo'), 'utf8');
    assert.match(dockerfile, /ENV\s+DEMO_MODE=true\s+\\\s*DEMO_READ_ONLY=true\s+\\/);
  });
});
