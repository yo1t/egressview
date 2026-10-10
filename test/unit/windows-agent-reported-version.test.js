'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const srcRoot = path.join(__dirname, '..', '..', 'apps', 'agent-windows', 'src');

function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'obj' || entry.name === 'bin' ? [] : sources(full);
    return entry.name.endsWith('.cs') ? [full] : [];
  });
}

// P3-188: every Windows Agent told the Hub it was 0.1.0-dev, so the Hub's
// device list could not say which version a PC was running.
describe('Windows Agent reports its own version', () => {
  it('no version is written into the code by hand', () => {
    const offenders = sources(srcRoot).filter((file) => fs.readFileSync(file, 'utf8').includes('"0.1.0-dev"'));
    assert.deepEqual(offenders, []);
  });

  it('enrolment, delivery and the User-Agent use the built version', () => {
    const read = (...parts) => fs.readFileSync(path.join(srcRoot, ...parts), 'utf8');
    assert.match(read('EgressView.Agent.Core', 'AgentEnrollment.cs'), /ProductInfoHeaderValue\("EgressView-Agent-Windows", DiagnosticsReport\.CurrentVersion\)/);
    assert.match(read('EgressView.Agent.Service', 'DeliveryController.cs'), /Environment\.OSVersion\.VersionString, DiagnosticsReport\.CurrentVersion\)/);
    assert.match(read('EgressView.Agent.Ui', 'MainWindow.xaml.cs'), /new AgentEnrollmentMetadata\(Environment\.MachineName, "windows", Environment\.OSVersion\.VersionString, DiagnosticsReport\.CurrentVersion\)/);
  });
});
