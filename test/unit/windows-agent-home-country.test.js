'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const root = path.join(__dirname, '..', '..', 'apps', 'agent-windows', 'src');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const windowCode = read('EgressView.Agent.Ui', 'MainWindow.xaml.cs');
const globe = read('EgressView.Agent.Ui', 'WorldGlobeControl.cs');
const settingsFile = read('EgressView.Agent.Core', 'AgentSettingsFile.cs');
const geometry = read('EgressView.Agent.Core', 'GlobeGeometry.cs');
const code = (text) => text.split(/\r?\n/).filter(line => !line.trim().startsWith('//')).join('\n');

// P3-178: where the globe draws from. HomeLocation's rules are tested in the
// Core tests; this pins what they cannot see.
describe('Windows Agent home country', () => {
  it('stays on this PC: it is not part of the exported settings file', () => {
    assert.doesNotMatch(settingsFile, /HomeCountry/);
  });

  it("reads Windows's country or region, not the display format", () => {
    assert.ok(geometry.includes('GetUserDefaultGeoName'));
    assert.doesNotMatch(code(geometry), /CultureInfo\.CurrentCulture/);
  });

  it('redraws the globe as soon as the choice changes, and says when there is nowhere to draw from', () => {
    assert.match(windowCode, /AgentSettings\.HomeCountry = item\.Tag as string \?\? string\.Empty;\s+ReconcileGlobeHome\(\);/);
    assert.ok(windowCode.includes('Globe.ReloadHome();'));
    assert.ok(windowCode.includes('GlobeNoHome.Visibility = Globe.HasHome ? Visibility.Collapsed : Visibility.Visible;'));
  });

  it('draws no line without a home, rather than one from a guessed city', () => {
    assert.ok(globe.includes('foreach (var item in home is null ? [] : points)'));
    assert.doesNotMatch(code(geometry), /Coordinates\["JP"\]/);
  });
});
