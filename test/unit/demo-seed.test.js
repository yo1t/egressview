// Unit tests for deterministic demo data seeding.
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { seedDemoNotifications } = require('../../scripts/demo-seed');

describe('demo notification seed', () => {
  it('adds stable detection log rows when demo log is empty', () => {
    const logged = [];
    const history = {
      queryNotificationLog: () => [],
      logNotification: (entry, type, slackSent) => logged.push({ entry, type, slackSent }),
    };

    const count = seedDemoNotifications(history, 1_700_000_000_000);

    assert.equal(count, 2);
    assert.equal(logged.length, 2);
    assert.equal(logged[0].type, 'threat');
    assert.equal(logged[0].entry.threat.source, 'DemoFeed');
    assert.equal(logged[1].type, 'new_device');
  });

  it('does not duplicate detection log rows when demo log already exists', () => {
    const logged = [];
    const history = {
      queryNotificationLog: () => [{ id: 1 }],
      logNotification: (entry, type, slackSent) => logged.push({ entry, type, slackSent }),
    };

    const count = seedDemoNotifications(history, 1_700_000_000_000);

    assert.equal(count, 0);
    assert.equal(logged.length, 0);
  });
});
