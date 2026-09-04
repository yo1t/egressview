import { t, tVars, currentLang } from './i18n.js?v=__ASSET_VERSION__';
import { _BASE } from './utils.js?v=__ASSET_VERSION__';
import { apiFetch } from './auth-socket.js?v=__ASSET_VERSION__';

export function initBackupSettings(showStatus) {
  const PRUNE_POLL_INTERVAL_MS = 1000;

  async function readJsonResponse(response) {
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.toLowerCase().includes('application/json')) {
      await response.text().catch(() => '');
      throw new Error(tVars('settings.backup.invalidResponse', { status: response.status }));
    }
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error(tVars('settings.backup.invalidResponse', { status: response.status }));
    }
    if (!response.ok) {
      throw new Error(body?.error || tVars('settings.backup.requestFailed', { status: response.status }));
    }
    return body;
  }

  function formatBytes(value) {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KiB', 'MiB', 'GiB', 'TiB'];
    let scaled = bytes;
    let unit = -1;
    do { scaled /= 1024; unit += 1; } while (scaled >= 1024 && unit < units.length - 1);
    return `${scaled.toFixed(scaled >= 10 ? 1 : 2)} ${units[unit]}`;
  }

  function renderCapacity(diagnostics) {
    const status = document.getElementById('backup-capacity-status');
    if (!status || !diagnostics?.summary) return;
    const normal = diagnostics.entries.filter(entry => entry.kind === 'normal').length;
    const migration = diagnostics.entries.filter(entry => entry.kind === 'migration').length;
    const summary = diagnostics.summary;
    const key = summary.migrationReady ? 'settings.backup.capacityReady' : 'settings.backup.capacityLow';
    status.textContent = tVars(key, {
      backup: formatBytes(summary.backupBytes),
      free: formatBytes(summary.freeBytes),
      required: formatBytes(summary.migrationRequiredBytes),
      shortfall: formatBytes(summary.shortfallBytes),
      normal,
      migration,
    });
    status.className = `settings-status multiline is-visible ${summary.migrationReady ? 'ok' : 'err'} backup-capacity-status`;
  }

  async function backupDownload(name) {
    try {
      const response = await apiFetch(_BASE + '/api/backup/download/' + encodeURIComponent(name));
      if (!response.ok) {
        showStatus('backup-action-status', tVars('settings.backup.downloadFailed', { detail: response.status }), false);
        return;
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      showStatus('backup-action-status', tVars('settings.backup.downloadFailed', { detail: error.message }), false);
    }
  }

  async function backupRestore(name) {
    if (!confirm(tVars('settings.backup.confirmRestore', { name }))) return;
    try {
      const response = await apiFetch(_BASE + '/api/backup/restore', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
      });
      const data = await readJsonResponse(response);
      showStatus('backup-action-status', data.success ? t('settings.backup.restored') : data.error, data.success);
    } catch (error) {
      showStatus('backup-action-status', tVars('settings.error.withMessage', { message: error.message }), false);
    }
  }

  async function loadBackupList() {
    const list = document.getElementById('backup-list');
    try {
      const data = await readJsonResponse(await apiFetch(_BASE + '/api/backup/list'));
      if (data.config) {
        document.getElementById('s-backup-interval').value = String(data.config.intervalHours);
        document.getElementById('s-backup-generations').value = String(data.config.maxGenerations);
        const maxBytes = document.getElementById('s-backup-max-bytes');
        const configuredBytes = String(data.config.maxBackupBytes || 0);
        if (![...maxBytes.options].some(option => option.value === configuredBytes)) {
          const custom = document.createElement('option');
          custom.value = configuredBytes;
          custom.textContent = formatBytes(data.config.maxBackupBytes);
          maxBytes.appendChild(custom);
        }
        maxBytes.value = configuredBytes;
        document.getElementById('s-backup-auto-prune').checked = data.config.autoPrune === true;
      }
      renderCapacity(data.diagnostics);
      if (!data.backups?.length) {
        const empty = document.createElement('div');
        empty.className = 'backup-list-empty';
        empty.textContent = t('settings.backup.none');
        list.replaceChildren(empty);
        return;
      }
      list.replaceChildren(...[...data.backups].reverse().map(backup => {
        const row = document.createElement('div');
        row.className = 'backup-list-row';
        const label = document.createElement('span');
        label.className = 'backup-list-label';
        const date = new Date(backup.created).toLocaleString(currentLang === 'ja' ? 'ja-JP' : 'en-US');
        label.textContent = `${date} (${(backup.size / 1024 / 1024).toFixed(1)} MB)`;
        const download = document.createElement('button');
        download.className = 'connect-btn backup-list-button';
        download.textContent = 'DL';
        download.addEventListener('click', () => backupDownload(backup.name));
        const restore = document.createElement('button');
        restore.className = 'connect-btn backup-list-button';
        restore.textContent = t('settings.backup.restore');
        restore.addEventListener('click', () => backupRestore(backup.name));
        row.append(label, download, restore);
        return row;
      }));
    } catch (error) {
      list.textContent = tVars('settings.error.withMessage', { message: error.message });
    }
  }

  async function waitForPruneJob(initialJob) {
    let job = initialJob;
    while (job?.status === 'running') {
      const progress = job.progress || {};
      showStatus('backup-prune-status', tVars('settings.backup.cleanupRunning', {
        completed: progress.completed || 0,
        total: progress.total || 0,
      }), true);
      await new Promise(resolve => setTimeout(resolve, PRUNE_POLL_INTERVAL_MS));
      const response = await apiFetch(_BASE + '/api/backup/prune/' + encodeURIComponent(job.id));
      const data = await readJsonResponse(response);
      job = data.job;
    }
    if (job?.status !== 'completed') {
      throw new Error(job?.error || t('settings.backup.cleanupFailed'));
    }
    return job;
  }

  document.getElementById('backup-config-save').addEventListener('click', async () => {
    try {
      await apiFetch(_BASE + '/api/backup/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          intervalHours: parseInt(document.getElementById('s-backup-interval').value, 10),
          maxGenerations: parseInt(document.getElementById('s-backup-generations').value, 10),
          maxBackupBytes: Number(document.getElementById('s-backup-max-bytes').value),
          autoPrune: document.getElementById('s-backup-auto-prune').checked,
        }),
      });
      showStatus('backup-config-status', t('settings.status.saved'), true);
    } catch (error) {
      showStatus('backup-config-status', tVars('settings.error.withMessage', { message: error.message }), false);
    }
  });

  document.getElementById('backup-create-btn').addEventListener('click', async () => {
    try {
      const data = await readJsonResponse(await apiFetch(_BASE + '/api/backup/create', { method: 'POST' }));
      showStatus('backup-action-status', data.success ? tVars('settings.backup.created', { name: data.name }) : t('settings.error.generic'), data.success);
      loadBackupList();
    } catch (error) {
      showStatus('backup-action-status', tVars('settings.error.withMessage', { message: error.message }), false);
    }
  });

  document.getElementById('backup-prune-btn').addEventListener('click', async () => {
    const button = document.getElementById('backup-prune-btn');
    button.disabled = true;
    try {
      const previewResponse = await apiFetch(_BASE + '/api/backup/prune', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ execute: false }),
      });
      const preview = await readJsonResponse(previewResponse);
      const previewJob = await waitForPruneJob(preview.job);
      const plan = previewJob.result;
      if (!plan.candidates.length) {
        showStatus('backup-prune-status', t(plan.blocked ? 'settings.backup.cleanupBlocked' : 'settings.backup.cleanupNone'), !plan.blocked);
        return;
      }
      if (!confirm(tVars('settings.backup.cleanupConfirm', {
        count: plan.candidates.length,
        size: formatBytes(plan.candidateBytes),
      }))) return;
      const executeResponse = await apiFetch(_BASE + '/api/backup/prune', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ execute: true }),
      });
      const executed = await readJsonResponse(executeResponse);
      const executeJob = await waitForPruneJob(executed.job);
      const result = executeJob.result;
      showStatus('backup-prune-status', tVars('settings.backup.cleanupDone', {
        count: result.deleted.length,
        size: formatBytes(result.deletedBytes),
      }), true);
      await loadBackupList();
    } catch (error) {
      showStatus('backup-prune-status', tVars('settings.error.withMessage', { message: error.message }), false);
    } finally {
      button.disabled = false;
    }
  });

  document.getElementById('backup-upload-input')?.addEventListener('change', async event => {
    const file = event.target.files[0];
    const maxUploadBytes = 100 * 1024 * 1024;
    if (file?.size > maxUploadBytes) {
      showStatus('backup-action-status', tVars('settings.error.withMessage', {
        message: 'Backup file exceeds the 100 MB upload limit',
      }), false);
      event.target.value = '';
      return;
    }
    if (!file || !confirm(tVars('settings.backup.confirmUpload', { name: file.name }))) {
      event.target.value = '';
      return;
    }
    try {
      const data = await readJsonResponse(await apiFetch(_BASE + '/api/backup/upload', {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: await file.arrayBuffer(),
      }));
      showStatus('backup-action-status', data.success ? t('settings.backup.restored') : data.error, data.success);
      loadBackupList();
    } catch (error) {
      showStatus('backup-action-status', tVars('settings.error.withMessage', { message: error.message }), false);
    }
    event.target.value = '';
  });
  document.querySelector('[data-tab="backup"]')?.addEventListener('click', loadBackupList);
  return { loadBackupList };
}
