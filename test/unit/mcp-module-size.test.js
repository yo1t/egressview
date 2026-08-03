// Drift guard for the MCP module split (P2-68)
// Run: node --test test/unit/mcp-module-size.test.js
//
// mcp-server.js reached 1,079 lines and src/mcp-publication-gate.js 868 before
// the split, which is what promoted the MCP surface to a medium maintainability
// risk in the v1.7.0 quality report. This keeps the result from silently
// regrowing: the point is not the exact number but that adding a sixth
// responsibility to one of these files becomes a deliberate decision.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const LIMIT = 700;

const MCP_MODULES = [
  'mcp-server.js',
  'src/mcp-tools.js',
  'src/mcp-http-middleware.js',
  'src/mcp-publication-gate.js',
  'src/mcp-publication-evidence.js',
  'src/mcp-publication-constants.js',
];

function lineCount(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8').split('\n').length;
}

describe('MCP モジュール分割の維持', () => {
  it(`MCP関連モジュールはいずれも ${LIMIT} 行未満`, () => {
    const oversized = MCP_MODULES
      .map(file => ({ file, lines: lineCount(file) }))
      .filter(entry => entry.lines >= LIMIT);
    assert.deepEqual(oversized, [], 'この上限を超えるなら、行数を増やす前に責務を分けること');
  });

  it('分割したモジュールが実在し、空でない', () => {
    for (const file of MCP_MODULES) {
      assert.ok(lineCount(file) > 10, `${file} が失われている`);
    }
  });

  it('ツール定義は単一の場所にある', () => {
    // The permission-matrix drift guard scans one file for registerTool calls,
    // so definitions splitting across files would silently weaken it.
    const server = fs.readFileSync(path.join(root, 'mcp-server.js'), 'utf8');
    assert.equal(
      [...server.matchAll(/registerTool\(\s*server,/g)].length, 0,
      'ツール登録は src/mcp-tools.js に集約すること'
    );
  });
});

describe('buildMcpServer の既定 apiClient', () => {
  it('apiClient: undefined を明示しても既定クライアントへ落ちる', () => {
    // The pre-split signature used a default parameter, which applied for an
    // explicit undefined too. A plain spread would have overwritten it.
    const { _buildMcpServer } = require('../../mcp-server.js');
    assert.doesNotThrow(() => _buildMcpServer({ apiClient: undefined }));
  });
});
