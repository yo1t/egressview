'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const script = fs.readFileSync(
  path.join(__dirname, '..', '..', 'apps/agent-macos/scripts/build-agent-pkg.sh'), 'utf8'
);
const postinstall = script.slice(
  script.indexOf("cat > \"$SCRIPTS_DIR/postinstall\""),
  script.indexOf('\nPOSTINSTALL')
);

// On 2026-08-18 a Mac recorded nothing for 13h27m. The outage began at a .pkg
// install and ended at the next one, and this relaunch failing is the most
// likely reason -- but `|| true` left nothing to check afterwards.
describe('macOS Agent postinstall evidence', () => {
  it('インストール自体は失敗させない', () => {
    // The app is in /Applications and opening it by hand works. Turning a
    // fixable state into an unfixable one helps nobody.
    assert.match(postinstall, /set \+e/);
    assert.match(postinstall, /exit 0/);
  });

  it('起動要求の結果とコンソールユーザーを記録する', () => {
    assert.match(postinstall, /note "open exit=\$\?"/);
    assert.match(postinstall, /console_user=/);
    assert.doesNotMatch(postinstall, /open -a "\$APP" \|\| true/);
  });

  it('2秒後と10秒後の2回確認する', () => {
    // One probe cannot tell "never launched" from "launched and died at once".
    assert.match(postinstall, /probe 2\b/);
    assert.match(postinstall, /probe 10\b/);
  });

  it('起動していなければ1回だけ起動し直し、20秒後にも確認する', () => {
    assert.match(postinstall, /note "retry open exit=\$\?"/);
    assert.match(postinstall, /probe 20\b/);
    assert.equal(postinstall.match(/\/usr\/bin\/open -a "\$APP"/g).length, 2);
  });

  it('それでも起動していなければ、利用者の言語で知らせる', () => {
    // The extension only buffers until the app collects, so a missing app
    // means nothing is recorded; the closing page cannot say so.
    assert.match(postinstall, /display alert/);
    assert.match(postinstall, /giving up after \d+/);
    assert.match(postinstall, /AppleLanguages/);
    assert.match(postinstall, /起動できませんでした/);
    assert.match(postinstall, /could not be started/);
    // In the background, so the installer does not wait for the person.
    assert.match(postinstall, /"\$BUTTON" >\/dev\/null 2>&1 &/);
  });

  it('完了画面は起動したと断定しない', () => {
    const en = script.slice(script.indexOf('CONCLUSION_EN'), script.lastIndexOf('CONCLUSION_EN'));
    const ja = script.slice(script.indexOf('CONCLUSION_JA'), script.lastIndexOf('CONCLUSION_JA'));
    assert.doesNotMatch(en, /and started/);
    assert.doesNotMatch(ja, /起動しました/);
    assert.match(en, /Applications folder/);
    assert.match(ja, /アプリケーションフォルダ/);
  });

  it('別パスで動くプロセスを「起動していない」と混同しない', () => {
    // Matching only the expected path would report the wrong-version case as
    // nothing running at all.
    assert.match(postinstall, /UNEXPECTED_PATH/);
    assert.match(postinstall, /EXPECTED_BUILD/);
  });
});
