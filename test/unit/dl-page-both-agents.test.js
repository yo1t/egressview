'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', '..', ...parts), 'utf8');
const page = read('site', 'dl', 'index.html');
const privacyEn = read('docs', 'agent-privacy.md');
const privacyJa = read('docs', 'agent-privacy.ja.md');

describe('the distribution page offers both agents', () => {
  it('両方のプラットフォームを、どちらも隠さずに出す', () => {
    // The page was written for one product: the title, the heading and the
    // whole install section said "your Mac", and Windows appeared once under
    // "the download link is being prepared".
    assert.match(page, /id="download-macos"/);
    assert.match(page, /id="download-windows"/);
    assert.match(page, /id="meta-macos"/);
    assert.match(page, /id="meta-windows"/);
  });

  it('版数はmanifestから読む。ページに書かない', () => {
    // A page that invents a version number is worse than one that says
    // nothing, and the deploy workflow refuses to publish one that does.
    assert.match(page, /fetch\('\/' \+ platform \+ '\/manifest\.json'/);
    assert.match(page, /load\('macos'\)/);
    assert.match(page, /load\('windows'\)/);
    assert.doesNotMatch(page, /Download \d+\.\d+\.\d+/);
  });

  it('Windows版が未署名であることを、検証手順の場所で述べる', () => {
    // Showing a verification recipe for one platform and going quiet about
    // the other invites the reader to assume both were checked the same way.
    assert.match(page, /not yet code-signed/);
    assert.match(page, /SmartScreen/);
    assert.match(page, /Get-FileHash/);
    // And the macOS recipe is still there.
    assert.match(page, /spctl --assess/);
  });
});

describe('what the agent sends', () => {
  it('送信項目の一覧は、ダウンロードページではなくプライバシーノートにある', () => {
    // It moved: the list is for someone auditing, not for someone deciding
    // whether to download, and the agent itself now shows it before
    // enrolling, behind a tick confirming it was read.
    assert.doesNotMatch(page, /schemaVersion/);
    for (const doc of [privacyEn, privacyJa]) {
      for (const field of ['schemaVersion', 'batchId', 'observationId', 'bytesOut', 'confidence']) {
        assert.match(doc, new RegExp(field), `${field} must stay documented somewhere`);
      }
      assert.match(doc, /remoteHostname/);
    }
  });

  it('その一覧が両方のAgentに当てはまることを述べる', () => {
    assert.match(privacyEn, /macOS and Windows agents send the same ones/);
    assert.match(privacyJa, /macOS版とWindows版は同じ項目を送ります/);
  });

  it('ダウンロードページからプライバシーノートへ辿れる', () => {
    // Asked for explicitly: the reference stays on the site. It sits in the
    // card that makes the claim, not only in the footer.
    const references = page.match(/agent-privacy\.html/g) || [];
    assert.ok(references.length >= 2,
      'the privacy note is linked from the body as well as the footer');
  });
});
