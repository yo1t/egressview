'use strict';

// P3-183: counting the bytes of connections macOS reports as zero, from packet
// headers. It costs CPU (on a test Mac the monitor went from about 0.1% to
// about 1.2% of one core), so it is the user's to turn on, and off it must
// cost nothing: macOS starts the packet filter only if the configuration
// names it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..', 'apps', 'agent-macos');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('パケットのフィルタは、利用者がオンにしたときだけ設定に入る', () => {
  const host = read('Xcode/Host/AgentMonitoringController.swift');
  const start = host.indexOf('private func filterConfiguration()');
  const config = host.slice(start, host.indexOf('func applyPacketCounting(', start));
  assert.match(config, /let countsPackets = PacketCountingPreferences\(\)\.isEnabled/);
  assert.match(config, /configuration\.filterPackets = countsPackets/);
  assert.match(config, /if countsPackets \{\s*configuration\.filterPacketProviderBundleIdentifier = identifier/);
  assert.doesNotMatch(host, /filterPackets = true/);
  // The setting changing reaches the running filter.
  assert.match(host, /func applyPacketCounting\(\) \{\s*extensionController\.applyPacketCounting/);
});

test('既定はオフ', () => {
  const prefs = read('Sources/EgressViewAgentCore/PacketCountingPreferences.swift');
  assert.match(prefs, /defaults\.bool\(forKey: Self\.enabledKey\)/);
  assert.doesNotMatch(prefs, /register\(defaults:/);
});

test('設定画面は、読むものとCPUの費用を書いてから切り替えを出す', () => {
  const settings = read('Xcode/Host/HubDeliveryController.swift');
  const section = settings.slice(settings.indexOf('private var packetCountingSection'),
    settings.indexOf('private var serverNameSection'));
  assert.match(section, /Toggle\(isOn: \$model\.countsZeroReportFlows\)/);
  assert.match(section, /Contents are not read/);
  assert.match(section, /Uses more CPU/);
  const ja = read('Xcode/Host/ja.lproj/Localizable.strings');
  assert.match(ja, /"Count them from packet headers" = "パケットのヘッダーから数える";/);
});

test('拡張機能はパケットを止めず、ヘッダーから数えるだけ', () => {
  const ext = read('Xcode/SystemExtension/EgressViewFilterDataProvider.swift');
  const handler = ext.slice(ext.indexOf('packetHandler = {'), ext.indexOf('completionHandler(nil)'));
  assert.match(handler, /return \.allow/);
  assert.doesNotMatch(handler, /\.drop|\.delay/);
  assert.match(ext, /PacketCounting\.ledger\.take\(metadata\)/);
  // No development-only switches left in what ships.
  assert.doesNotMatch(ext, /#if P3_183/);
  const plist = read('Xcode/SystemExtension/Info.plist');
  assert.match(plist, /com\.apple\.networkextension\.filter-packet/);
});
