// Unit tests for src/pollers/cisco-session.js (P2-24)
// The enable-mode handshake state machine, driven entirely by fixture strings —
// no real Cisco device needed.
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const session = require('../../src/pollers/cisco-session');

// ── Prompt classifiers ────────────────────────────────────────────────────────

describe('cisco-session: prompt classifiers', () => {
  it('looksLikeShellPrompt matches both > and #', () => {
    assert.equal(session.looksLikeShellPrompt('Router> '), true);
    assert.equal(session.looksLikeShellPrompt('Router# '), true);
    assert.equal(session.looksLikeShellPrompt('Password: '), false);
    assert.equal(session.looksLikeShellPrompt(''), false);
    assert.equal(session.looksLikeShellPrompt(null), false);
  });

  it('looksLikeUserPrompt matches only >', () => {
    assert.equal(session.looksLikeUserPrompt('Router> '), true);
    assert.equal(session.looksLikeUserPrompt('Router# '), false);
  });

  it('looksLikePrivilegedPrompt matches only #', () => {
    assert.equal(session.looksLikePrivilegedPrompt('Router# '), true);
    assert.equal(session.looksLikePrivilegedPrompt('Router> '), false);
  });

  it('looksLikePasswordPrompt matches the enable Password: prompt', () => {
    assert.equal(session.looksLikePasswordPrompt('Password: '), true);
    assert.equal(session.looksLikePasswordPrompt('password:'), true);
    assert.equal(session.looksLikePasswordPrompt('Router# '), false);
  });

  it('looksLikePagerPrompt matches --More--', () => {
    assert.equal(session.looksLikePagerPrompt(' --More-- '), true);
    assert.equal(session.looksLikePagerPrompt('--more--'), true);
    assert.equal(session.looksLikePagerPrompt('Router# '), false);
  });
});

// ── promptMatcher ─────────────────────────────────────────────────────────────

describe('cisco-session: promptMatcher', () => {
  it('enableResponse accepts either Password: or a shell prompt', () => {
    const m = session.promptMatcher('enableResponse');
    assert.equal(m('Password: '), true);
    assert.equal(m('Router# '), true);
    assert.equal(m('Router> '), true);
    assert.equal(m('nothing yet'), false);
  });

  it('default (shell) accepts only a shell prompt', () => {
    const m = session.promptMatcher('shell');
    assert.equal(m('Router# '), true);
    assert.equal(m('Password: '), false);
  });
});

// ── enableHandshakeStep (the pure state machine) ──────────────────────────────

describe('cisco-session: enableHandshakeStep', () => {
  const START = session.ENABLE_START;

  it('start: already privileged (#) → done, no enable sent', () => {
    const step = session.enableHandshakeStep(START, 'Router# ', { enablePass: 'secret' });
    assert.deepEqual(step, { done: true });
  });

  it('start: user mode (>) with enablePass → sends enable, waits for enableResponse', () => {
    const step = session.enableHandshakeStep(START, 'Router> ', { enablePass: 'secret' });
    assert.equal(step.write, 'enable\n');
    assert.equal(step.waitFor, 'enableResponse');
    assert.equal(step.phase, 'sentEnable');
  });

  it('start: user mode (>) without enablePass → done (skip, legacy behavior)', () => {
    const step = session.enableHandshakeStep(START, 'Router> ', {});
    assert.deepEqual(step, { done: true });
  });

  it('sentEnable: Password: prompt → sends the password, waits for a shell prompt', () => {
    const step = session.enableHandshakeStep('sentEnable', 'Password: ', { enablePass: 's3cr3t' });
    assert.equal(step.write, 's3cr3t\n');
    assert.equal(step.waitFor, 'shell');
    assert.equal(step.phase, 'sentPassword');
  });

  it('sentEnable: privileged prompt (enable needed no password) → done', () => {
    const step = session.enableHandshakeStep('sentEnable', 'Router# ', { enablePass: 'x' });
    assert.deepEqual(step, { done: true });
  });

  it('sentEnable: dropped back to user mode (enable rejected) → error', () => {
    const step = session.enableHandshakeStep('sentEnable', 'Router> ', { enablePass: 'x' });
    assert.ok(step.error);
    assert.match(step.error, /enable mode failed/);
  });

  it('sentPassword: privileged prompt (correct password) → done', () => {
    const step = session.enableHandshakeStep('sentPassword', 'Router# ', { enablePass: 'x' });
    assert.deepEqual(step, { done: true });
  });

  it('sentPassword: back to user mode (wrong password) → error', () => {
    const step = session.enableHandshakeStep('sentPassword', 'Router> ', { enablePass: 'x' });
    assert.ok(step.error);
    assert.match(step.error, /enable mode failed/);
  });
});

// ── runEnableHandshake (the driver, with injected I/O) ────────────────────────

describe('cisco-session: runEnableHandshake', () => {
  // Build a fake shell that replays scripted responses. Each write() advances
  // to the next scripted buffer, which the injected waitForPrompt returns.
  function makeFakeShell(responses) {
    const writes = [];
    let idx = 0;
    return {
      writes,
      write: (text) => { writes.push(text); },
      waitForPrompt: async (matcher) => {
        const buf = responses[idx++];
        if (buf === undefined) throw new Error('SSH timeout');
        if (!matcher(buf)) throw new Error(`unexpected buffer did not match: ${JSON.stringify(buf)}`);
        return buf;
      },
    };
  }

  it('already privileged: no writes, resolves immediately', async () => {
    const shell = makeFakeShell([]);
    await session.runEnableHandshake({
      initialBuf: 'Router# ', enablePass: 'x',
      write: shell.write, waitForPrompt: shell.waitForPrompt,
    });
    assert.deepEqual(shell.writes, []);
  });

  it('password required, correct: sends enable then password, reaches privileged', async () => {
    const shell = makeFakeShell(['Password: ', 'Router# ']);
    await session.runEnableHandshake({
      initialBuf: 'Router> ', enablePass: 's3cr3t',
      write: shell.write, waitForPrompt: shell.waitForPrompt,
    });
    assert.deepEqual(shell.writes, ['enable\n', 's3cr3t\n']);
  });

  it('enable needs no password: sends enable, lands privileged directly', async () => {
    const shell = makeFakeShell(['Router# ']);
    await session.runEnableHandshake({
      initialBuf: 'Router> ', enablePass: 'unused',
      write: shell.write, waitForPrompt: shell.waitForPrompt,
    });
    assert.deepEqual(shell.writes, ['enable\n']);
  });

  it('wrong password: throws "enable mode failed"', async () => {
    const shell = makeFakeShell(['Password: ', 'Router> ']); // back to user mode
    await assert.rejects(
      session.runEnableHandshake({
        initialBuf: 'Router> ', enablePass: 'wrong',
        write: shell.write, waitForPrompt: shell.waitForPrompt,
      }),
      /enable mode failed/,
    );
    // enable + password were both attempted before the failure
    assert.deepEqual(shell.writes, ['enable\n', 'wrong\n']);
  });

  it('enable rejected (aaa): sentEnable returns to user mode → throws', async () => {
    const shell = makeFakeShell(['Router> ']); // enable did not prompt for password nor privilege
    await assert.rejects(
      session.runEnableHandshake({
        initialBuf: 'Router> ', enablePass: 'x',
        write: shell.write, waitForPrompt: shell.waitForPrompt,
      }),
      /enable mode failed/,
    );
    assert.deepEqual(shell.writes, ['enable\n']);
  });

  it('no enablePass in user mode: skips the handshake entirely', async () => {
    const shell = makeFakeShell([]);
    await session.runEnableHandshake({
      initialBuf: 'Router> ', enablePass: '',
      write: shell.write, waitForPrompt: shell.waitForPrompt,
    });
    assert.deepEqual(shell.writes, []);
  });

  it('propagates an SSH timeout from waitForPrompt', async () => {
    const shell = makeFakeShell([]); // enable is sent but no response scripted
    await assert.rejects(
      session.runEnableHandshake({
        initialBuf: 'Router> ', enablePass: 'x',
        write: shell.write, waitForPrompt: shell.waitForPrompt,
      }),
      /SSH timeout/,
    );
  });
});
