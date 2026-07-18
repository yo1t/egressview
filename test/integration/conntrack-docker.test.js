'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { createConntrackPoller } = require('../../src/pollers/conntrack-poller');

const enabled = process.env.RUN_CONNTRACK_DOCKER === '1';

describe('Linux conntrack Docker SSH integration', { skip: !enabled }, () => {
  it('connects, detects the acquisition path, and parses live NAT sessions', async () => {
    const host = process.env.EGRESSVIEW_CONNTRACK_TEST_HOST;
    const user = process.env.EGRESSVIEW_CONNTRACK_TEST_USER;
    const pass = process.env.EGRESSVIEW_CONNTRACK_TEST_PASS;
    assert.ok(host && user && pass, 'conntrack Docker test credentials must be provided via environment');

    const poller = createConntrackPoller({ id: 'docker-test' });
    poller.configure({
      ip: host,
      port: Number(process.env.EGRESSVIEW_CONNTRACK_TEST_PORT || 22),
      user,
      pass,
      enabled: true,
      hostFp: '',
      onSaveConfig() {},
    });

    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('SSH ready timeout')), 20_000);
        poller.configure({
          onStatus(state) {
            if (state.state === 'error') {
              clearTimeout(timer);
              reject(new Error(state.message));
            }
          },
        });
        poller.connect(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      const result = await poller.detectCurrent();
      assert.equal(result.ssh.ok, true);
      assert.equal(result.conntrack.ok, true);
      assert.ok(result.conntrack.sessions > 0, 'expected at least one live conntrack session');
      assert.ok(result.lan.ip, 'expected a private LAN address');
    } finally {
      poller.disconnect();
    }
  });
});
