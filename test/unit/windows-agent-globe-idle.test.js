'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const uiRoot = path.join(__dirname, '..', '..', 'apps', 'agent-windows', 'src', 'EgressView.Agent.Ui');
const globe = fs.readFileSync(path.join(uiRoot, 'WorldGlobeControl.cs'), 'utf8');
const windowXaml = fs.readFileSync(path.join(uiRoot, 'MainWindow.xaml'), 'utf8');

describe('Windows Agent globe idle state', () => {
  // What this file is for. The globe is the most expensive thing the window
  // draws, and a globe nobody is looking at costs exactly as much as one
  // somebody is, so the timer is tied to whether the control is on screen.
  it('does not run the animation timer while the globe is off screen', () => {
    assert.match(globe, /if \(IsVisible && rotating\)/);
    assert.match(globe, /IsVisibleChanged \+= \(_, _\) => ReconcileTimer\(\);/);
  });

  // This used to assert the opposite -- that the globe began stopped and the
  // button read "Rotate". That was never a property worth protecting: a still
  // globe hides half its destinations behind it with no sign that they are
  // there, and the Mac Agent has turned by default since it shipped. The
  // assertion above is the one that was doing the work.
  it('turns by default, and says so on the button that stops it', () => {
    assert.match(globe, /private bool rotating = true;/);
    assert.match(windowXaml, /x:Name="RotateButton"[^>]*Content="\{DynamicResource Stop\}"/);
  });
});
