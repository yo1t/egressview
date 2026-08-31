'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');

const model = readFileSync(
  'apps/agent-macos/Xcode/Host/AgentMainViewModel.swift',
  'utf8'
);
const view = readFileSync(
  'apps/agent-macos/Xcode/Host/ObservationWindowController.swift',
  'utf8'
);

test('Agent selections refresh after the binding update instead of in didSet', () => {
  for (const property of ['selectedTab', 'scale', 'metric', 'destinationGrouping']) {
    assert.match(model, new RegExp(`@Published var ${property} =`));
    assert.doesNotMatch(
      model,
      new RegExp(`@Published var ${property}[^\\n]*\\{[\\s\\S]{0,120}didSet`)
    );
    assert.match(
      view,
      new RegExp(`onChange\\(of: model\\.${property}\\)[\\s\\S]{0,100}selectionDidChange`)
    );
  }
});

test('Agent refresh scheduling keeps cache ownership and stale-result checks in the model', () => {
  assert.match(model, /private let threatCandidateCache/);
  assert.match(model, /func selectionDidChange\(_ change: AgentMainSelectionChange\)/);
  assert.match(model, /refreshCoordinator\.selectionChanged\(shouldRefresh: true\)/);
  assert.match(model, /refreshCoordinator\.complete\(/);
  assert.match(model, /if completion\.shouldApply \{/);
  assert.match(model, /if let next = completion\.next \{/);
  assert.doesNotMatch(view, /threatCandidateCache/);
});
