'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const { readAgentSource, agentRoot } = require('../helpers/agent-macos-sources.js');

const globe = readAgentSource('AgentGlobeChart.swift');
const atlasView = readAgentSource('AgentCountryAtlasView.swift');
const map = readAgentSource('AgentWorldMapChart.swift');
const list = readAgentSource('AgentCountryHistoryList.swift');
const viewModel = readAgentSource('AgentMainViewModel.swift');
const window = readAgentSource('ObservationWindowController.swift');
const strings = (language) => fs.readFileSync(
  path.join(agentRoot, 'Xcode', 'Host', `${language}.lproj`, 'Localizable.strings'), 'utf8'
);

describe('アクセス先の国を広げて見る', () => {
  it('拡大ボタンは国の一覧を見ているときだけ出る', () => {
    assert.match(globe, /if let onExpandCountries \{/);
    assert.match(globe, /Button\(action: onExpandCountries\)/);
    assert.match(globe, /L\("Expand"\)/);
  });

  it('広げるのはウィンドウではなく、ウィンドウの中身', () => {
    // Resizing the app's own window moves the reader's furniture to show them
    // a map, and leaves them to put it back. The tabs stay where they are.
    assert.match(viewModel, /func expandCountryAtlas\(\) \{ isCountryAtlasExpanded = true \}/);
    assert.match(viewModel, /func collapseCountryAtlas\(\) \{\s*isCountryAtlasExpanded = false/);
    assert.doesNotMatch(viewModel, /setWindowZoomed|window\.zoom/);
    assert.doesNotMatch(window, /window\.zoom\(/);
    assert.match(window, /if model\.isCountryAtlasExpanded \{/);
  });

  it('地図はCanvasで描く。NSViewではない', () => {
    // `ImageRenderer` draws an `NSViewRepresentable` as a placeholder, so a
    // map built that way could not be checked offscreen at all (P3-105).
    assert.match(map, /Canvas \{ context, size in/);
    // Looking for the thing being used, not the comment explaining why it is
    // not: the file says "NSViewRepresentable" while carefully not being one.
    const code = map.split('\n').filter(line => !line.trim().startsWith('///')).join('\n');
    assert.doesNotMatch(code, /NSViewRepresentable|AgentGlobeNativeView\(/);
  });

  it('180度線をまたぐ国を切ってから描く', () => {
    // Drawn as given, Russia, Fiji and Antarctica each put a line across the
    // whole map.
    assert.match(map, /Self\.projection\.split\(ring: ring\)/);
  });

  it('見出しは一画面に一度だけ', () => {
    assert.match(list, /var showsHeading = true/);
    assert.match(atlasView, /AgentCountryHistoryList\(rows: countryHistory, showsHeading: false\)/);
  });

  it('同じカードを二度書かない', () => {
    // The expanded view reuses the list rather than restating it.
    assert.match(atlasView, /AgentCountryHistoryList\(/);
    assert.doesNotMatch(atlasView, /First accessed|Last accessed|Latest application/);
  });

  it('何か国かを左上で言い、地球儀と同じ数え方をする', () => {
    // The map shows where and the list shows each one; neither answers "how
    // far does this reach" in a single number.
    //
    // `ZZ` -- the placeholder for a destination whose region is unknown -- is
    // not a country. A country too small for the 110m atlas to draw still is:
    // it is a place this Mac reached, and one such destination on the
    // measured Mac carries 9,835 connections.
    assert.match(atlasView, /L\("%lld countries", CountryCode\.countries\(visitedCountryCodes\)\.count\)/);
    const globeChart = readAgentSource('AgentGlobeChart.swift');
    assert.doesNotMatch(globeChart, /visitedCountryCodes\.count/);
    assert.match(globeChart, /model\.visitedCountryCount/);
    for (const language of ['en', 'ja']) {
      assert.ok(strings(language).includes('"%lld countries" ='), `${language}: count`);
    }
  });

  it('新しい文言が両方の言語にある', () => {
    for (const language of ['en', 'ja']) {
      for (const key of ['"Expand"', '"Shrink"', '"Return to the previous size"']) {
        assert.ok(strings(language).includes(`${key} =`), `${language}: ${key}`);
      }
    }
    assert.notEqual(strings('ja').match(/"Expand" = "([^"]*)"/)[1], 'Expand', 'ja が英語のまま');
  });
});

describe('いま届いた通信の国が光る', () => {
  const appDelegate = readAgentSource('AgentAppDelegate.swift');

  it('光は届いた観測から来る。地図が問い合わせに行かない', () => {
    assert.match(appDelegate, /observationsArrived\(observations\)/);
    assert.match(viewModel, /private func lightUpCountries\(for observations: \[ConnectionObservation\]\)/);
    assert.match(viewModel, /self\.countryGlow\.touch\(Set\(codes\.values\)\)/);
  });

  it('地図を開いていないときは、国を引きに行かない', () => {
    // Turning addresses into countries is a database read. Doing it for every
    // batch the collector delivers, whatever the user is looking at, would be
    // a read a second for a picture nobody has open.
    assert.match(viewModel, /guard isCountryAtlasExpanded, let store else \{ return \}/);
  });

  it('何も光っていなければ描き直さない', () => {
    // The Windows globe span itself at full rate over a still image and took
    // 1.11 CPU cores with it (P3-16).
    assert.match(viewModel, /private static let glowFramesPerSecond: Double = 15/);
    assert.match(viewModel, /private func stopGlowAnimation\(\)/);
    assert.match(viewModel, /self\.stopGlowAnimation\(\)\n\s+self\.countryGlow\.prune\(\)/);
  });

  it('閉じたら消える', () => {
    // An old glow reopened would say traffic just happened.
    assert.match(viewModel, /func collapseCountryAtlas\(\) \{[\s\S]*?countryGlow = CountryGlow\(\)/);
  });

  it('描く時刻は外から渡す', () => {
    // So the render check can draw a chosen moment of the fade rather than
    // whenever it happened to run.
    assert.match(map, /var now = Date\(\)/);
    assert.match(map, /draw\(in: &context, size: size, at: now\)/);
  });
});
