import { t, tVars } from './i18n.js?v=__ASSET_VERSION__';
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

function configuredDomains() {
  const field = document.getElementById('s-oidc-domains');
  return field ? splitList(field.value) : [];
}

// P2-61 Phase 0: an active domain allowlist grants every matching user full
// administrator access, so surface it next to the field that configures it.
// Warn on any domain present in the field — saved, or still being typed —
// rather than only on the saved-and-enabled state the server reports, so the
// operator sees the consequence before committing to it.
function renderDomainWarning(warnings) {
  const box = document.getElementById('oidc-domain-warning');
  if (!box) return;
  const reported = (warnings || []).find(item => item && item.code === 'domain_allowlist_grants_admin');
  const typed = configuredDomains();
  const domains = typed.length ? typed : (reported ? reported.domains || [] : []);
  if (!domains.length) {
    box.hidden = true;
    box.textContent = '';
    return;
  }
  box.textContent = tVars('settings.security.domainsActiveWarning', {
    domains: domains.join(', '),
  });
  box.hidden = false;
}

// The local administrator never changes behaviour: it is always available.
// Only the wording changes, because "emergency fallback" is misleading while
// it is the single sign-in path. Switch on the saved OIDC state alone — the
// app cannot tell whether it is reachable from the internet, and guessing
// would hide real information exactly when it matters.
function renderLocalAdminCopy(oidcEnabled) {
  const box = document.querySelector('[data-i18n^="settings.security.local"]');
  if (!box) return;
  const key = oidcEnabled ? 'settings.security.local' : 'settings.security.localOnly';
  // Keep data-i18n in sync so a later language switch re-renders the same variant.
  box.dataset.i18n = key;
  box.textContent = t(key);
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
      renderLocalAdminCopy(oidc.enabled === true);
      renderDomainWarning(body.warnings);
      await loadAuditEvents();
    } catch (error) {
      showStatus('oidc-status', error.message, false);
    }
  }

  // Keep the advisory in step with what the operator is typing, so the
  // consequence is visible before the configuration is saved.
  document.getElementById('s-oidc-domains').addEventListener('input', () => renderDomainWarning([]));

  document.getElementById('oidc-save-btn').addEventListener('click', async () => {
    const button = document.getElementById('oidc-save-btn');
    const enabled = document.getElementById('s-oidc-enabled').checked;
    const allowedDomains = splitList(document.getElementById('s-oidc-domains').value);
    // Re-state the consequence at the moment it takes effect.
    if (enabled && allowedDomains.length &&
        !globalThis.confirm(tVars('settings.security.domainsConfirm', {
          domains: allowedDomains.join(', '),
        }))) {
      return;
    }
    button.disabled = true;
    try {
      const response = await apiFetch(_BASE + '/api/auth/security-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled,
          clientId: document.getElementById('s-oidc-client-id').value.trim(),
          clientSecret: document.getElementById('s-oidc-client-secret').value,
          allowedEmails: splitList(document.getElementById('s-oidc-emails').value),
          allowedDomains,
        }),
      });
      const body = await response.json();
      showStatus(
        'oidc-status',
        response.ok ? t('settings.status.saved') : body.error,
        response.ok
      );
      if (response.ok) {
        renderDomainWarning(body.warnings);
        await loadSecurityConfig();
      }
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
