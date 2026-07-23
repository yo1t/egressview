'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROUTES_DIR = path.join(__dirname, '../../src/routes');
const ENDPOINT_MODULES = [
  'ai-notifications.js',
  'ai.js',
  'auth-sessions.js',
  'auth-security.js',
  'backup.js',
  'beacons.js',
  'config.js',
  'connections.js',
  'devices.js',
  'manual-threat.js',
  'notes.js',
  'notification-log.js',
  'router-setup.js',
  'routers.js',
  'slack.js',
];

describe('HTTP route validation coverage', () => {
  it('keeps every endpoint-bearing route module on the shared zod boundary', () => {
    for (const file of ENDPOINT_MODULES) {
      const source = fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8');
      assert.match(source, /require\(['"]zod['"]\)/, `${file} must import zod`);
      assert.match(source, /parseRequest\(/, `${file} must validate request input`);
    }
  });

  it('keeps the endpoint module inventory synchronized with the route directory', () => {
    const actual = fs.readdirSync(ROUTES_DIR)
      .filter(file => file.endsWith('.js') && file !== 'auth.js')
      .filter(file => /router\.(?:get|post|put|delete|patch)\(/.test(
        fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8')
      ))
      .sort();
    assert.deepEqual(actual, [...ENDPOINT_MODULES].sort());
  });
});
