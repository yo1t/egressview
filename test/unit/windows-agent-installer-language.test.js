'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const agent = path.join(__dirname, '..', '..', 'apps', 'agent-windows');
const read = (...parts) => fs.readFileSync(path.join(agent, ...parts), 'utf8');
const packageWxs = read('installer', 'Package.wxs');
const buildScript = read('scripts', 'build-msi.ps1');
const strings = (culture) => [...read('installer', `Package.${culture}.wxl`).matchAll(/<String Id="([^"]+)" Value="([^"]*)"/g)]
  .map(([, id, value]) => [id, value]);

// The installer speaks Japanese on a Japanese Windows and shows the
// EgressView mark instead of WiX's stock artwork.
describe('Windows Agent installer language and artwork', () => {
  it('has the same strings in English and Japanese, with each culture\'s language id', () => {
    const en = new Map(strings('en-us'));
    const ja = new Map(strings('ja-jp'));
    assert.deepEqual([...ja.keys()].sort(), [...en.keys()].sort());
    assert.equal(en.get('PackageLanguage'), '1033');
    assert.equal(ja.get('PackageLanguage'), '1041');
    assert.match(ja.get('DowngradeError'), /[ぁ-んァ-ン]/, 'the Japanese message is Japanese');
  });

  it('takes every word a person reads from the localization, not from the package source', () => {
    for (const id of ['PackageLanguage', 'PackageDescription', 'DowngradeError', 'ServiceDescription', 'ShortcutDescription']) {
      assert.ok(packageWxs.includes(`!(loc.${id})`), `${id} is localized`);
    }
    assert.doesNotMatch(packageWxs, /Language="1033"/);
  });

  // 0.1.138: the Japanese transform set the upgrade's language to 1041, and
  // on a Japanese PC the installed English-language 0.1.137 was left behind.
  it('upgrades a product installed in either language', () => {
    assert.match(packageWxs, /<MajorUpgrade IgnoreLanguage="yes"/);
  });

  it('embeds the Japanese transform under 1041 and checks it is there', () => {
    assert.match(buildScript, /foreach \(\$culture in 'en-US', 'ja-JP'\)/);
    assert.match(buildScript, /msi transform -t language/);
    assert.match(buildScript, /\$record\.StringData\(1\) = '1041'/);
    assert.match(buildScript, /\$summary\.Property\(7\) = "\$template,1041"/);
    assert.match(buildScript, /Japanese transform not embedded/);
  });

  it('uses the EgressView artwork', () => {
    assert.match(packageWxs, /<WixVariable Id="WixUIDialogBmp" Value="Assets\\installer-dialog\.bmp" \/>/);
    assert.match(packageWxs, /<WixVariable Id="WixUIBannerBmp" Value="Assets\\installer-banner\.bmp" \/>/);
    for (const [name, width, height] of [['installer-dialog.bmp', 493, 312], ['installer-banner.bmp', 493, 58]]) {
      const bitmap = fs.readFileSync(path.join(agent, 'installer', 'Assets', name));
      assert.equal(bitmap.toString('ascii', 0, 2), 'BM', `${name} is a bitmap`);
      assert.equal(bitmap.readInt32LE(18), width, `${name} width`);
      assert.equal(Math.abs(bitmap.readInt32LE(22)), height, `${name} height`);
    }
  });
});
