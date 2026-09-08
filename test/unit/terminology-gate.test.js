'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// P3-26. The glossary decision was made on 2026-08-14 and the check that would
// have enforced it was recorded as added when it did not exist. Nothing noticed
// for three weeks, because the thing that would have noticed was the check.
const root = path.join(__dirname, '..', '..');
const script = path.join(root, 'scripts', 'lint-terminology.js');

function run(cwd = root) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [script], { cwd, encoding: 'utf8' }) };
  } catch (error) {
    return { code: error.status, out: `${error.stdout || ''}${error.stderr || ''}` };
  }
}

describe('用語ゲート（P3-26）', () => {
  it('いまの製品は用語集どおりである', () => {
    const { code, out } = run();
    assert.equal(code, 0, out);
  });

  it('引退した表記を実際に落とす', () => {
    // Not "the rule is written down" -- that it fires. The version of this
    // check recorded in the spec never existed, so a test that only read the
    // rule would have passed against nothing.
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-term-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: scratch });
      fs.mkdirSync(path.join(scratch, 'docs'));
      fs.writeFileSync(path.join(scratch, 'docs', 'guide.md'), 'Open the Data Sources tab.\n');
      // Into `scripts/` because the check resolves its root as the parent of
      // its own directory.
      fs.mkdirSync(path.join(scratch, 'scripts'));
      fs.copyFileSync(script, path.join(scratch, 'scripts', 'lint.js'));
      let failed = false;
      let output = '';
      try {
        execFileSync(process.execPath, [path.join(scratch, 'scripts', 'lint.js')], { cwd: scratch, encoding: 'utf8' });
      } catch (error) {
        failed = true;
        output = `${error.stdout || ''}${error.stderr || ''}`;
      }
      assert.ok(failed, '引退した表記を通した');
      assert.match(output, /Data Enrichment/, '置き換え先を示していない');
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('正当な server は禁止しない', () => {
    // The glossary keeps `server` for a Node process, an HTTP server, an
    // authorization server and the MCP server. Banning the word would produce
    // a check people route around.
    const source = fs.readFileSync(script, 'utf8');
    assert.doesNotMatch(source, /\/\\bserver\\b\//i, 'server 単体を禁止語にしている');
    assert.match(source, /EgressView Server/, '引退したのは製品名としての Server である');
  });

  it('CHANGELOGとbacklogは対象外である', () => {
    // They record what was true when written. Rewriting history to satisfy a
    // lint would make the record less honest, not the product more consistent.
    const source = fs.readFileSync(script, 'utf8');
    assert.match(source, /\^CHANGELOG/);
    assert.match(source, /\^backlog\\\//);
  });

  it('npm script から呼べる', () => {
    // The previous record said the check was added; there was no script and no
    // file. This asserts the wiring, not the intent.
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts['lint:terminology'], 'node scripts/lint-terminology.js');
    assert.ok(fs.existsSync(script), 'スクリプトが存在しない');
  });
});
