'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const runner = require('../../src/agent-correlation-runner');

const silentLogger = { info() {}, error() {} };

function stubIngest(calls, behaviour = () => ({ examined: 0, linked: 0, ambiguous: 0 })) {
  return {
    reconcileCorrelations(options) {
      calls.push(options);
      return behaviour(options);
    },
  };
}

afterEach(() => runner._resetForTest());

describe('Agent correlation runner', () => {
  it('requires a store it can actually reconcile with', () => {
    assert.throws(() => runner.init({}), TypeError);
    assert.throws(() => runner.init({ agentIngest: {} }), TypeError);
  });

  it('does nothing until it has been initialised', () => {
    assert.equal(runner.runReconcile(), null);
  });

  it('bounds a pass to a recent window and a slice far below the store default', () => {
    const calls = [];
    runner.init({ agentIngest: stubIngest(calls), logger: silentLogger });

    runner.runReconcile({ now: 1_000_000 });

    assert.deepEqual(calls, [{
      since: 1_000_000 - runner.DEFAULT_WINDOW_MS,
      limit: runner.DEFAULT_LIMIT,
    }]);
    // The whole point of the runner: one tick cannot become the 5,000-row
    // synchronous pass that stalled the event loop on the ingest path.
    assert.ok(runner.DEFAULT_LIMIT < 5_000);
  });

  it('widens the window periodically, because a router session can arrive late', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const calls = [];
    runner.init({ agentIngest: stubIngest(calls), logger: silentLogger });
    runner.start();

    for (let tick = 0; tick < runner.SWEEP_EVERY_TICKS; tick += 1) {
      t.mock.timers.tick(runner.DEFAULT_INTERVAL_MS);
    }

    assert.equal(calls.length, runner.SWEEP_EVERY_TICKS);
    const narrow = calls.slice(0, -1);
    assert.ok(narrow.length > 0);
    // Every pass stays bounded, sweep included.
    assert.ok(calls.every(call => call.limit === runner.DEFAULT_LIMIT));
    const sweep = calls[calls.length - 1];
    assert.ok(
      sweep.since < narrow[narrow.length - 1].since,
      'the sweep pass reaches further back than a routine pass'
    );
  });

  it('does not fire before its interval elapses, and stops when told', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const calls = [];
    runner.init({ agentIngest: stubIngest(calls), logger: silentLogger });
    runner.start();

    t.mock.timers.tick(runner.DEFAULT_INTERVAL_MS - 1);
    assert.equal(calls.length, 0);
    t.mock.timers.tick(1);
    assert.equal(calls.length, 1);

    runner.stop();
    t.mock.timers.tick(runner.DEFAULT_INTERVAL_MS * 5);
    assert.equal(calls.length, 1);
  });

  it('replaces its timer instead of stacking one per start', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const calls = [];
    runner.init({ agentIngest: stubIngest(calls), logger: silentLogger });
    runner.start();
    runner.start();

    t.mock.timers.tick(runner.DEFAULT_INTERVAL_MS);

    assert.equal(calls.length, 1);
  });

  it('never holds the event loop open just to wait for the next pass', () => {
    runner.init({ agentIngest: stubIngest([]), logger: silentLogger });
    const timer = runner.start();
    assert.equal(timer.hasRef(), false);
  });

  it('survives a pass that throws, including a database closed underneath it', () => {
    const errors = [];
    runner.init({
      agentIngest: {
        reconcileCorrelations() { throw new Error('Agent ingest store is not initialized'); },
      },
      logger: { info() {}, error: (...args) => errors.push(args.join(' ')) },
    });

    assert.equal(runner.runReconcile(), null);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /periodic reconcile failed/);
  });

  it('only logs a pass that changed something', () => {
    const logs = [];
    const logger = { info: (...args) => logs.push(args.join(' ')), error() {} };

    runner.init({ agentIngest: stubIngest([], () => ({ examined: 3, linked: 0, ambiguous: 0 })), logger });
    runner.runReconcile();
    assert.equal(logs.length, 0);

    runner.init({ agentIngest: stubIngest([], () => ({ examined: 3, linked: 2, ambiguous: 0 })), logger });
    runner.runReconcile();
    assert.equal(logs.length, 1);
  });
});
