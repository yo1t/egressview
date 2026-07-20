'use strict';

const assert = require('node:assert/strict');
const { afterEach, describe, it } = require('node:test');
const axios = require('axios');
const asus = require('../../src/pollers/asus');

const originalPost = axios.post;
const originalGet = axios.get;

afterEach(() => {
  asus.disable();
  axios.post = originalPost;
  axios.get = originalGet;
});

describe('ASUS polling lifecycle', () => {
  it('restores authentication from saved configuration when polling starts', async () => {
    const updates = [];
    const postUrls = [];
    axios.post = async url => {
      postUrls.push(url);
      if (url.endsWith('/get_Nonce.cgi')) return { data: { nonce: 'test-nonce' } };
      return { headers: { 'set-cookie': ['asus_token=test-token; Path=/'] }, data: '' };
    };
    axios.get = async (_url, options) => {
      const hook = options.params.hook;
      if (hook === 'get_clientlist()') return { data: { get_clientlist: {} } };
      if (hook === 'netdev()') return { data: { netdev: {} } };
      return { data: { get_cfg_clientlist: [] } };
    };
    asus.configure({
      routerIp: '192.168.1.2',
      user: 'admin',
      pass: 'saved-password',
      enabled: true,
      onNetworkUpdate: update => updates.push(update),
    });

    await asus.startPolling(60_000);

    assert.equal(asus.isAuthenticated(), true);
    assert.equal(postUrls.length, 2);
    assert.equal(updates.length, 1);
  });

  it('coalesces overlapping poll requests into one ASUS API batch', async () => {
    let releaseClients;
    let getCalls = 0;
    axios.post = async url => url.endsWith('/get_Nonce.cgi')
      ? { data: { nonce: 'test-nonce' } }
      : { headers: { 'set-cookie': ['asus_token=test-token; Path=/'] }, data: '' };
    axios.get = async (_url, options) => {
      getCalls++;
      if (options.params.hook === 'get_clientlist()') {
        await new Promise(resolve => { releaseClients = resolve; });
        return { data: { get_clientlist: {} } };
      }
      if (options.params.hook === 'netdev()') return { data: { netdev: {} } };
      return { data: { get_cfg_clientlist: [] } };
    };
    asus.configure({
      routerIp: '192.168.1.2', user: 'admin', pass: 'saved-password', enabled: true,
    });

    const first = asus.poll();
    while (!releaseClients) await new Promise(resolve => setImmediate(resolve));
    const second = asus.poll();
    releaseClients();
    await Promise.all([first, second]);

    assert.equal(getCalls, 3);
  });
});
