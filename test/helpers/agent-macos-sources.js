'use strict';

// The macOS Agent's Swift code lives in several places: the application
// target under Xcode/Host, the EgressViewAgentUI library that the
// render-check tool and the pixel tests draw the charts from without a
// window, and the Core and Network Extension libraries. These tests assert on
// what the code says, not on which directory holds it, so resolve a file by
// name across all of them -- moving a type between them is a refactor and
// should not turn into a suite of ENOENT failures.
const fs = require('node:fs');
const path = require('node:path');

const agentRoot = path.join(__dirname, '..', '..', 'apps', 'agent-macos');
const agentSourceSearchPath = Object.freeze([
  path.join(agentRoot, 'Xcode', 'Host'),
  path.join(agentRoot, 'Sources', 'EgressViewAgentUI'),
  path.join(agentRoot, 'Sources', 'EgressViewAgentCore'),
  path.join(agentRoot, 'Sources', 'EgressViewNetworkExtension'),
]);

function agentSourcePath(name) {
  const found = agentSourceSearchPath
    .map(directory => path.join(directory, name))
    .find(candidate => fs.existsSync(candidate));
  if (!found) {
    throw new Error(
      `macOS Agent source not found in ${agentSourceSearchPath.join(', ')}: ${name}`
    );
  }
  return found;
}

const readAgentSource = name => fs.readFileSync(agentSourcePath(name), 'utf8');

module.exports = { agentRoot, agentSourceSearchPath, agentSourcePath, readAgentSource };
