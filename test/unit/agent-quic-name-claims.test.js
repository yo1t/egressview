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

  it('復号は最初のdatagramのv1 Initialに限る', () => {
    // A later datagram is protected with keys an observer does not have, and a
    // version this does not know would be decrypted with the wrong salt and
    // reported as malformed -- a worse answer than not looking.
    assert.match(provider, /guard offset == 0, quicClassification == \.version1 else \{ return nil \}/);
  });

  it('安い読み取りを先に試す', () => {
    // TLS puts the name in the clear; deriving a key for a flow that did not
    // need it would be work spent to produce the same answer.
    const tlsAt = provider.indexOf('TLSClientHello.serverName(in: readBytes)');
    const quicAt = provider.indexOf('QUICInitial.serverName(inDatagram: readBytes)');
    assert.ok(tlsAt > 0 && quicAt > 0 && tlsAt < quicAt);
  });
});
