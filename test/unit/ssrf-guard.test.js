'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  createPinnedEndpointFetch,
  isBlockedOutboundIpLiteral,
  resolveSafeAddresses,
} = require('../../src/ssrf-guard');

describe('isBlockedOutboundIpLiteral', () => {
  it('blocks link-local, metadata, unspecified, broadcast, and multicast IPv4', () => {
    for (const address of [
      '169.254.169.254', // IMDS
      '169.254.0.1',
      '0.0.0.0',
      '0.1.2.3',
      '255.255.255.255',
      '224.0.0.1',
      '239.255.255.250',
      '240.0.0.1',
    ]) {
      assert.equal(isBlockedOutboundIpLiteral(address), true, address);
    }
  });

  it('blocks link-local, unspecified, IMDS, and multicast IPv6', () => {
    for (const address of [
      'fe80::1',
      'fe80::abcd',
      '::',
      'fd00:ec2::254', // EC2 IMDS over IPv6
      'ff02::1',
    ]) {
      assert.equal(isBlockedOutboundIpLiteral(address), true, address);
    }
  });

  it('blocks IPv4-mapped IPv6 forms of metadata (decimal and hextet, bracketed)', () => {
    for (const address of [
      '::ffff:169.254.169.254',
      '::ffff:a9fe:a9fe',
      '[::ffff:a9fe:a9fe]',
    ]) {
      assert.equal(isBlockedOutboundIpLiteral(address), true, address);
    }
  });

  it('allows loopback and private ranges a self-hosted Ollama legitimately uses', () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.20',
      '172.16.1.2',
      '192.168.1.2',
      '100.100.100.1', // CGNAT (e.g. Tailscale)
      '::1',
      'fd00::20',
      '::ffff:127.0.0.1',
    ]) {
      assert.equal(isBlockedOutboundIpLiteral(address), false, address);
    }
  });

  it('does not treat hostnames or empty input as blocked literals', () => {
    for (const value of ['ollama.internal', 'example.com', '', null, undefined, 'not-an-ip']) {
      assert.equal(isBlockedOutboundIpLiteral(value), false, String(value));
    }
  });
});

describe('resolved outbound endpoint protection', () => {
  it('rejects a hostname when any DNS answer is a blocked address', async () => {
    const lookup = async () => [
      { address: '192.168.1.20', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ];
    await assert.rejects(
      resolveSafeAddresses('ollama.internal', lookup),
      error => error.code === 'ERR_BLOCKED_OUTBOUND_ADDRESS'
    );
  });

  it('returns every vetted address for connection pinning', async () => {
    const lookup = async () => [
      { address: '192.168.1.20', family: 4 },
      { address: 'fd00::20', family: 6 },
    ];
    assert.deepEqual(await resolveSafeAddresses('ollama.internal', lookup), [
      { address: '192.168.1.20', family: 4 },
      { address: 'fd00::20', family: 6 },
    ]);
  });

  it('keeps DNS resolution inside the caller timeout', async () => {
    const controller = new AbortController();
    const lookup = () => new Promise(() => {});
    const pending = resolveSafeAddresses('ollama.internal', lookup, controller.signal);
    controller.abort(new DOMException('timed out', 'TimeoutError'));
    await assert.rejects(pending, error => error.name === 'TimeoutError');
  });

  it('connects to the vetted address while preserving the original Host header', async () => {
    let receivedHost = '';
    const server = require('node:http').createServer((req, res) => {
      receivedHost = req.headers.host;
      res.setHeader('Content-Type', 'application/json');
      res.end('{"models":[]}');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address();
      const lookup = async () => [{ address: '127.0.0.1', family: 4 }];
      const fetchEndpoint = createPinnedEndpointFetch({ lookup });
      const response = await fetchEndpoint(`http://ollama.internal:${port}/api/tags`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { models: [] });
      assert.equal(receivedHost, `ollama.internal:${port}`);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  it('refuses a redirect instead of following it to another address', async () => {
    const server = require('node:http').createServer((_req, res) => {
      res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address();
      const fetchEndpoint = createPinnedEndpointFetch();
      await assert.rejects(
        fetchEndpoint(`http://127.0.0.1:${port}`, { redirect: 'error' }),
        /redirect was refused/
      );
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});
