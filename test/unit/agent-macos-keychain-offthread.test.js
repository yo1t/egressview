'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const hostDir = path.join(__dirname, '..', '..', 'apps/agent-macos/Xcode/Host');
const files = fs.readdirSync(hostDir).filter((f) => f.endsWith('.swift'));

// A keychain read is a round trip to securityd that can take arbitrarily long,
// or not return. On 2026-08-19 the agent's main thread was found wedged inside
// one in every frame of a three-second profile, which stops the window, the
// menu bar, and the check that notices monitoring has died. Every one of these
// classes is @MainActor, so none of them may read it directly.
describe('macOS Agent keychain access', () => {
  it('主スレッドから同期でキーチェーンを読まない', () => {
    const offenders = [];
    for (const file of files) {
      const source = fs.readFileSync(path.join(hostDir, file), 'utf8');
      for (const [index, line] of source.split('\n').entries()) {
        if (/credentialStore\.load\(\)/.test(line) && !/loadDetached/.test(line)) {
          offenders.push(`${file}:${index + 1}`);
        }
      }
    }
    assert.deepEqual(offenders, [], `同期読み取りが残っている: ${offenders.join(', ')}`);
  });

  it('エラーを保つ必要がある呼び出しはthrowing版を使う', () => {
    const uninstall = fs.readFileSync(path.join(hostDir, 'AgentUninstallController.swift'), 'utf8');
    // "the keychain could not be read" must not become "already revoked", which
    // would skip telling the Hub this Mac is going away.
    assert.match(uninstall, /loadDetachedThrowing\(\)/);
    assert.doesNotMatch(uninstall, /credentialStore\.loadDetached\(\)/);
  });

  it('登録状態が不明なうちは第三者ダウンロードを提示しない', () => {
    const threat = fs.readFileSync(path.join(hostDir, 'ThreatIntelController.swift'), 'utf8');
    // The unknown state falls on the side that offers the user less.
    assert.match(threat, /@Published private\(set\) var hasHub = true/);
  });
});
