'use strict';

// P2-102: the extension used to find its XPC client by process ID and check
// the signature of the file on disk. A process can connect and then exec the
// signed app under the same ID, and the check would be made against what it
// became. The requirement is now set on the connection, which the system
// checks against the connecting process's audit token.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', '..',
  'apps/agent-macos/Xcode/SystemExtension/FullMonitoringXPCServer.swift'), 'utf8');

test('XPCの相手は、接続に付けた署名の要件で確かめる', () => {
  const accept = server.slice(server.indexOf('shouldAcceptNewConnection'), server.indexOf('private func hostRequirement'));
  assert.match(accept, /newConnection\.setCodeSigningRequirement\(requirement\)/);
  assert.ok(accept.indexOf('setCodeSigningRequirement') < accept.indexOf('newConnection.resume()'),
    'the requirement is set before the connection starts');
  assert.match(server, /anchor apple generic and identifier \\"\\\(FullMonitoringXPC\.hostBundleIdentifier\)\\" and certificate leaf\[subject\.OU\]/);
});

test('プロセス番号で相手を引く確かめ方は残っていない', () => {
  assert.doesNotMatch(server, /kSecGuestAttributePid/);
  assert.doesNotMatch(server, /processIdentifier/);
  assert.doesNotMatch(server, /SecStaticCodeCheckValidity/);
});
