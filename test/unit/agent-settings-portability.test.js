'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const settingsScreen = read('apps/agent-macos/Xcode/Host/HubDeliveryController.swift');
const english = read('apps/agent-macos/Xcode/Host/en.lproj/Localizable.strings');
const japanese = read('apps/agent-macos/Xcode/Host/ja.lproj/Localizable.strings');

describe('設定と履歴の持ち出し', () => {
  it('期間を指定して履歴を削除できる', () => {
    // The only deletion the screen offered was "delete everything", so
    // "I want last month gone" cost this year as well. The store could
    // already do it; nothing called it.
    assert.match(settingsScreen, /DatePicker\(\s*L\("Delete records from before"\)/);
    assert.match(settingsScreen, /model\.removeHistory\(before: deleteHistoryBefore\)/);
    assert.match(english, /"Delete records from before" = /);
    assert.match(japanese, /"Delete records from before" = "この日より前の記録を削除";/);
  });

  it('消す前に控えを取れることを、消す画面で伝える', () => {
    // Both deletions are irreversible and there is no backup feature by
    // design: a copy the deletion cannot reach would be the very defect
    // that "delete history" was fixed for.
    const dialogs = settingsScreen.match(/Button\(L\("Save a copy first\.\.\."\)\)/g) || [];
    assert.equal(dialogs.length, 2, '控えの提示が両方の削除に付いていない');
    assert.match(settingsScreen, /model\.exportHistoryBeforeDeleting\(before: deleteHistoryBefore\)/);
    assert.match(settingsScreen, /model\.exportHistoryBeforeDeleting\(before: nil\)/);
    assert.match(
      japanese,
      /"This cannot be undone\. Saving a copy writes the records to a file and does not delete anything\." = "元に戻せません。/
    );
  });

  it('控えに何が入らないかを書き出す前に言う', () => {
    // Rolled-up hours have no individual records left to write. A file that
    // quietly omitted them would look complete and would not be.
    assert.match(
      english,
      /"Individual records only\. Hours already reduced to totals cannot be written out as records, and are not in this file\."/
    );
    assert.match(japanese, /このファイルには含まれません。";/);
  });

  it('設定ファイルの書き出しと読み込みがある', () => {
    assert.match(settingsScreen, /settingsGroup\(L\("Settings file"\)\)/);
    assert.match(settingsScreen, /model\.exportSettings\(\)/);
    assert.match(settingsScreen, /model\.importSettings\(\)/);
    assert.match(japanese, /"Export settings\.\.\." = "設定を書き出す\.\.\.";/);
    assert.match(japanese, /"Import settings\.\.\." = "設定を読み込む\.\.\.";/);
  });

  it('設定ファイルに入らないものを利用者に説明する', () => {
    // The exclusions are decisions, not omissions, and the screen has to say
    // so: a file that could turn on third-party lookups or register a login
    // item would be making those choices for whoever opens it.
    assert.match(japanese, /Hubの資格情報もHubのアドレスも、このMacを特定できるものも入っていません/);
    assert.match(japanese, /ログイン時起動と第三者への問い合わせは入れていません/);
  });

  it('無視した設定を黙って捨てない', () => {
    // A value silently dropped is a setting the user believes is applied.
    assert.match(settingsScreen, /L\("Applied %lld settings\. Ignored: %@\."/);
    assert.match(japanese, /"Applied %lld settings\. Ignored: %@\." = "%lld件の設定を適用しました。無視した項目: %@。";/);
  });
});
