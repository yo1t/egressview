'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const uiRoot = path.join(__dirname, '..', '..', 'apps', 'agent-windows', 'src', 'EgressView.Agent.Ui');
const globe = fs.readFileSync(path.join(uiRoot, 'WorldGlobeControl.cs'), 'utf8');
const windowXaml = fs.readFileSync(path.join(uiRoot, 'MainWindow.xaml'), 'utf8');
const windowCode = fs.readFileSync(path.join(uiRoot, 'MainWindow.xaml.cs'), 'utf8');

describe('Windows Agent globe idle state', () => {
  // What this file is for. The globe is the most expensive thing the window
  // draws, and a globe nobody is looking at costs exactly as much as one
  // somebody is, so the timer is tied to whether the control is on screen.
  it('does not run the animation timer while the globe is off screen', () => {
    assert.match(globe, /if \(IsVisible && rotating && !suspended\)/);
    assert.match(globe, /IsVisibleChanged \+= \(_, _\) => ReconcileTimer\(\);/);
  });

  // P3-130: IsVisible stays true when the window is minimized, so that alone
  // kept a hidden globe turning -- 8.7% of a core on 0.1.127. The window
  // suspends it when minimized and holds it to five frames a second while it
  // is behind another window.
  it('stops while minimized and slows behind other windows', () => {
    assert.match(windowCode, /Globe\.Suspended = WindowState == WindowState\.Minimized;/);
    assert.match(windowCode, /Globe\.FramesPerSecond = IsActive \? chosen : Math\.Min\(chosen, 5\);/);
    for (const event of ['Activated', 'Deactivated', 'StateChanged'])
      assert.ok(windowCode.includes(`${event} += (_, _) => ReconcileGlobeRate();`), `${event} reconciles the globe's rate`);
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
