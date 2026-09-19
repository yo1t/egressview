'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', '..', ...parts), 'utf8');
const page = read('site', 'dl', 'index.html');
const privacyEn = read('docs', 'agent-privacy.md');
const privacyJa = read('docs', 'agent-privacy.ja.md');
const windowsEn = read('docs', 'agent-privacy-windows.md');
const windowsJa = read('docs', 'agent-privacy-windows.ja.md');

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

describe('the Windows privacy note', () => {
  it('復号しないと述べる。macOS版の文言を流用しない', () => {
    // The macOS note's centre is that it decrypts one QUIC packet, and says
    // the setting's trustworthiness rests on that admission. The Windows
    // agent reads DNS metadata and decrypts nothing. Carrying the macOS
    // sentence over would claim a capability this agent does not have --
    // the wrong direction, but still wrong.
    for (const doc of [windowsEn, windowsJa]) {
      assert.doesNotMatch(doc, /RFC 9001/);
    }
    assert.match(windowsEn, /decrypts nothing/i);
    assert.match(windowsEn, /never reads a packet's contents/i);
    assert.match(windowsJa, /復号しません/);
    assert.match(windowsJa, /パケットの本体を一度も読みません/);
    // And it names what it does read instead.
    for (const doc of [windowsEn, windowsJa]) {
      assert.match(doc, /DNS-Client/);
      assert.match(doc, /3008/);
    }
  });

  it('外部へ宛先を送る唯一の経路を名指しする', () => {
    // ipwho.is is the only row in the table that sends a watched address
    // outside. A privacy note that lists it among the others without saying
    // so would be technically complete and practically useless.
    for (const doc of [windowsEn, windowsJa]) {
      assert.match(doc, /ipwho\.is/);
      assert.match(doc, /download\.maxmind\.com/);
    }
    assert.match(windowsEn, /only one that \*\*sends a destination you\s+observed out of this network/);
    assert.match(windowsJa, /観測した宛先そのものを外部へ送ります/);
  });

  it('未署名であることを述べる', () => {
    assert.match(windowsEn, /not currently code-signed/);
    assert.match(windowsJa, /コード署名されていません/);
  });

  it('二つのノートは互いを指す', () => {
    assert.match(privacyEn, /agent-privacy-windows\.md/);
    assert.match(privacyJa, /agent-privacy-windows\.ja\.md/);
    assert.match(windowsEn, /agent-privacy\.md/);
    assert.match(windowsJa, /agent-privacy\.ja\.md/);
  });
});
