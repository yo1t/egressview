'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { readAgentSource } = require('../helpers/agent-macos-sources.js');

const controller = readAgentSource('ObservationWindowController.swift');
const globe = readAgentSource('AgentGlobeChart.swift');

// Seen on one Mac 2026-09-13 at the old 900x620 minimum: the globe's speed
// controls sat outside the card that holds them, cut off by the window edge,
// and "Packet contents are never collected." fell out of the bottom of the
// summary card (P3-109 #7).
describe('窓を狭めても、中身が外へ出ない', () => {
  it('地球儀の操作は、入る形に畳まれる', () => {
    assert.match(globe, /ViewThatFits\(in: \.horizontal\)/);
    // The fixed width is what could not shrink.
    assert.doesNotMatch(globe, /spinControls\s*\n\s*\.fixedSize\(\)/);
  });

  it('最後まで残るのは、動きを止めるボタン', () => {
    // A moving globe someone cannot stop is the worst of the three states.
    const body = /ViewThatFits\(in: \.horizontal\) \{([\s\S]*?)\n        \}/.exec(globe)[1];
    const candidates = body.split('\n').filter(line => line.trim().length > 0);
    assert.equal(candidates[candidates.length - 1].trim(), 'spinButton');
    assert.ok(body.indexOf('170') < body.indexOf('116'), '広い候補が先に来ていない');
  });

  it('概要カードは、切り落とさずにスクロールする', () => {
    assert.match(controller, /struct AgentFitsOrScrolls: ViewModifier/);
    assert.match(controller, /\.modifier\(AgentFitsOrScrolls\(\)\)/);
    assert.match(controller, /if #available\(macOS 13\.3, \*\)/, 'Venturaで壊れる書き方になっている');
  });

  it('最小サイズは、実測した「気持ちよく読める大きさ」', () => {
    // Read back from the window server after the user resized it: 1169x765.
    assert.match(controller, /static let minimumWidth: CGFloat = 1170/);
    assert.match(controller, /static let minimumHeight: CGFloat = 765/);
    assert.doesNotMatch(controller, /minWidth: 900|NSSize\(width: 900/);
  });

  it('最小サイズが、内蔵ディスプレイに収まる', () => {
    // A minimum nobody can satisfy is a locked door, not a minimum.
    const width = Number(/minimumWidth: CGFloat = (\d+)/.exec(controller)[1]);
    const height = Number(/minimumHeight: CGFloat = (\d+)/.exec(controller)[1]);
    assert.ok(width <= 1372, `幅 ${width} が内蔵ディスプレイに収まらない`);
    assert.ok(height <= 892 - 25, `高さ ${height} がメニューバーの下に収まらない`);
  });

  it('既定の大きさが最小を下回らない', () => {
    const initial = /setContentSize\(NSSize\(width: (\d+), height: (\d+)\)\)/.exec(controller);
    assert.ok(Number(initial[1]) >= 1170);
    assert.ok(Number(initial[2]) >= 765);
  });
});
