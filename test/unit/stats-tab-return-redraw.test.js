'use strict';

// Leaving the statistics tab stops two animations and throws the flat map's
// particles away; only a render builds them again. Within the summary cache's
// lifetime, coming back lands on the "already rendered" shortcut, so nothing
// rendered -- and the maps sat frozen and bare until the cache expired.
// Reported 2026-09-18: statistics, graph map, statistics.
//
// These are source assertions because the paths involved are imperative D3
// rendering against a live SVG, which the pure-helper tests beside this one
// deliberately do not reach.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const stats = fs.readFileSync(path.join(root, 'public/js/stats.js'), 'utf8');
const statsMap = fs.readFileSync(path.join(root, 'public/js/stats-map.js'), 'utf8');
const viewTabs = fs.readFileSync(path.join(root, 'public/js/view-tabs.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'public/js/main.js'), 'utf8');

describe('統計情報タブに戻ったときの再描画', () => {
  it('描き直す必要が無くても、地図は元に戻す', () => {
    // The shortcut stays -- redrawing identical charts on every time-filter
    // tick is what it exists to avoid. It just cannot leave the maps stopped.
    const shortcut =
      /statsRenderedSummary\.data === summary &&[\s\S]{0,800}?statsMapSummaryKey = summaryKey;\n\s*return;/
        .exec(stats);
    assert.ok(shortcut, '「描画済みなら何もしない」分岐が見つからない');
    assert.match(
      shortcut[0],
      /updateStatsMaps\(selIp, mapPointsFromSummary\(summary\)\)/,
      '戻ったときに地図を元に戻していない'
    );
    assert.match(shortcut[0], /return;/, '分岐そのものは残っているべき');
  });

  it('同じ絵でも、粒子が空なら描き直す', () => {
    // Restarting an animation over an empty particle list leaves the map
    // still, which looks exactly like the bug being fixed.
    assert.match(
      statsMap,
      /if \(renderSignature && stMapRenderSignature === renderSignature\) \{[\s\S]{0,400}?if \(!stFlatParticles\.length\) stRenderFlatData\(\);/,
    );
  });

  it('粒子を作るのは描画だけ、という前提を固定する', () => {
    // If particles ever get built elsewhere, the check above can be relaxed --
    // and should be, rather than left as a rule nobody can explain.
    const builders = statsMap.match(/stFlatParticles\.push\(/g) || [];
    assert.equal(builders.length, 1, '粒子を作る場所が増えている');
    assert.match(statsMap, /function stRenderFlatData[\s\S]*?stFlatParticles\.push\(/);
  });

  it('離脱時に止める側は、そのまま', () => {
    // The stopping is correct: an invisible tab should not animate.
    assert.match(main, /onLeaveStats: \(\) => \{ stStopSpin\(\); stStopFlatAnim\(\); \}/);
    assert.match(statsMap, /export function stStopFlatAnim\(\) \{[\s\S]{0,160}stFlatParticles = \[\];/);
    assert.match(viewTabs, /else viewTabHandlers\.onLeaveStats\?\.\(\)/);
  });
});
