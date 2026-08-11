'use strict';

const fs = require('fs');
const { MIGRATED_IDS, SUPPORTED_KINDS, generateRouterId, isValidRouterId } = require('./router-id');
const configIo = require('./config');
const { normalizeRouterHostName } = require('./pollers/router-prompt');

const MAX_ROUTERS = 10;

const DEFAULT_NAMES = Object.freeze({
  yamaha: 'Yamaha RTX',
  cisco: 'Cisco IOS',
  conntrack: 'Linux conntrack',
});

function legacyRouter(data, kind) {
  const legacy = data?.[kind];
  if (!legacy || (!legacy.ip && !legacy.user)) return null;
  return {
    id: MIGRATED_IDS[kind],
    kind,
    displayName: kind === 'yamaha' ? 'Yamaha RTX' : 'Cisco IOS',
    hostName: '',
    ip: legacy.ip || '',
    user: legacy.user || '',
    pass: legacy.pass || '',
    enablePass: kind === 'cisco' ? (legacy.enablePass || '') : '',
    nat: kind === 'yamaha' ? String(legacy.nat || '100') : '',
    hostFp: legacy.hostFp || '',
    enabled: kind === 'yamaha' ? legacy.enabled !== false : legacy.enabled === true,
    createdAt: Date.now(),
  };
}

function normalizeRouterRecord(input, { existing = null, knownIds = [] } = {}) {
  const kind = String(input?.kind || existing?.kind || '').toLowerCase();
  if (!SUPPORTED_KINDS.includes(kind)) throw new Error('unsupported router kind');
  const id = existing?.id || input?.id || generateRouterId(kind, knownIds);
  if (!isValidRouterId(id)) throw new Error('invalid routerId');
  if (existing && kind !== existing.kind) throw new Error('router kind cannot be changed');

  const ip = String(input?.ip ?? existing?.ip ?? '').trim();
  const user = String(input?.user ?? existing?.user ?? '').trim();
  const displayName = String(input?.displayName ?? existing?.displayName ?? '').trim().slice(0, 80)
    || DEFAULT_NAMES[kind];
  const passInput = typeof input?.pass === 'string' ? input.pass : '';
  const enableInput = typeof input?.enablePass === 'string' ? input.enablePass : '';
  const ipChanged = !!existing && ip !== existing.ip;
  const hostName = ipChanged ? '' : normalizeRouterHostName(input?.hostName ?? existing?.hostName);
  const nat = kind === 'yamaha' ? String(input?.nat ?? existing?.nat ?? '100').trim() : '';
  if (kind === 'yamaha' && !/^\d{1,6}$/.test(nat)) throw new Error('invalid NAT descriptor');

  return {
    id,
    kind,
    displayName,
    hostName,
    ip,
    user,
    pass: passInput || existing?.pass || '',
    enablePass: kind === 'cisco' ? (enableInput || existing?.enablePass || '') : '',
    nat,
    hostFp: ipChanged ? '' : (existing?.hostFp || input?.hostFp || ''),
    enabled: input?.enabled !== undefined ? input.enabled === true : (existing?.enabled ?? true),
    createdAt: existing?.createdAt || Number(input?.createdAt) || Date.now(),
  };
}

function loadRouterConfig(data = {}) {
  const tombstones = [...new Set((data.routerTombstones || []).filter(isValidRouterId))];
  if (Array.isArray(data.routers)) {
    const routers = [];
    for (const raw of data.routers.slice(0, MAX_ROUTERS)) {
      if (!isValidRouterId(raw?.id) || routers.some(r => r.id === raw.id) || tombstones.includes(raw.id)) continue;
      try { routers.push(normalizeRouterRecord(raw, { knownIds: [...tombstones, ...routers.map(r => r.id)] })); }
      catch { /* invalid records stay out of the runtime registry */ }
    }
    return { routers, tombstones, migrated: false };
  }
  const routers = ['yamaha', 'cisco'].map(kind => legacyRouter(data, kind)).filter(Boolean);
  return { routers, tombstones, migrated: routers.length > 0 };
}

function migrateRouterConfigFile(file = configIo.DEFAULT_CONFIG_FILE) {
  const data = configIo.loadFileOrThrow(file);
  const loaded = loadRouterConfig(data);
  if (!loaded.migrated) return loaded;

  const baseBackupPath = `${file}.pre-routers-v1.bak`;
  const backupPath = fs.existsSync(baseBackupPath) ? `${baseBackupPath}.${Date.now()}` : baseBackupPath;
  try {
    fs.copyFileSync(file, backupPath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(backupPath, 0o600);
    configIo.loadFileOrThrow(backupPath);
    configIo.saveFile({
      ...data,
      routers: loaded.routers,
      routerTombstones: loaded.tombstones,
    }, file);
    const verified = loadRouterConfig(configIo.loadFileOrThrow(file));
    if (JSON.stringify(verified.routers) !== JSON.stringify(loaded.routers)) {
      throw new Error('router config verification failed');
    }
    return { ...verified, migrated: true, backupPath };
  } catch (err) {
    if (fs.existsSync(backupPath)) {
      try {
        fs.copyFileSync(backupPath, file);
        fs.chmodSync(file, 0o600);
      } catch {}
    }
    throw err;
  }
}

function publicRouter(record, status = {}) {
  return {
    id: record.id,
    kind: record.kind,
    displayName: record.displayName,
    hostName: record.hostName || '',
    ip: record.ip,
    user: record.user,
    nat: record.kind === 'yamaha' ? record.nat : undefined,
    enabled: record.enabled,
    passSet: !!record.pass,
    enablePassSet: record.kind === 'cisco' && !!record.enablePass,
    ready: !!status.ready,
    state: status.state || (record.enabled ? 'connecting' : 'disabled'),
    message: status.message || '',
    lastSuccessAt: status.lastSuccessAt || null,
    lastError: status.lastError || null,
    sessionCount: status.sessionCount || 0,
  };
}

module.exports = {
  MAX_ROUTERS,
  loadRouterConfig,
  migrateRouterConfigFile,
  normalizeRouterRecord,
  publicRouter,
};
