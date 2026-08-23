'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const dockerfile = fs.readFileSync(
  path.join(root, 'test', 'fixtures', 'conntrack-router', 'Dockerfile'), 'utf8'
);
const entrypoint = fs.readFileSync(
  path.join(root, 'test', 'fixtures', 'conntrack-router', 'entrypoint.sh'), 'utf8'
);
const ci = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
// Comments explain what the fixture must not do and name those things; only
// what actually runs is under test.
const executable = entrypoint.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

describe('conntrack CI fixture (P2-91)', () => {
  it('資格情報をリポジトリに置かない', () => {
    // Even a throwaway container password is a credential in a public
    // repository. It is generated per run and masked in the log instead.
    assert.doesNotMatch(executable, /chpasswd\s*<<|root:[A-Za-z0-9-]+['"]?\s*\|/);
    assert.match(entrypoint, /\$\{ROUTER_PASSWORD:\?/);
    assert.match(ci, /openssl rand -hex 16/);
    assert.match(ci, /::add-mask::/);
  });

  it('CIをインターネットに依存させない', () => {
    // The development fixture generates traffic to public addresses. A test
    // that fails because 1.1.1.1 was slow teaches nothing, and CI should not
    // need the internet to exercise a parser.
    assert.doesNotMatch(executable, /1\.1\.1\.1|9\.9\.9\.9|wget|curl /);
    assert.match(entrypoint, /nc -lk -p 9000/);
  });

  it('実際のconntrackテーブルを作る', () => {
    // The point is that this is a real table, not a recorded one: the parser
    // already has fixtures, and what was untested is SSH, path detection and
    // reading a live table.
    assert.match(entrypoint, /iptables -t nat -A POSTROUTING/);
    assert.match(entrypoint, /ip netns add/);
    assert.match(dockerfile, /conntrack/);
  });

  it('最初のエントリが出るまで待ってからsshdを開く', () => {
    // A poller that connects immediately would otherwise read an empty table
    // and call it a parse failure.
    const sleepAt = entrypoint.indexOf('sleep 3');
    const sshdAt = entrypoint.indexOf('exec /usr/sbin/sshd');
    assert.ok(sleepAt > 0 && sshdAt > sleepAt);
  });

  it('ポートが開いただけでは待ち終わらない', () => {
    // The first CI run failed with "Connection lost before handshake": the
    // port was bound and sshd was not serving yet. A readiness check that
    // proves less than the client needs is a readiness check that lies.
    assert.doesNotMatch(ci, /if nc -z localhost 2222/);
    assert.match(ci, /banner" == SSH-\*/);
  });

  it('sshdが応答することをイメージ自身も報告する', () => {
    // The same readiness the workflow waits for, reported by the container.
    // The first CI failure was connecting before sshd was serving.
    assert.match(dockerfile, /HEALTHCHECK[\s\S]{0,200}grep -q SSH-/);
  });

  it('失敗したときコンテナのログを出す', () => {
    // Without it the only evidence is "the test failed", on a path whose
    // whole difficulty is that it talks to something else.
    assert.match(ci, /if: failure\(\)\s*\n\s*run: docker logs conntrack-router/);
  });
});
