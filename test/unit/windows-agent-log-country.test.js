'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const windowCode = fs.readFileSync(path.join(__dirname, '..', '..', 'apps', 'agent-windows', 'src',
  'EgressView.Agent.Ui', 'MainWindow.xaml.cs'), 'utf8');

// P3-174: LAN, loopback and CGNAT destinations are named in the log's country
// column and can be filtered on. PrivateAddress.NetworkName is tested in the
// Core tests; this pins that the column and the filter both go by it, so a
// row shown as LAN is the row the LAN filter finds.
describe('Windows Agent log country column', () => {
  it('shows the network name before any country', () => {
    assert.ok(windowCode.includes(
      'PrivateAddress.NetworkName(flow.RemoteAddress) ?? (flow.CountryCode is { Length: 2 } code ? code : null);'));
    assert.ok(windowCode.includes('public string Country => CountryKey(value) switch'));
  });

  it('filters by the same key, with unknown meaning no key at all', () => {
    assert.ok(windowCode.includes(
      '(country == "all" || string.Equals(FlowRow.CountryKey(flow) ?? "unknown", country, StringComparison.OrdinalIgnoreCase))'));
    assert.ok(windowCode.includes('foreach (var name in PrivateAddress.NetworkNames.Where(keys.Contains))'));
    assert.doesNotMatch(windowCode, /country == "unknown" \? string\.IsNullOrWhiteSpace\(flow\.CountryCode\)/);
  });
});
