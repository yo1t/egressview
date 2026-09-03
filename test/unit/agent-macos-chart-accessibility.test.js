'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');

const dir = 'apps/agent-macos/Xcode/Host/';
const globe = readFileSync(dir + 'AgentGlobeChart.swift', 'utf8');
const sankey = readFileSync(dir + 'AgentSankeyChart.swift', 'utf8');
const timeline = readFileSync(dir + 'AgentTimelineChart.swift', 'utf8');
const components = readFileSync(dir + 'AgentChartComponents.swift', 'utf8');

// Measured 2026-09-03 with the accessibility API, before and after:
//
//            before                          after
//   globe    AXUnknown, 1 element            AXImage, 0 inside
//   sankey   AXImage + 38 bare labels        AXImage, 0 inside
//   timeline AXImage, 1 element              AXImage, 0 inside
//
// The bare labels read as a process name, a couple of figures and a
// destination address on their own, which says nothing about what is being
// counted; the same figures are already in the summary each drawing carries.

test('all three charts present themselves as one image', () => {
  // The globe is an NSView, so it takes the trait through SwiftUI.
  assert.match(globe, /\.accessibilityAddTraits\(\.isImage\)/);
  // The other two carry an NSView that declares the role itself.
  assert.match(components, /accessibilityRole\(\) -> NSAccessibility\.Role\? \{ \.image \}/);
  for (const [name, src] of [['sankey', sankey], ['timeline', timeline]]) {
    assert.match(
      src,
      /AgentDrawingAccessibility\(label: summary\)/,
      `${name} does not carry the drawing accessibility element`
    );
  }
});

test('the sankey columns are on screen but not in the accessibility tree', () => {
  const column = sankey.match(/private struct AgentSankeyColumn: View \{[\s\S]*?\n\}/);
  assert.ok(column, 'AgentSankeyColumn not found');
  assert.match(
    column[0],
    /\.accessibilityHidden\(true\)/,
    'the columns would put one element per label inside the diagram'
  );
});

// Each drawing must still say what it shows; hiding the labels removes the
// figures from the tree, so the summary is the only place left carrying them.
test('each chart still carries a summary', () => {
  for (const [name, src] of [['globe', globe], ['sankey', sankey], ['timeline', timeline]]) {
    assert.match(src, /accessibilitySummary\(|accessibilityLabel\(summary\)/, `${name} has no summary`);
  }
});
