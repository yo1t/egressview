import { t } from './i18n.js?v=__ASSET_VERSION__';
import { _BASE } from './utils.js?v=__ASSET_VERSION__';
import { apiFetch } from './auth-socket.js?v=__ASSET_VERSION__';

export function initSlackSettings(showStatus) {
// ─── Slack notification settings UI ──────────────────────────────────────────
document.getElementById('slack-verify-btn').addEventListener('click', async () => {
  const btn = document.getElementById('slack-verify-btn');
  const token = document.getElementById('s-slack-token').value.trim();
  // If token field is empty, server will use the stored token
  btn.disabled = true;
  try {
    const r = await apiFetch(_BASE+'/api/slack/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token || undefined }),
    });
    const data = await r.json();
    const info = document.getElementById('slack-workspace-info');
    if (data.ok) {
      info.className = 'slack-info is-visible ok';
      info.textContent = `✓ ${data.team} (${data.user})`;
    } else {
      info.className = 'slack-info is-visible err';
      info.textContent = '✗ ' + (data.error || 'Failed');
    }
  } catch (e) {
    showStatus('slack-status', e.message, false);
  } finally { btn.disabled = false; }
});

document.getElementById('slack-lookup-btn').addEventListener('click', async () => {
  const btn = document.getElementById('slack-lookup-btn');
  const username = document.getElementById('s-slack-username').value.trim();
  const token = document.getElementById('s-slack-token').value.trim();
  if (!username) { showStatus('slack-status', 'Username required', false); return; }
  btn.disabled = true;
  try {
    // token omitted → server reads from stored config
    const r = await apiFetch(_BASE+'/api/slack/lookup-user', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, token: token || undefined }),
    });
    const data = await r.json();
    const info = document.getElementById('slack-user-info');
    if (data.ok) {
      const displayName = data.realName || data.displayName || data.name;
      info.className = 'slack-info is-visible ok';
      info.textContent = `✓ ${displayName} (${data.userId})`;
      document.getElementById('s-slack-userid').value = data.userId;
      document.getElementById('s-slack-username').value = displayName;
    } else {
      info.className = 'slack-info is-visible err';
      info.textContent = '✗ ' + (data.error === 'user_not_found' ? t('settings.slack.userNotFound') : data.error);
    }
  } catch (e) {
    showStatus('slack-status', e.message, false);
  } finally { btn.disabled = false; }
});

document.getElementById('slack-save-btn').addEventListener('click', async () => {
  const btn = document.getElementById('slack-save-btn');
  btn.disabled = true; btn.textContent = t('settings.btn.saving');
  try {
    const token = document.getElementById('s-slack-token').value.trim();
    await apiFetch(_BASE+'/api/config/slack', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: document.getElementById('s-slack-enabled').checked,
        token: token || undefined,
        userId: document.getElementById('s-slack-userid').value.trim(),
        displayName: document.getElementById('s-slack-username').value.trim(),
        cooldownMinutes: parseInt(document.getElementById('s-slack-cooldown').value),
      }),
    });
    if (token) document.getElementById('s-slack-token').value = '';
    showStatus('slack-status', t('settings.status.saved'), true);
  } catch (e) {
    showStatus('slack-status', t('err.serverGeneric') + e.message, false);
  } finally {
    btn.disabled = false; btn.textContent = t('settings.btn.save');
  }
});

document.getElementById('slack-test-btn').addEventListener('click', async () => {
  const btn = document.getElementById('slack-test-btn');
  btn.disabled = true; btn.textContent = t('settings.slack.test.sending');
  try {
    const r = await apiFetch(_BASE+'/api/slack/test', { method: 'POST', body: '{}' });
    const data = await r.json();
    if (data.success) {
      showStatus('slack-status', t('settings.slack.test.ok'), true);
    } else {
      showStatus('slack-status', t('settings.slack.test.fail') + (data.error || 'error'), false);
    }
  } catch (e) {
    showStatus('slack-status', t('settings.slack.test.fail') + e.message, false);
  } finally {
    btn.disabled = false; btn.textContent = t('settings.slack.test');
  }
});

(function loadSlackSettings() {
  apiFetch(_BASE+'/api/config/slack').then(async r => {
    const data = await r.json();
    if (!data) return;
    document.getElementById('s-slack-enabled').checked = !!data.config?.enabled;
    if (data.config?.userId) document.getElementById('s-slack-userid').value = data.config.userId;
    if (data.config?.displayName) document.getElementById('s-slack-username').value = data.config.displayName;
    if (data.config?.cooldownMinutes) document.getElementById('s-slack-cooldown').value = String(data.config.cooldownMinutes);
    if (data.config?.tokenSet) {
      document.getElementById('s-slack-token').placeholder = t('settings.pass.saved');
      document.getElementById('s-slack-token').dataset.saved = 'true';
    }
  }).catch(() => {});
})();

}

