'use strict';

// The Hub and the Agent must judge the same destination the same way (P3-19).
//
// A Mac away from its Hub decides on its own, so the low-confidence list lives
// in two places: `src/threat-intel.js` and `ThreatFeedDownloader.swift`. Two
// copies is the price of the Agent working without a Hub. This test is what
// keeps them one rule -- an Agent that disagrees with its Hub about Google
// Drive is the defect P3-19 exists to prevent.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const hubSource = fs.readFileSync(path.join(root, 'src', 'threat-intel.js'), 'utf8');
const agentSource = fs.readFileSync(
  path.join(root, 'apps/agent-macos/Sources/EgressViewAgentCore/ThreatFeedDownloader.swift'),
  'utf8'
);

function domainsFrom(source, startMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `could not find ${startMarker}`);
  const end = source.indexOf(']', start);
  return new Set(
    [...source.slice(start, end).matchAll(/'([^']+)'|"([^"]+)"/g)]
      .map(m => m[1] || m[2])
      .filter(value => value.includes('.'))
  );
}

describe('脅威の確信度をHubとAgentで揃える (P3-19)', () => {
  it('低確信度ドメインの一覧が両側で同じ', () => {
    const hub = domainsFrom(hubSource, 'const LOW_CONFIDENCE_DOMAINS');
    const agent = domainsFrom(agentSource, 'public static let lowConfidenceDomains');
    assert.ok(hub.size >= 20, `expected a populated Hub list, got ${hub.size}`);
    assert.deepEqual([...agent].sort(), [...hub].sort(),
      'the Hub and the Agent would judge the same destination differently');
  });

  it('両側とも、ホスト自身と親ドメインの両方で判定する', () => {
    assert.match(hubSource, /LOW_CONFIDENCE_DOMAINS\.has\(host\) \|\| LOW_CONFIDENCE_DOMAINS\.has\(parentDomain\)/);
    assert.match(agentSource, /lowConfidenceDomains\.contains\(lowered\) \|\| lowConfidenceDomains\.contains\(parent\)/);
  });

  it('Hubは確信度を4番目の位置要素として送り、schema版は上げない', () => {
    // Agents accept schemaVersion 1 only. Raising it would make every deployed
    // Agent reject the payload and stop matching threats, silently.
    assert.match(hubSource, /confidenceOf\(meta\)/);
    const routes = fs.readFileSync(path.join(root, 'src', 'routes', 'agents.js'), 'utf8');
    assert.match(routes, /AGENT_THREAT_INTEL_SCHEMA_VERSION = 1;/);
  });

  it('Agentは確信度の無い応答を high として読む', () => {
    // The stricter reading. A missing field must not downgrade a real threat.
    const fetcher = fs.readFileSync(
      path.join(root, 'apps/agent-macos/Sources/EgressViewAgentCore/ThreatIntelFetcher.swift'),
      'utf8'
    );
    assert.match(fetcher, /row\.count > 3 \? row\[3\] as\? String : nil/);
    assert.match(fetcher, /\?\? \.high/);
  });

  it('通知は高確信のみ。低確信は記録して割り込まない', () => {
    const notifier = fs.readFileSync(
      path.join(root, 'apps/agent-macos/Xcode/Host/AgentUserNotifier.swift'),
      'utf8'
    );
    assert.match(notifier, /let notifiable = report\.highConfidenceAddresses/);
    assert.match(notifier, /notifiable\.contains\(finding\.candidate\.address\)/);
  });
});
