'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const windowCode = fs.readFileSync(path.join(__dirname, '..', '..', 'apps', 'agent-windows', 'src',
  'EgressView.Agent.Ui', 'MainWindow.xaml.cs'), 'utf8');

// P3-171: the network tab re-aggregated its whole period in the service every
// five seconds -- a fifth of a core at six hours, all of one at seven days.
// RefreshPacing is tested in the Core tests; this pins that the window uses it.
describe('Windows Agent refresh pacing', () => {
  it('the timer waits until the last refresh says it may ask again', () => {
    assert.ok(windowCode.includes('|| DateTimeOffset.UtcNow < visibleRefreshDueAt) return;'));
  });

  it('every refresh of the shown tab sets that time from what it took', () => {
    assert.ok(windowCode.includes(
      'finally { visibleRefreshDueAt = DateTimeOffset.UtcNow + RefreshPacing.After(Stopwatch.GetElapsedTime(started)); }'));
    // The tab switch is the only one: a second path to the tabs would refresh
    // without setting the time.
    assert.equal(windowCode.match(/MainTabs\.SelectedIndex switch/g).length, 1);
    assert.ok(windowCode.includes('try { await RefreshShownTabAsync(); }'));
    assert.equal(windowCode.match(/RefreshShownTabAsync\(\)/g).length, 2, 'called only from RefreshVisibleAsync');
  });
});
