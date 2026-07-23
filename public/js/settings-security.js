import { t } from './i18n.js?v=__ASSET_VERSION__';
import { _BASE, fmtTs } from './utils.js?v=__ASSET_VERSION__';
import { apiFetch } from './auth-socket.js?v=__ASSET_VERSION__';

function splitList(value) {
  return [...new Set(String(value || '').split(',').map(item => item.trim()).filter(Boolean))];
}

function textElement(tag, text, className = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text == null ? '' : String(text);
  return element;
}

export function initSecuritySettings(showStatus) {
  async function loadAuditEvents() {
    const box = document.getElementById('audit-events-list');
    try {
      const response = await apiFetch(_BASE + '/api/auth/audit-events?limit=30');
      const body = await response.json();
      const events = body.events || [];
      if (!events.length) {
        box.replaceChildren(textElement('span', t('settings.security.auditEmpty'), 'settings-session-muted'));
        return;
      }
      box.replaceChildren(...events.map(event => {
        const row = textElement('div', '', 'settings-audit-row');
        row.append(
          textElement('span', event.eventType, 'settings-audit-event'),
          textElement('span', event.outcome, `settings-audit-outcome ${event.outcome}`),
          textElement('span', event.authMethod || '—', 'settings-session-muted'),
          textElement('span', fmtTs(event.createdAt), 'settings-session-seen')
        );
        return row;
      }));
    } catch (error) {
      box.replaceChildren(textElement('span', error.message, 'settings-session-muted'));
    }
  }

  async function loadSecurityConfig() {
    try {
      const response = await apiFetch(_BASE + '/api/auth/security-config');
      const body = await response.json();
      const oidc = body.oidc || {};
      document.getElementById('s-oidc-enabled').checked = oidc.enabled === true;
      document.getElementById('s-oidc-client-id').value = oidc.clientId || '';
      const secret = document.getElementById('s-oidc-client-secret');
      secret.value = '';
      secret.placeholder = oidc.clientSecretSet ? t('settings.pass.saved') : '';
      document.getElementById('s-oidc-emails').value = (oidc.allowedEmails || []).join(', ');
      document.getElementById('s-oidc-domains').value = (oidc.allowedDomains || []).join(', ');
      await loadAuditEvents();
    } catch (error) {
      showStatus('oidc-status', error.message, false);
    }
  }

  document.getElementById('oidc-save-btn').addEventListener('click', async () => {
    const button = document.getElementById('oidc-save-btn');
    button.disabled = true;
    try {
      const response = await apiFetch(_BASE + '/api/auth/security-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: document.getElementById('s-oidc-enabled').checked,
          clientId: document.getElementById('s-oidc-client-id').value.trim(),
          clientSecret: document.getElementById('s-oidc-client-secret').value,
          allowedEmails: splitList(document.getElementById('s-oidc-emails').value),
          allowedDomains: splitList(document.getElementById('s-oidc-domains').value),
        }),
      });
      const body = await response.json();
      showStatus(
        'oidc-status',
        response.ok ? t('settings.status.saved') : body.error,
        response.ok
      );
      if (response.ok) await loadSecurityConfig();
    } catch (error) {
      showStatus('oidc-status', error.message, false);
    } finally {
      button.disabled = false;
    }
  });

  document.getElementById('oidc-test-btn').addEventListener('click', async () => {
    const response = await apiFetch(_BASE + '/api/auth/oidc/test', { method: 'POST' });
    const body = await response.json();
    showStatus('oidc-status', response.ok ? `✓ ${body.issuer}` : body.error, response.ok);
  });

  document.querySelector('[data-tab="general"]')?.addEventListener('click', loadSecurityConfig);
  return { loadSecurityConfig };
}
