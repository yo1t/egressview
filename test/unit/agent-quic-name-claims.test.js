'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const settings = read('apps/agent-macos/Xcode/Host/HubDeliveryController.swift');
const privacyEn = read('docs/agent-privacy.md');
const privacyJa = read('docs/agent-privacy.ja.md');
const provider = read('apps/agent-macos/Sources/EgressViewNetworkExtension/PassOnlyFilterDataProvider.swift');
const quicInitial = read('apps/agent-macos/Sources/EgressViewAgentCore/QUICInitial.swift');

describe('destination names over QUIC (P3-29)', () => {
  it('復号することを設定画面が隠さない', () => {
    // The setting used to say "nothing is decrypted", which stopped being true
    // the moment QUIC was wired in. The honest objection to this feature is
    // "you told me you never look inside connections", and the answer has to
    // survive contact with what the code now does.
    assert.doesNotMatch(settings, /Nothing is decrypted/);
    assert.match(settings, /that one packet is decrypted/);
    assert.match(settings, /no later packet can be read at all/);
  });

  it('プライバシー文書が同じことを両言語で言う', () => {
    assert.match(privacyEn, /Over QUIC that message is encrypted, and this decrypts it/);
    assert.match(privacyEn, /RFC 9001/);
    assert.match(privacyEn, /cannot read a QUIC conversation/);
    assert.match(privacyJa, /これは復号します/);
    assert.match(privacyJa, /RFC 9001/);
    assert.match(privacyJa, /会話を読めません/);
  });

  it('読む範囲は「最初のメッセージ」であって、byte offsetではない', () => {
    // This pinned `guard offset == 0` until 2026-08-24, and kept passing after
    // the shipped code stopped calling the function it was pinning. The rule
    // that matters is which versions are attempted; where reading stops is the
    // assembler's bound, and the bound is what keeps it from running forever.
    assert.match(provider, /static func shouldAssembleQUICName/);
    assert.doesNotMatch(provider, /guard offset == 0/);
    assert.match(quicInitial, /public static let maximumDatagrams = \d/);
  });

  it('ECHの公開名を行き先として見せないと、両言語で書いてある', () => {
    // Measured on a real Mac: 8 of 521,575 named observations were
    // `cloudflare-ech.com`. Rare is not a reason to leave it unwritten --
    // without it, that name reads as the place the traffic went. The agent
    // cannot detect which names these are either, because Chrome sends the
    // same extension without using ECH, which is what ECH is for.
    assert.match(privacyEn, /public name shared by many sites/);
    assert.match(privacyEn, /cannot tell whether a given name is one of these/);
    assert.match(privacyJa, /多数のサイトが共有する公開名/);
    assert.match(privacyJa, /公開名かどうかを判定できません/);
  });

  it('安い読み取りを先に試す', () => {
    // TLS puts the name in the clear; deriving a key for a flow that did not
    // need it would be work spent to produce the same answer.
    // Pinned as the condition rather than as source order: the QUIC attempt
    // has to be reachable only when the clear-text read already came back
    // empty, and an ordering check would still pass if that guard were lost.
    assert.match(provider, /var name = TLSClientHello\.serverName\(in: readBytes\)/);
    assert.match(provider, /if name == nil, isQUICCandidate \{/);
  });
});
