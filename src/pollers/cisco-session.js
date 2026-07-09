// Cisco IOS SSH session logic: prompt classifiers and the enable-mode
// handshake, extracted as pure functions so they can be unit-tested without a
// real device (P2-24).
//
// The enable-password bug (IOS returns "Password:" after "enable", which does
// not match the shell-prompt regex) went undetected because the handshake was
// buried in an imperative SSH callback that only ran against real hardware.
// Modeling it as a pure state machine driven by fixtures makes every branch —
// already-privileged, password-required, password-not-required, wrong
// password, enable rejected — testable in CI.
'use strict';

// ── Prompt classifiers (pure) ────────────────────────────────────────────────

// A shell prompt ends in ">" (user mode) or "#" (privileged mode).
function looksLikeShellPrompt(text) {
  return /[>#]\s*$/.test(String(text || ''));
}

// The pager stops output with "--More--" and waits for a space.
function looksLikePagerPrompt(text) {
  return /--\s*[Mm]ore\s*--/.test(String(text || ''));
}

// The "Password:" prompt IOS returns after "enable" does not match the
// shell-prompt regex, so it needs its own detector.
function looksLikePasswordPrompt(text) {
  return /[Pp]assword:\s*$/.test(String(text || ''));
}

// The privileged prompt specifically ends in "#".
function looksLikePrivilegedPrompt(text) {
  return /#\s*$/.test(String(text || ''));
}

// The user-mode prompt specifically ends in ">".
function looksLikeUserPrompt(text) {
  return />\s*$/.test(String(text || ''));
}

// Detects the IOS error output produced when privilege is insufficient. The
// parser would otherwise silently return zero sessions, so this lets callers
// distinguish "NAT table is empty" from "not in privileged mode".
function isPrivilegeError(text) {
  return /%\s*(Invalid input|Access denied|Authorization failed)/i.test(String(text || ''));
}

// ── Enable-mode handshake state machine (pure) ───────────────────────────────

const ENABLE_START = 'start';

// Resolve a wait-condition name to a buffer matcher used by the driver.
function promptMatcher(kind) {
  if (kind === 'enableResponse') {
    // After "enable", IOS returns either "Password:" (password required) or a
    // shell prompt (no password needed / already privileged).
    return (buf) => looksLikePasswordPrompt(buf) || looksLikeShellPrompt(buf);
  }
  // Default: wait for any shell prompt.
  return looksLikeShellPrompt;
}

const ENABLE_FAILED_MESSAGE = 'enable mode failed — check enable password';

/**
 * One step of the enable-mode handshake.
 *
 * @param {string} phase - current phase: 'start' | 'sentEnable' | 'sentPassword'
 * @param {string} buf   - the shell buffer as last observed
 * @param {{ enablePass?: string }} opts
 * @returns {{ done: true }
 *          | { error: string }
 *          | { write: string, waitFor: string, phase: string }}
 */
function enableHandshakeStep(phase, buf, { enablePass } = {}) {
  switch (phase) {
    case ENABLE_START:
      // Already in privileged mode → nothing to do.
      if (looksLikePrivilegedPrompt(buf)) return { done: true };
      // User mode with an enable password configured → send "enable".
      if (looksLikeUserPrompt(buf) && enablePass) {
        return { write: 'enable\n', waitFor: 'enableResponse', phase: 'sentEnable' };
      }
      // User mode without an enable password → skip (matches legacy behavior;
      // the subsequent NAT command will surface a privilege error instead).
      return { done: true };

    case 'sentEnable':
      // IOS asked for the enable password → send it.
      if (looksLikePasswordPrompt(buf)) {
        return { write: enablePass + '\n', waitFor: 'shell', phase: 'sentPassword' };
      }
      // Enable needed no password and we're now privileged.
      if (looksLikePrivilegedPrompt(buf)) return { done: true };
      // Dropped back to user mode (or anything else) → enable was rejected.
      return { error: ENABLE_FAILED_MESSAGE };

    case 'sentPassword':
      // Correct password → privileged prompt.
      if (looksLikePrivilegedPrompt(buf)) return { done: true };
      // Wrong password → IOS returns to user mode.
      return { error: ENABLE_FAILED_MESSAGE };

    default:
      return { error: `unknown enable handshake phase: ${phase}` };
  }
}

/**
 * Drive the enable-mode handshake to completion.
 *
 * The two side effects are injected so the driver itself stays testable:
 *   - write(text): send text to the shell
 *   - waitForPrompt(matcher, timeoutMs): resolve with the buffer once matcher passes
 *
 * @param {{
 *   initialBuf: string,
 *   enablePass?: string,
 *   write: (text: string) => void,
 *   waitForPrompt: (matcher: (buf: string) => boolean, timeoutMs?: number) => Promise<string>,
 *   timeoutMs?: number,
 * }} io
 */
async function runEnableHandshake({ initialBuf, enablePass, write, waitForPrompt, timeoutMs = 8000 }) {
  let phase = ENABLE_START;
  let buf = initialBuf;
  // Bounded loop: the machine has at most 3 phases, so 4 iterations is plenty.
  for (let guard = 0; guard < 4; guard++) {
    const step = enableHandshakeStep(phase, buf, { enablePass });
    if (step.done) return;
    if (step.error) throw new Error(step.error);
    write(step.write);
    buf = await waitForPrompt(promptMatcher(step.waitFor), timeoutMs);
    phase = step.phase;
  }
  throw new Error('enable handshake did not terminate');
}

module.exports = {
  looksLikeShellPrompt,
  looksLikePagerPrompt,
  looksLikePasswordPrompt,
  looksLikePrivilegedPrompt,
  looksLikeUserPrompt,
  isPrivilegeError,
  promptMatcher,
  enableHandshakeStep,
  runEnableHandshake,
  ENABLE_START,
};
