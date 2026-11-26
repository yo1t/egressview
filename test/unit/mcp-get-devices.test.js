'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { deviceFromRow } = require('../../src/mcp-tools');

// P3-199. The browser names a computer by its Agent; get_devices dropped the
// Agent's fields, so an assistant saw "Mac" with no vendor.
describe('MCP get_devices: 端末一覧の行', () => {
  it('Agentが入っているPCは、PCの名前・OS・メーカー・機種を返す', () => {
    const device = deviceFromRow({
      deviceId: 'd-1', ip: '192.0.2.45', mac: 'F2:1A:20:7D:F5:3D', vendor: null,
      dnsName: 'Mac', mdnsName: null, status: 'active',
      firstSeen: 1792800000000, lastSeen: 1792800060000,
      agent: {
        hostName: 'studio-mac', platform: 'macos', manufacturer: 'Apple', model: 'Mac14,13',
        ipv6: ['2001:db8::45'],
      },
    });
    assert.deepEqual(device, {
      deviceId: 'd-1', ip: '192.0.2.45', mac: 'F2:1A:20:7D:F5:3D', vendor: null,
      dnsName: 'Mac', mdnsName: null,
      agentHostName: 'studio-mac', agentPlatform: 'macos',
      agentManufacturer: 'Apple', agentModel: 'Mac14,13',
      status: 'active',
      firstSeen: new Date(1792800000000).toISOString(),
      lastSeen: new Date(1792800060000).toISOString(),
    });
  });

  it('Agentが無い機器は、Agentの欄を空で返す', () => {
    const device = deviceFromRow({
      deviceId: 'd-2', ip: '192.0.2.36', mac: '30:30:F9:CF:92:2C', vendor: 'Espressif Inc.',
      dnsName: 'plug', status: 'active', firstSeen: 1792800000000, lastSeen: 1792800000000,
    });
    assert.equal(device.agentHostName, null);
    assert.equal(device.agentPlatform, null);
    assert.equal(device.agentManufacturer, null);
    assert.equal(device.agentModel, null);
    assert.equal(device.vendor, 'Espressif Inc.');
  });

  it('メーカーを送らない古いAgentでも、名前は返す', () => {
    const device = deviceFromRow({
      deviceId: 'd-3', ip: '198.51.100.134', status: 'active',
      agent: { hostName: 'vm-win', platform: 'windows', manufacturer: null, model: null, ipv6: [] },
    });
    assert.equal(device.agentHostName, 'vm-win');
    assert.equal(device.agentPlatform, 'windows');
    assert.equal(device.agentManufacturer, null);
    assert.equal(device.mac, null);
  });
});
