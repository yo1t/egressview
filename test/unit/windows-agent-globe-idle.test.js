'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const uiRoot = path.join(__dirname, '..', '..', 'apps', 'agent-windows', 'src', 'EgressView.Agent.Ui');
const globe = fs.readFileSync(path.join(uiRoot, 'WorldGlobeControl.cs'), 'utf8');
const windowXaml = fs.readFileSync(path.join(uiRoot, 'MainWindow.xaml'), 'utf8');

describe('Windows Agent globe idle state', () => {
  it('does not run the animation timer until rotation is requested', () => {
    assert.match(globe, /private bool rotating;/);
    assert.doesNotMatch(globe, /private bool rotating\s*=\s*true/);
    assert.match(globe, /if \(IsVisible && rotating\)/);
  });

  it('labels the initial action consistently with the stopped globe', () => {
    assert.match(windowXaml, /x:Name="RotateButton"[^>]*Content="\{DynamicResource Rotate\}"/);
  });
});
