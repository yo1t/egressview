'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const root = path.join(__dirname, '..', '..', 'apps', 'agent-windows');
const mainWindow = fs.readFileSync(path.join(root, 'src', 'EgressView.Agent.Ui', 'MainWindow.xaml'), 'utf8');
const renderCheck = fs.readFileSync(path.join(root, 'tools', 'render-check', 'Entry.cs'), 'utf8');

describe('Windows Agent segmented control layout', () => {
  it('reserves enough width for the longest Japanese globe selector label', () => {
    assert.match(mainWindow, /x:Name="GlobeViewChoice"[^>]*Width="240"/);
    assert.match(renderCheck, /Save\(globeSegmented, 240, 40,/);
  });
});
