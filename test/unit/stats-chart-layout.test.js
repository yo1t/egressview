'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', '..');

function loadStatsLayoutHelpers() {
  const source = fs.readFileSync(path.join(root, 'public/js/stats-helpers.js'), 'utf8');
  const wrapped = source.replace(/^export function /gm, 'function ');
  const fnNames = [...wrapped.matchAll(/^function (\w+)/gm)].map(m => m[1]);
  const tail = fnNames.map(n => `exports.${n} = ${n};`).join('\n');
  const context = { exports: {}, Map, Number, Math };
  vm.runInNewContext(wrapped + '\n' + tail, context);
  return context.exports;
}

describe('stats chart layout', () => {
  it('keeps bar chart width positive when the container is narrower than margins', () => {
    const { chartInnerWidth } = loadStatsLayoutHelpers();

    assert.equal(chartInnerWidth(120, { left: 180, right: 40 }), 1);
  });

  it('uses the available inner width when margins fit', () => {
    const { chartInnerWidth } = loadStatsLayoutHelpers();

    assert.equal(chartInnerWidth(600, { left: 180, right: 40 }), 380);
  });

  it('draws discrete windows without interpolating unobserved values', () => {
    const charts = fs.readFileSync(path.join(root, 'public/js/stats-charts.js'), 'utf8');

    assert.doesNotMatch(charts, /curveMonotoneX|d3\.area\(|d3\.line\(/);
    assert.match(charts, /chartMode = 'composition'/);
    assert.match(charts, /timeline-total/);
    assert.match(charts, /timeline-selected/);
  });

  it('keeps the timeline to ten named destinations plus Other', () => {
    const stats = fs.readFileSync(path.join(root, 'public/js/stats.js'), 'utf8');

    assert.match(stats, /const TIMELINE_TARGET_LIMIT = 10;/);
    assert.equal((stats.match(/slice\(0, TIMELINE_TARGET_LIMIT\)/g) || []).length, 2);
  });

  it('lets bars and destination labels toggle comparison mode', () => {
    const charts = fs.readFileSync(path.join(root, 'public/js/stats-charts.js'), 'utf8');

    assert.match(charts, /selectedTimelineTarget === target/);
    assert.match(charts, /activateChartMode\('composition'\)/);
    assert.match(charts, /classed\('stats-destination-tick'/);
    assert.ok((charts.match(/selectTimelineTarget\(d\[0\]\)/g) || []).length >= 2,
      'the bar and its value path should share the selection action');
  });
});
