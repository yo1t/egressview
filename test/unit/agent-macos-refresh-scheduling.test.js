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

// The four Picker choices, named as the selection struct spells them.
const FIELDS = ['tab', 'scale', 'metric', 'grouping'];

// Measured 2026-09-01: writing these @Published properties from the Picker --
// in didSet, in onChange, or in the Binding's own set -- produced 72
// "Publishing changes from within view updates" warnings for the operations
// that produce none once the Picker writes @State and the model is updated
// from a Task. All three placements run inside the view update; what matters
// is that the Picker's write and the model's write share a transaction.
test('the Pickers write @State, never the model', () => {
  for (const field of FIELDS) {
    assert.match(view, new RegExp(`selection: \\$selection\\.${field}\\)`));
  }
  for (const property of ['selectedTab', 'scale', 'metric', 'destinationGrouping']) {
    // No Picker bound straight to the model, and no didSet behind it.
    assert.doesNotMatch(view, new RegExp(`selection: \\$model\\.${property}\\)`));
    assert.doesNotMatch(
      model,
      new RegExp(`@Published var ${property}[^\\n]*\\{[\\s\\S]{0,120}didSet`)
    );
  }
});

test('the model is adopted from a Task, outside the update', () => {
  const outward = view.match(/\.onChange\(of: selection\)[\s\S]{0,200}?\n {8}\}/);
  assert.ok(outward, 'no onChange(of: selection)');
  assert.match(outward[0], /Task \{ @MainActor in[\s\S]{0,80}model\.adopt\(new\)/);
});

// Both directions must exist. A one-way binding leaves the Pickers showing a
// stale value after the model corrects one itself (it resets `metric` when the
// chosen measure is unavailable).
test('the selection is synchronised in both directions', () => {
  assert.match(view, /\.onChange\(of: selection\)/);
  assert.match(view, /\.onChange\(of: model\.selection\) \{ selection = \$0 \}/);
  assert.match(view, /\.onAppear \{ selection = model\.selection \}/);
});

// The guard against half-wiring a fifth choice: every field of the struct has
// to be carried by `selection` and handled by `adopt`, or this fails.
test('every selection field is carried and adopted', () => {
  const struct = model.match(/struct AgentMainSelection: Equatable \{([\s\S]*?)\n\}/);
  assert.ok(struct, 'AgentMainSelection not found');
  const declared = [...struct[1].matchAll(/var (\w+):/g)].map((m) => m[1]);
  assert.deepEqual(
    declared.slice().sort(),
    FIELDS.slice().sort(),
    'AgentMainSelection fields changed; update this test and the Pickers together'
  );

  const adopt = model.match(/func adopt\(_ new: AgentMainSelection\) \{([\s\S]*?)\n {4}\}/);
  assert.ok(adopt, 'adopt(_:) not found');
  for (const field of declared) {
    assert.match(
      adopt[1],
      new RegExp(`new\\.${field} !=`),
      `adopt(_:) does not compare ${field}`
    );
  }

  const snapshot = model.match(/var selection: AgentMainSelection \{([\s\S]*?)\n {4}\}/);
  assert.ok(snapshot, 'selection snapshot not found');
  for (const field of declared) {
    assert.match(
      snapshot[1],
      new RegExp(`${field}:`),
      `the selection snapshot omits ${field}`
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
