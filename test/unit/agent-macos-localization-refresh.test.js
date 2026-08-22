'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const hostDir = path.join(__dirname, '..', '..', 'apps', 'agent-macos', 'Xcode', 'Host');
const read = (file) => fs.readFileSync(path.join(hostDir, file), 'utf8');

const localization = read('AgentLocalization.swift');
const mainWindow = read('ObservationWindowController.swift');
const settings = read('HubDeliveryController.swift');

describe('macOS Agent live localization', () => {
  it('publishes a SwiftUI locale for every language choice', () => {
    assert.match(localization, /var effectiveLanguageCode: String/);
    assert.match(localization, /var locale: Locale/);
    assert.match(localization, /Locale\(identifier: effectiveLanguageCode\)/);
  });

  it('invalidates the complete main and settings view trees immediately', () => {
    const environment = /\.environment\(\\\.locale, language\.language\.locale\)/;
    assert.match(mainWindow, environment);
    assert.match(settings, environment);
    assert.match(mainWindow, /header\s*\n\s*\.id\(language\.language\.rawValue\)/);
    assert.match(
      mainWindow,
      /switch model\.selectedTab[\s\S]*?\.id\(language\.language\.rawValue\)/
    );
    assert.match(
      settings,
      /NavigationSplitView[\s\S]*?\.id\(language\.language\.rawValue\)/
    );
  });

  it('does not rely on recreating only the monitoring-mode picker', () => {
    const pickerStart = settings.indexOf('Picker(L("Mode")');
    const pickerEnd = settings.indexOf('.pickerStyle(.segmented)', pickerStart);
    assert.ok(pickerStart >= 0 && pickerEnd > pickerStart);
    assert.doesNotMatch(
      settings.slice(pickerStart, pickerEnd),
      /\.id\(language\.language\.rawValue\)/
    );
  });
});
