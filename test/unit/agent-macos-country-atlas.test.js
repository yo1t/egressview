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
    assert.match(viewModel, /func collapseCountryAtlas\(\) \{ isCountryAtlasExpanded = false \}/);
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

  it('新しい文言が両方の言語にある', () => {
    for (const language of ['en', 'ja']) {
      for (const key of ['"Expand"', '"Shrink"', '"Return to the previous size"']) {
        assert.ok(strings(language).includes(`${key} =`), `${language}: ${key}`);
      }
    }
    assert.notEqual(strings('ja').match(/"Expand" = "([^"]*)"/)[1], 'Expand', 'ja が英語のまま');
  });
});
