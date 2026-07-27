'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Readable, Writable } = require('node:stream');
const express = require('express');

const configRoutes = require('../../src/routes/config');
const backupRoutes = require('../../src/routes/backup');
const beaconRoutes = require('../../src/routes/beacons');
const routerRoutes = require('../../src/routes/routers');
const devicesRoutes = require('../../src/routes/devices');
const apiIdentityRoutes = require('../../src/routes/api-identities');

const requireAdmin = (_req, _res, next) => next();

function request(app, method, url, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = new Readable({
      read() {
        if (payload) this.push(payload);
        this.push(null);
      },
    });
    req.method = method;
    req.url = url;
    req.headers = {};
    Object.defineProperty(req, 'ip', { value: '127.0.0.1', configurable: true });
    if (payload) {
      req.headers['content-type'] = 'application/json';
      req.headers['content-length'] = String(payload.length);
    }

    const res = new http.ServerResponse(req);
    const chunks = [];
    const socket = new Writable({
      write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
    });
    socket.cork = () => {};
    socket.uncork = () => {};
    socket.setTimeout = () => {};
    socket.destroy = () => {};
    res.assignSocket(socket);
    res.on('finish', () => {
      const raw = Buffer.concat(chunks).toString();
      const [headers, ...bodyParts] = raw.split('\r\n\r\n');
      const text = bodyParts.join('\r\n\r\n');
      resolve({ status: res.statusCode, headers, body: JSON.parse(text || 'null') });
    });
    app.handle(req, res, reject);
  });
}

function mount(routes) {
  const app = express();
  app.use(express.json());
  app.use('/api', routes);
  return app;
}

function sourceStub() {
  return { stop() {}, configure() {}, start() {} };
}

function configContext(overrides = {}) {
  return {
    requireAdmin,
    asus: { isAuthenticated: () => true, getRouterIp: () => '192.168.1.1' },
    enrichment: { getApiStats: () => ({}), getDnsCache: () => new Map() },
    notifier: { configure() {} },
    history: { setRetentionDays() {} },
    dnsmasqLog: sourceStub(),
    inspectSyslog: sourceStub(),
    dhcpdSyslog: sourceStub(),
    runtime: { handleInspectSession() {} },
    appState: {
      homeCountry: 'JP', uiLanguage: 'ja', autoInvestigate: false, retentionDays: 90,
      dnsmasqEnabled: false, dnsmasqLogFile: '/var/log/dnsmasq.log',
      inspectEnabled: false, inspectLogFile: '/var/log/yamaha.log',
      dhcpdEnabled: false, dhcpdLogFile: '/var/log/yamaha.log',
    },
    saveConfig() {},
    ...overrides,
  };
}

describe('API identity routes', () => {
  it('returns the one-time credential with no-store and never lists it later', async () => {
    const identity = {
      id: 'identity-1',
      label: 'automation',
      permissions: ['network.read'],
      permissionsValid: true,
      createdAt: 1,
      expiresAt: 3_600_001,
      lastUsedAt: null,
      revokedAt: null,
    };
    const apiIdentities = {
      createIdentity: () => ({ token: `egv_${'a'.repeat(64)}`, identity }),
      listIdentities: () => [identity],
    };
    const app = mount(apiIdentityRoutes({
      requireAdmin,
      apiIdentities,
      authAudit: { append() {} },
    }));

    const created = await request(app, 'POST', '/api/auth/api-identities', {
      label: 'automation',
      permissions: ['network.read'],
      expiresInMs: 3_600_000,
    });
    assert.equal(created.status, 201);
    assert.match(created.headers, /cache-control: no-store/i);
    assert.match(created.body.token, /^egv_[0-9a-f]{64}$/);

    const listed = await request(app, 'GET', '/api/auth/api-identities');
    assert.equal(listed.status, 200);
    assert.match(listed.headers, /cache-control: no-store/i);
    assert.equal(JSON.stringify(listed.body).includes(created.body.token), false);
  });

  it('returns only the authenticated scoped identity from the self endpoint', async () => {
    const identity = {
      id: 'identity-1',
      label: 'Remote MCP service',
      permissions: ['network.read', 'notes.write'],
      expiresAt: Date.now() + 60_000,
    };
    const requireIdentity = (req, _res, next) => {
      req.apiIdentity = identity;
      next();
    };
    const app = mount(apiIdentityRoutes({
      requireAdmin: requireIdentity,
      apiIdentities: {},
      authAudit: { append() {} },
    }));
    const result = await request(app, 'GET', '/api/auth/api-identities/self');
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { identity });
    assert.match(result.headers, /cache-control: no-store/i);
  });

  it('rejects browser and legacy admin credentials at the identity self endpoint', async () => {
    const app = mount(apiIdentityRoutes({
      requireAdmin,
      apiIdentities: {},
      authAudit: { append() {} },
    }));
    const result = await request(app, 'GET', '/api/auth/api-identities/self');
    assert.equal(result.status, 403);
    assert.deepEqual(result.body, { error: 'Scoped API identity required' });
  });
});

describe('config routes', () => {
  it('returns status from runtime dependencies', async () => {
    const app = mount(configRoutes(configContext()));
    const { status, body } = await request(app, 'GET', '/api/status');
    assert.equal(status, 200);
    assert.equal(body.authenticated, true);
    assert.equal(body.routerIp, '192.168.1.1');
  });

  it('rejects unknown general-setting keys without changing state', async () => {
    const context = configContext();
    const app = mount(configRoutes(context));
    const result = await request(app, 'POST', '/api/config/general', { language: 'en', typo: true });
    assert.equal(result.status, 400);
    assert.equal(context.appState.uiLanguage, 'ja');
  });

  it('rolls back general settings when persistence fails', async () => {
    const appState = configContext().appState;
    const retentionCalls = [];
    const app = mount(configRoutes(configContext({
      appState,
      history: { setRetentionDays: value => retentionCalls.push(value) },
      saveConfig: () => { throw new Error('disk full'); },
    })));

    const { status, body } = await request(app, 'POST', '/api/config/general', {
      homeCountry: 'US', language: 'en', autoInvestigate: true, retentionDays: 365,
    });

    assert.equal(status, 500);
    assert.match(body.error, /not saved/i);
    assert.equal(appState.homeCountry, 'JP');
    assert.equal(appState.uiLanguage, 'ja');
    assert.equal(appState.autoInvestigate, false);
    assert.equal(appState.retentionDays, 90);
    assert.deepEqual(retentionCalls, [365, 90]);
  });

  it('rolls back data source state and runtime configuration when persistence fails', async () => {
    const appState = configContext().appState;
    const configured = [];
    const dnsmasqLog = {
      stop() {}, start() {}, configure: cfg => configured.push({ enabled: cfg.enabled, logFile: cfg.logFile }),
    };
    const app = mount(configRoutes(configContext({
      appState,
      dnsmasqLog,
      saveConfig: () => { throw new Error('read only'); },
    })));

    const { status } = await request(app, 'POST', '/api/config/datasources', {
      dnsmasq: { enabled: true, logFile: '/var/log/new-dnsmasq.log' },
    });

    assert.equal(status, 500);
    assert.equal(appState.dnsmasqEnabled, false);
    assert.equal(appState.dnsmasqLogFile, '/var/log/dnsmasq.log');
    assert.deepEqual(configured.map(entry => entry.enabled), [true, false]);
  });
});

describe('backup configuration route', () => {
  it('coerces positive integer strings through the shared schema', async () => {
    let config = { intervalHours: 24, maxGenerations: 7, maxBackupBytes: 0, autoPrune: false };
    const backup = {
      getConfig: () => ({ ...config }),
      configure: updates => { config = { ...config, ...updates }; },
      stopPeriodicBackup() {}, startPeriodicBackup() {},
    };
    const app = mount(backupRoutes({ requireAdmin, backup, saveConfig() {}, appRoot: process.cwd() }));
    const result = await request(app, 'POST', '/api/backup/config', {
      intervalHours: '12', maxGenerations: '3', maxBackupBytes: '4294967296', autoPrune: true,
    });
    assert.equal(result.status, 200);
    assert.deepEqual(config, {
      intervalHours: 12, maxGenerations: 3, maxBackupBytes: 4294967296, autoPrune: true,
    });
  });
  it('rolls back backup scheduling when persistence fails', async () => {
    let config = { intervalHours: 24, maxGenerations: 7 };
    let starts = 0;
    const backup = {
      getConfig: () => ({ ...config }),
      configure: updates => { config = { ...config, ...updates }; },
      stopPeriodicBackup() {},
      startPeriodicBackup: () => { starts += 1; },
    };
    const app = mount(backupRoutes({
      requireAdmin,
      backup,
      saveConfig: () => { throw new Error('disk full'); },
      appRoot: process.cwd(),
    }));

    const { status, body } = await request(app, 'POST', '/api/backup/config', {
      intervalHours: 12, maxGenerations: 3,
    });

    assert.equal(status, 500);
    assert.match(body.error, /not saved/i);
    assert.deepEqual(config, { intervalHours: 24, maxGenerations: 7 });
    assert.equal(starts, 2);
  });

  it('validates the full backup config before applying any field', async () => {
    let config = { intervalHours: 24, maxGenerations: 7 };
    const backup = {
      getConfig: () => ({ ...config }),
      configure: updates => { config = { ...config, ...updates }; },
      stopPeriodicBackup() {}, startPeriodicBackup() {},
    };
    const app = mount(backupRoutes({ requireAdmin, backup, saveConfig() {}, appRoot: process.cwd() }));
    const { status } = await request(app, 'POST', '/api/backup/config', {
      intervalHours: 12, maxGenerations: 'invalid',
    });
    assert.equal(status, 400);
    assert.deepEqual(config, { intervalHours: 24, maxGenerations: 7 });
  });

  it('previews and executes safe backup cleanup through separate requests', async () => {
    const calls = [];
    const plan = { candidates: [{ name: 'old.db', size: 100 }], candidateBytes: 100 };
    const previewId = '11111111-1111-4111-8111-111111111111';
    const executeId = '22222222-2222-4222-8222-222222222222';
    const jobs = new Map();
    const backup = {
      startPruneJob: ({ execute }) => {
        calls.push(execute ? 'execute' : 'preview');
        const id = execute ? executeId : previewId;
        const job = { id, operation: execute ? 'execute' : 'preview', status: 'running' };
        jobs.set(id, execute
          ? { ...job, status: 'completed', result: { deleted: plan.candidates, deletedBytes: 100 } }
          : { ...job, status: 'completed', result: plan });
        return job;
      },
      getPruneJob: id => jobs.get(id),
    };
    const app = mount(backupRoutes({ requireAdmin, backup, appRoot: process.cwd() }));

    const preview = await request(app, 'POST', '/api/backup/prune', { execute: false });
    const execute = await request(app, 'POST', '/api/backup/prune', { execute: true });
    const previewResult = await request(app, 'GET', `/api/backup/prune/${previewId}`);
    const executeResult = await request(app, 'GET', `/api/backup/prune/${executeId}`);

    assert.equal(preview.status, 202);
    assert.equal(execute.status, 202);
    assert.deepEqual(previewResult.body.job.result, plan);
    assert.equal(executeResult.body.job.result.deletedBytes, 100);
    assert.deepEqual(calls, ['preview', 'execute']);
  });

  it('rejects malformed prune confirmation without touching backups', async () => {
    let called = false;
    const backup = {
      startPruneJob: () => { called = true; },
    };
    const app = mount(backupRoutes({ requireAdmin, backup, appRoot: process.cwd() }));
    const result = await request(app, 'POST', '/api/backup/prune', { execute: 'yes' });
    assert.equal(result.status, 400);
    assert.equal(called, false);
  });

  it('rejects concurrent cleanup and returns the active job', async () => {
    const active = {
      id: '11111111-1111-4111-8111-111111111111',
      operation: 'preview',
      status: 'running',
    };
    const backup = {
      startPruneJob() {
        const error = new Error('busy');
        error.code = 'BACKUP_PRUNE_BUSY';
        error.job = active;
        throw error;
      },
    };
    const app = mount(backupRoutes({ requireAdmin, backup, appRoot: process.cwd() }));

    const result = await request(app, 'POST', '/api/backup/prune', { execute: false });
    assert.equal(result.status, 409);
    assert.deepEqual(result.body.job, active);
  });

  it('cancels only a known running cleanup job', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    let job = { id, operation: 'preview', status: 'running' };
    const backup = {
      getPruneJob: requested => requested === id ? job : null,
      cancelPruneJob: () => { job = { ...job, status: 'cancelling' }; return true; },
    };
    const app = mount(backupRoutes({ requireAdmin, backup, appRoot: process.cwd() }));

    const cancelled = await request(app, 'DELETE', `/api/backup/prune/${id}`);
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.job.status, 'cancelling');
    assert.equal((await request(app, 'DELETE', `/api/backup/prune/${id}`)).status, 409);
    assert.equal((await request(app, 'GET', '/api/backup/prune/not-a-uuid')).status, 400);
  });

  it('closes every DB connection before restore and reopens them afterward', async () => {
    const calls = [];
    const backup = {
      restoreFromGeneration: async (_name, options) => {
        await options.beforeReplace();
        calls.push('replace');
        await options.afterReplace();
      },
    };
    const app = mount(backupRoutes({
      requireAdmin,
      backup,
      history: {
        closeDb: () => calls.push('history-close'),
        loadConnectionHistory: () => calls.push('history-open'),
        getKnownMacs: () => [],
        getConnectionHistory: () => new Map(),
      },
      runtime: { setKnownMacs: () => calls.push('runtime-refresh') },
      devices: {
        closeDb: () => calls.push('devices-close'),
        reopen: () => calls.push('devices-open'),
        seedFromConnectionHistory: () => calls.push('devices-seed'),
      },
      enrichment: { closeDb: () => calls.push('enrichment-close'), reopen: () => calls.push('enrichment-open') },
      beacons: { closeDb: () => calls.push('beacons-close'), reopen: () => calls.push('beacons-open') },
      sessions: {
        closeDb: () => calls.push('sessions-close'),
        reopen: () => calls.push('sessions-open'),
        revokeAll: () => calls.push('sessions-revoke'),
      },
      authAudit: {
        closeDb: () => calls.push('audit-close'),
        reopen: () => calls.push('audit-open'),
      },
      apiIdentities: {
        closeDb: () => calls.push('api-identities-close'),
        reopen: () => calls.push('api-identities-open'),
      },
      io: { disconnectSockets: () => calls.push('sockets-disconnect') },
      appRoot: process.cwd(),
    }));

    const { status } = await request(app, 'POST', '/api/backup/restore', { name: 'egressview_2025-01-01_00-00-00.db' });
    assert.equal(status, 200);
    assert.deepEqual(calls.slice(0, 8), [
      'history-close', 'sessions-close', 'devices-close', 'enrichment-close', 'beacons-close',
      'audit-close', 'api-identities-close', 'replace',
    ]);
    assert.ok(calls.indexOf('history-open') > calls.indexOf('replace'));
    assert.ok(calls.includes('sessions-revoke'));
    assert.ok(calls.includes('audit-open'));
    assert.ok(calls.includes('api-identities-open'));
    assert.ok(calls.includes('sockets-disconnect'));
  });

  it('uses the restore lifecycle to reopen DB connections after a failed replacement', async () => {
    const calls = [];
    const app = mount(backupRoutes({
      requireAdmin,
      backup: {
        restoreFromGeneration: async (_name, options) => {
          await options.beforeReplace();
          await options.afterRollback();
          throw new Error('replace failed');
        },
      },
      history: {
        closeDb: () => calls.push('history-close'),
        loadConnectionHistory: () => calls.push('history-open'),
        getKnownMacs: () => [], getConnectionHistory: () => new Map(),
      },
      runtime: { setKnownMacs() {} },
      devices: { closeDb() {}, reopen: () => calls.push('devices-open'), seedFromConnectionHistory() {} },
      enrichment: { closeDb() {}, reopen() {} },
      apiIdentities: {
        closeDb: () => calls.push('api-identities-close'),
        reopen: () => calls.push('api-identities-open'),
      },
      appRoot: process.cwd(),
    }));

    const { status } = await request(app, 'POST', '/api/backup/restore', { name: 'egressview_2025-01-01_00-00-00.db' });
    assert.equal(status, 500);
    assert.deepEqual(calls, [
      'history-close', 'api-identities-close', 'history-open', 'devices-open',
      'api-identities-open',
    ]);
  });
});

describe('beacon configuration route', () => {
  it('rolls back beacon settings and skips rescan when persistence fails', async () => {
    const original = {
      enabled: false, minObs: 4, maxCov: 0.15,
      minIntervalMs: 60_000, maxIntervalMs: 14_400_000,
      scanIntervalMs: 900_000, whitelistDomains: [], orgAllowlist: [],
    };
    const appState = { beaconConfig: original };
    let rescanned = false;
    const app = mount(beaconRoutes({
      requireAdmin,
      beacons: { getBeacons: () => [] },
      appState,
      saveConfig: () => { throw new Error('disk full'); },
      onConfigChange: () => { rescanned = true; },
    }));

    const { status } = await request(app, 'POST', '/api/beacons/config', { enabled: true });
    assert.equal(status, 500);
    assert.strictEqual(appState.beaconConfig, original);
    assert.equal(rescanned, false);
  });

  it('rejects unknown, mistyped, oversized, and invalid query fields before mutation', async () => {
    const original = {
      enabled: false, minObs: 4, maxCov: 0.15,
      minIntervalMs: 60_000, maxIntervalMs: 14_400_000,
      scanIntervalMs: 900_000, whitelistDomains: [], orgAllowlist: [],
    };
    const appState = { beaconConfig: original };
    let saves = 0;
    const app = mount(beaconRoutes({
      requireAdmin,
      beacons: { getBeacons: () => [], dismissBeacon: () => true },
      appState,
      saveConfig: () => { saves++; },
    }));

    assert.equal((await request(app, 'POST', '/api/beacons/config', { enabled: true, typo: 1 })).status, 400);
    assert.equal((await request(app, 'POST', '/api/beacons/config', { minObs: {} })).status, 400);
    assert.equal((await request(app, 'POST', '/api/beacons/config', {
      whitelistDomains: Array.from({ length: 201 }, () => 'example.com'),
    })).status, 400);
    assert.equal((await request(app, 'GET', '/api/beacons?includeDismissed=yes')).status, 400);
    assert.equal((await request(app, 'GET', '/api/beacons/config?extra=1')).status, 400);
    assert.equal((await request(app, 'POST', '/api/beacons/not-a-number/dismiss', {})).status, 400);
    assert.equal(saves, 0);
    assert.strictEqual(appState.beaconConfig, original);
  });
});

describe('router routes', () => {
  it('rejects unknown router fields before calling the manager', async () => {
    let called = false;
    const app = mount(routerRoutes({
      requireAdmin,
      routerManager: { upsert: () => { called = true; } },
    }));
    const result = await request(app, 'POST', '/api/routers', { kind: 'cisco', unexpected: true });
    assert.equal(result.status, 400);
    assert.equal(called, false);
  });
  it('covers list, create, update, and delete responses', async () => {
    const records = [{ id: 'yamaha1', kind: 'yamaha' }];
    const manager = {
      list: () => records,
      upsert: input => ({ ...input, id: input.id || 'cisco1' }),
      remove: id => id === 'yamaha1',
    };
    const app = mount(routerRoutes({ requireAdmin, routerManager: manager }));

    assert.equal((await request(app, 'GET', '/api/routers')).body.routers.length, 1);
    assert.equal((await request(app, 'POST', '/api/routers', { kind: 'cisco' })).status, 201);
    assert.equal((await request(app, 'POST', '/api/routers', { kind: 'conntrack' })).status, 201);
    assert.equal((await request(app, 'PUT', '/api/routers/yamaha1', { displayName: 'Main' })).status, 200);
    assert.equal((await request(app, 'DELETE', '/api/routers/yamaha1')).status, 200);
    assert.equal((await request(app, 'DELETE', '/api/routers/missing')).status, 404);
  });

  it('maps manager validation failures to 400', async () => {
    const app = mount(routerRoutes({
      requireAdmin,
      routerManager: { upsert: () => { throw new Error('invalid routerId'); } },
    }));
    const { status, body } = await request(app, 'POST', '/api/routers', {});
    assert.equal(status, 400);
    assert.match(body.error, /invalid/);
  });
});

describe('device routes', () => {
  it('covers inventory and archive lifecycle', async () => {
    const devices = {
      getAll: () => [{ deviceId: 'dev1', ip: '192.168.1.10', mac: '00:11:22:33:44:55' }],
      getByDeviceId: id => id === 'dev1' ? { deviceId: id } : null,
      archiveDevice: id => id === 'dev1',
      unarchiveDevice: id => id === 'dev1',
    };
    const app = mount(devicesRoutes({
      requireAdmin,
      devices,
      notes: { getForDevice: () => 'note' },
      yamaha: { getNdpByMac: () => ['2001:db8::1'] },
    }));

    const inventory = await request(app, 'GET', '/api/devices');
    assert.equal(inventory.status, 200);
    assert.equal(inventory.body.devices[0].note, 'note');
    assert.equal((await request(app, 'POST', '/api/devices/archive', { deviceId: 'dev1' })).status, 200);
    assert.equal((await request(app, 'POST', '/api/devices/unarchive', { deviceId: 'dev1' })).status, 200);
    assert.equal((await request(app, 'POST', '/api/devices/archive', {})).status, 400);
  });

  it('rejects unknown, mistyped, and oversized device inputs before mutation', async () => {
    let mutations = 0;
    const devices = {
      getAll: () => [],
      getMergeCandidates: () => [],
      getByDeviceId: () => null,
      approveMerge: () => { mutations++; return true; },
      rejectCandidate: () => { mutations++; },
      archiveDevice: () => { mutations++; return true; },
      unarchiveDevice: () => { mutations++; return true; },
    };
    const app = mount(devicesRoutes({
      requireAdmin,
      devices,
      notes: null,
      yamaha: { getNdpByMac: () => null },
    }));

    assert.equal((await request(app, 'GET', '/api/devices?unknown=1')).status, 400);
    assert.equal((await request(app, 'GET', '/api/devices/merge-candidates?status=invalid')).status, 400);
    assert.equal((await request(app, 'POST', '/api/devices/merge', { keepId: {}, dropId: 'dev2' })).status, 400);
    assert.equal((await request(app, 'POST', '/api/devices/reject', { id: [] })).status, 400);
    assert.equal((await request(app, 'POST', '/api/devices/archive', {
      deviceId: 'x'.repeat(129),
    })).status, 400);
    assert.equal((await request(app, 'POST', '/api/devices/unarchive', {
      deviceId: 'dev1', extra: true,
    })).status, 400);
    assert.equal(mutations, 0);
  });

  it('does not merge devices when note persistence fails', async () => {
    const values = new Map([['drop', 'printer']]);
    let merges = 0;
    const devices = {
      getByDeviceId: id => ({ deviceId: id }),
      approveMerge: () => { merges++; return true; },
    };
    const notes = {
      get: key => values.get(key),
      set: (key, value) => values.set(key, value),
      del: key => values.delete(key),
      snapshot: () => new Map(values),
      restore: snapshot => {
        values.clear();
        for (const [key, value] of snapshot) values.set(key, value);
      },
      save: () => { throw new Error('disk full'); },
    };
    const app = mount(devicesRoutes({
      requireAdmin,
      devices,
      notes,
      yamaha: { getNdpByMac: () => null },
    }));

    const result = await request(app, 'POST', '/api/devices/merge', { keepId: 'keep', dropId: 'drop' });

    assert.equal(result.status, 500);
    assert.equal(values.get('drop'), 'printer');
    assert.equal(values.has('keep'), false);
    assert.equal(merges, 0);
  });

  it('restores a migrated note when the device transaction fails', async () => {
    const values = new Map([['drop', 'printer']]);
    let saves = 0;
    const devices = {
      getByDeviceId: id => ({ deviceId: id }),
      approveMerge: () => { throw new Error('database is busy'); },
    };
    const notes = {
      get: key => values.get(key),
      set: (key, value) => values.set(key, value),
      del: key => values.delete(key),
      snapshot: () => new Map(values),
      restore: snapshot => {
        values.clear();
        for (const [key, value] of snapshot) values.set(key, value);
      },
      save: () => { saves++; },
    };
    const app = mount(devicesRoutes({
      requireAdmin,
      devices,
      notes,
      yamaha: { getNdpByMac: () => null },
    }));

    const result = await request(app, 'POST', '/api/devices/merge', { keepId: 'keep', dropId: 'drop' });

    assert.equal(result.status, 500);
    assert.equal(values.get('drop'), 'printer');
    assert.equal(values.has('keep'), false);
    assert.equal(saves, 2);
  });
});
