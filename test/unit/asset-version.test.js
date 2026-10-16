'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { computeAssetVersion } = require('../../src/asset-version');

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-assets-'));
  fs.mkdirSync(path.join(root, 'public', 'js'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'public', 'index.html'), '<html></html>');
  fs.writeFileSync(path.join(root, 'public', 'js', 'main.js'), 'console.log(1);');
  fs.writeFileSync(path.join(root, 'src', 'data', 'i18n.json'), '{"ja":{},"en":{}}');
  return root;
}

describe('computeAssetVersion', () => {
  it('同じ中身なら同じ版になる（中身の変わらない再起動では再読み込みを勧めない）', () => {
    const root = makeRoot();
    try {
      const first = computeAssetVersion(root);
      assert.match(first, /^[0-9a-f]{16}$/);
      assert.equal(computeAssetVersion(root), first);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('画面のファイルか翻訳が1つ変われば版が変わる', () => {
    const root = makeRoot();
    try {
      const base = computeAssetVersion(root);
      fs.writeFileSync(path.join(root, 'public', 'js', 'main.js'), 'console.log(2);');
      const afterJs = computeAssetVersion(root);
      assert.notEqual(afterJs, base);
      fs.writeFileSync(path.join(root, 'src', 'data', 'i18n.json'), '{"ja":{"a":"b"},"en":{}}');
      assert.notEqual(computeAssetVersion(root), afterJs);
      fs.writeFileSync(path.join(root, 'public', 'js', 'new.js'), '');
      assert.notEqual(computeAssetVersion(root), afterJs);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('本物のpublic/から計算できる', () => {
    assert.match(computeAssetVersion(path.join(__dirname, '..', '..')), /^[0-9a-f]{16}$/);
  });
});
