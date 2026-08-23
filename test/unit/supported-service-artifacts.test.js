'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const unit = fs.readFileSync(path.join(root, 'deploy', 'egressview.service'), 'utf8');
const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
const watchdog = fs.readFileSync(path.join(root, 'src', 'event-loop-watchdog.js'), 'utf8');

function directive(text, key) {
  const match = text.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return match ? match[1].trim() : null;
}

describe('supported service artifacts (P2-90)', () => {
  it('watchdogが強制終了する前提が変わっていない', () => {
    // Everything below is a consequence of this. If the watchdog stopped
    // sending SIGKILL, the restart requirements would be different and these
    // tests would be enforcing the wrong thing.
    assert.match(watchdog, /process\.kill\(process\.pid, 'SIGKILL'\)/);
  });

  it('systemd unitが必ず再起動する', () => {
    // The watchdog's reasoning is that a fast restart beats a hang. Without a
    // restart it is just a way of stopping the service.
    assert.equal(directive(unit, 'Restart'), 'always');
    const delay = Number(directive(unit, 'RestartSec'));
    assert.ok(delay >= 1 && delay <= 30, `RestartSec=${delay} is not a fast restart`);
  });

  it('繰り返す停止で systemd が諦めないようにしてある', () => {
    // systemd gives up after 5 restarts in 10 seconds by default and leaves
    // the unit failed -- exactly what a persistent pathological query would
    // produce, turning a repeating stall into a permanent outage.
    assert.equal(directive(unit, 'StartLimitIntervalSec'), '0');
  });

  it('環境固有の値をコミットしない', () => {
    // Paths and users are placeholders; nothing about one deployment belongs
    // in a file everyone gets.
    assert.equal(/\/home\/[a-z]/.test(unit), false, 'a home directory is committed');
    assert.equal(/\d{1,3}(\.\d{1,3}){3}/.test(unit), false, 'an IP address is committed');
    assert.match(unit, /placeholders/);
  });

  it('imageは再起動方針が要ることを書いてある', () => {
    // An image cannot restart itself; the orchestrator has to be told.
    assert.match(dockerfile, /--restart/);
    assert.match(dockerfile, /`--restart` is not optional/);
  });

  it('imageは状態をvolumeに置き、層に持たない', () => {
    // An image that could hold the database would carry one machine's traffic
    // record into every copy of it.
    assert.match(dockerfile, /^VOLUME \["\/data"\]$/m);
    assert.match(dockerfile, /EGRESSVIEW_DB_PATH=\/data\//);
    assert.equal(
      /^COPY .*\.egressview.*\.db/m.test(dockerfile), false,
      'the image copies a database into itself'
    );
  });

  it('imageのHEALTHCHECKは準備完了を見る', () => {
    // /healthz says the process answers. /readyz says the database and
    // migrations are usable, which is what a supervisor should act on.
    assert.match(dockerfile, /HEALTHCHECK[\s\S]{0,300}\/readyz/);
  });

  it('demoイメージと取り違えられない', () => {
    assert.equal(/DEMO_MODE/.test(dockerfile), false, 'the production image sets demo mode');
    assert.match(dockerfile, /NODE_ENV=production/);
  });
});
