import { t, tVars, currentLang } from './i18n.js?v=__ASSET_VERSION__';
import { _BASE } from './utils.js?v=__ASSET_VERSION__';
import { apiFetch } from './auth-socket.js?v=__ASSET_VERSION__';

export function initBackupSettings(showStatus) {
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
      const data = await response.json();
      showStatus('backup-action-status', data.success ? t('settings.backup.restored') : data.error, data.success);
    } catch (error) {
      showStatus('backup-action-status', tVars('settings.error.withMessage', { message: error.message }), false);
    }
  }

  async function loadBackupList() {
    const list = document.getElementById('backup-list');
    try {
      const data = await (await apiFetch(_BASE + '/api/backup/list')).json();
      if (data.config) {
        document.getElementById('s-backup-interval').value = String(data.config.intervalHours);
        document.getElementById('s-backup-generations').value = String(data.config.maxGenerations);
      }
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

  document.getElementById('backup-config-save').addEventListener('click', async () => {
    try {
      await apiFetch(_BASE + '/api/backup/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          intervalHours: parseInt(document.getElementById('s-backup-interval').value, 10),
          maxGenerations: parseInt(document.getElementById('s-backup-generations').value, 10),
        }),
      });
      showStatus('backup-config-status', t('settings.status.saved'), true);
    } catch (error) {
      showStatus('backup-config-status', tVars('settings.error.withMessage', { message: error.message }), false);
    }
  });

  document.getElementById('backup-create-btn').addEventListener('click', async () => {
    try {
      const data = await (await apiFetch(_BASE + '/api/backup/create', { method: 'POST' })).json();
      showStatus('backup-action-status', data.success ? tVars('settings.backup.created', { name: data.name }) : t('settings.error.generic'), data.success);
      loadBackupList();
    } catch (error) {
      showStatus('backup-action-status', tVars('settings.error.withMessage', { message: error.message }), false);
    }
  });

  document.getElementById('backup-upload-input')?.addEventListener('change', async event => {
    const file = event.target.files[0];
    if (!file || !confirm(tVars('settings.backup.confirmUpload', { name: file.name }))) {
      event.target.value = '';
      return;
    }
    try {
      const data = await (await apiFetch(_BASE + '/api/backup/upload', {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: await file.arrayBuffer(),
      })).json();
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
