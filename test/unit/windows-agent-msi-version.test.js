'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const script = fs.readFileSync(
  path.join(__dirname, '..', '..', 'apps/agent-windows/scripts/build-msi.ps1'),
  'utf8'
);

describe('Windows Agent MSI payload version', () => {
  it('passes the MSI version to both .NET publish operations', () => {
    const publishCommands = script.match(
      /dotnet publish[\s\S]*?-p:Version=\$Version -p:FileVersion=\$payloadFileVersion/g
    ) ?? [];
    assert.equal(publishCommands.length, 2);
  });

  it('maps semver above the legacy 1.0.0.0 floor and verifies the result', () => {
    assert.match(
      script,
      /\$payloadFileVersion = "1\.\$\(\$parsedVersion\.Major\)\.\$\(\$parsedVersion\.Minor\)\.\$\(\$parsedVersion\.Build\)"/
    );
    assert.match(script, /VersionInfo\.FileVersion/);
    assert.match(script, /\$expectedVersion = \$payloadFileVersion/);
    assert.match(script, /Published file version mismatch/);
  });
});
