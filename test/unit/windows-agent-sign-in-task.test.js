'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const agentRoot = path.join(__dirname, '..', '..', 'apps', 'agent-windows');
const packageWxs = fs.readFileSync(path.join(agentRoot, 'installer', 'Package.wxs'), 'utf8');
const startupTask = fs.readFileSync(path.join(agentRoot, 'src', 'EgressView.Agent.Core', 'StartupTask.cs'), 'utf8');

// P3-106: the window starts at sign-in from a task it registers itself, so the
// installer has to remove that task by name on uninstall.
describe('Windows Agent sign-in task', () => {
  const name = startupTask.match(/public const string Name = "([^"]+)";/)[1];

  it('the installer deletes the task the window registers, by the same name', () => {
    const action = packageWxs.match(/<CustomAction Id="RemoveSignInTask"[\s\S]*?\/>/)[0];
    assert.ok(action.includes(`/Delete /TN &quot;${name}&quot; /F`), `the uninstall deletes "${name}"`);
    assert.ok(action.includes('Execute="deferred"') && action.includes('Impersonate="no"'),
      'as SYSTEM, which can delete a task another account registered');
    assert.ok(action.includes('Return="ignore"'), 'and an uninstall does not fail when there is no task');
  });

  it('only on a full uninstall, not on an upgrade', () => {
    assert.match(packageWxs,
      /<Custom Action="RemoveSignInTask" Before="RemoveFiles"\s+Condition="REMOVE~=&quot;ALL&quot; AND NOT UPGRADINGPRODUCTCODE" \/>/);
  });
});
