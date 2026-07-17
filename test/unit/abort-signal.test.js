'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { abortError, attachAbortHandler } = require('../../src/pollers/abort-signal');

describe('poller abort signal helpers', () => {
  it('reports an already-aborted signal immediately with its reason', () => {
    const controller = new AbortController();
    const reason = new Error('poll timed out');
    controller.abort(reason);

    let received;
    attachAbortHandler(controller.signal, err => { received = err; }, 'fallback');

    assert.equal(received, reason);
    assert.equal(abortError(controller.signal, 'fallback'), reason);
  });

  it('reports a later abort once', () => {
    const controller = new AbortController();
    const reason = new Error('poll timed out');
    const received = [];
    attachAbortHandler(controller.signal, err => received.push(err), 'fallback');

    controller.abort(reason);
    controller.abort(new Error('ignored'));

    assert.deepEqual(received, [reason]);
  });

  it('can detach the abort listener when an SSH wait completes', () => {
    const controller = new AbortController();
    let calls = 0;
    const remove = attachAbortHandler(controller.signal, () => { calls += 1; }, 'fallback');

    remove();
    controller.abort(new Error('late abort'));

    assert.equal(calls, 0);
  });
});
