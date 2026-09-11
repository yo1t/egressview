'use strict';

// The macOS Agent's SwiftUI code lives in two places: the application target
// under Xcode/Host, and the EgressViewAgentUI library that the render-check
// tool and the pixel tests draw the charts from without a window. These tests
// assert on what the code says, not on which directory holds it, so resolve a
// file by name across both -- moving a view between the two is a refactor and
// should not turn into a suite of ENOENT failures.
const fs = require('node:fs');
const path = require('node:path');

const agentRoot = path.join(__dirname, '..', '..', 'apps', 'agent-macos');
const agentSourceSearchPath = Object.freeze([
  path.join(agentRoot, 'Xcode', 'Host'),
  path.join(agentRoot, 'Sources', 'EgressViewAgentUI'),
]);

function agentSourcePath(name) {
  const found = agentSourceSearchPath
    .map(directory => path.join(directory, name))
    .find(candidate => fs.existsSync(candidate));
  if (!found) {
    throw new Error(`macOS Agent source not found in Xcode/Host or Sources/EgressViewAgentUI: ${name}`);
  }
  return found;
}

const readAgentSource = name => fs.readFileSync(agentSourcePath(name), 'utf8');

module.exports = { agentRoot, agentSourceSearchPath, agentSourcePath, readAgentSource };
