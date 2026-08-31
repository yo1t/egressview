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

// Writing the selection from a Binding's set, rather than from didSet or
// onChange, is what keeps the write out of a view update. Measured
// 2026-08-31: with the four didSets moved to onChange the warning count was
// unchanged at 19, because onChange runs inside the same update transaction.
test('Agent selections are written from the Picker binding, not didSet or onChange', () => {
  for (const property of ['selectedTab', 'scale', 'metric', 'destinationGrouping']) {
    assert.match(model, new RegExp(`@Published var ${property} =`));
    assert.doesNotMatch(
      model,
      new RegExp(`@Published var ${property}[^\\n]*\\{[\\s\\S]{0,120}didSet`)
    );
    assert.doesNotMatch(view, new RegExp(`onChange\\(of: model\\.${property}\\)`));
    assert.match(
      view,
      new RegExp(`selection: selectionBinding\\(\\\\.${property},`)
    );
  }
});

test('The selection binding writes the value and then reports the change', () => {
  const helper = view.match(
    /private func selectionBinding[\s\S]{0,700}?\n    \}/
  );
  assert.ok(helper, 'selectionBinding helper not found');
  const body = helper[0];
  assert.match(body, /set: \{ newValue in/);
  assert.match(body, /guard model\[keyPath: keyPath\] != newValue else \{ return \}/);
  assert.ok(
    body.indexOf('model[keyPath: keyPath] = newValue')
      < body.indexOf('model.selectionDidChange(change)'),
    'the value must be written before the change is reported'
  );
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
