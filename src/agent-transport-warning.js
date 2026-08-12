// Plaintext transport warning for agent ingest (P3-9).
//
// Agents may run on the same LAN as the Hub, where setting up TLS is real work
// for a home operator. Refusing plaintext outright would push people towards
// not running an agent at all, so plaintext is allowed behind an explicit
// opt-in. What is not acceptable is allowing it silently.
//
// The warning lists what actually crosses the wire rather than saying
// "insecure". An operator can only accept a risk they can picture, and the
// concrete list is short enough to read: where each app connected, and the
// credential that lets someone impersonate the agent.
'use strict';

const RISKS = Object.freeze([
  'agent.transport.risk.observations',
  'agent.transport.risk.token',
  'agent.transport.risk.injection',
]);

/**
 * Describes the transport an agent would use, and whether it needs consent.
 *
 * `loopback` is not a risk: the traffic never reaches a network interface, so
 * it is treated as secure regardless of the opt-in.
 */
function describeAgentTransport({ httpsEnabled = false, allowPlaintext = false } = {}) {
  if (httpsEnabled) {
    return { transport: 'https', secure: true, consentRequired: false, accepted: true, risks: [] };
  }
  return {
    transport: 'http',
    secure: false,
    // Without consent the Hub refuses non-loopback agent traffic; the setting
    // is what turns the refusal off, not a cosmetic acknowledgement.
    consentRequired: true,
    accepted: allowPlaintext === true,
    risks: RISKS,
  };
}

/** True when a non-loopback agent request must be refused. */
function shouldRefusePlaintext({ httpsEnabled, allowPlaintext, isLoopback }) {
  if (httpsEnabled || isLoopback === true) return false;
  return allowPlaintext !== true;
}

module.exports = { RISKS, describeAgentTransport, shouldRefusePlaintext };
