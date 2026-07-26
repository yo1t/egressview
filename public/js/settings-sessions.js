import { t, tVars } from './i18n.js?v=__ASSET_VERSION__';
import { _BASE, fmtTs } from './utils.js?v=__ASSET_VERSION__';
import { apiFetch } from './auth-socket.js?v=__ASSET_VERSION__';

export function initSessionSettings(showStatus) {
  // Roles are assigned by the server. Only the roles this build knows get a
// translated label; anything else is shown verbatim so an unexpected value is
// visible rather than disguised as a familiar one.
const KNOWN_ROLES = ['viewer', 'operator', 'admin'];

function roleLabel(role) {
  return KNOWN_ROLES.includes(role) ? t(`settings.sessions.role.${role}`) : String(role || '—');
}

function roleClass(role) {
  const suffix = KNOWN_ROLES.includes(role) ? role : 'unknown';
  return `settings-session-role settings-session-role-${suffix}`;
}

function textElement(tag, text, className = '') {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = text == null ? '' : String(text);
    return element;
  }

  async function loadSessionsList() {
    const box = document.getElementById('sessions-list');
    try {
      const { sessions } = await (await apiFetch(_BASE + '/api/auth/sessions')).json();
      if (!sessions?.length) {
        box.replaceChildren(textElement('span', t('settings.sessions.none'), 'settings-session-muted'));
        return;
      }
      box.replaceChildren(...sessions.map(session => {
        const row = textElement('div', '', 'settings-session-row');
        const label = textElement('span', session.deviceLabel || 'Unknown device', 'settings-session-label');
        label.appendChild(textElement(
          'span',
          session.authMethod === 'oidc' ? 'OIDC' : 'LOCAL',
          'settings-session-method'
        ));
        label.appendChild(textElement('span', roleLabel(session.role), roleClass(session.role)));
        if (session.current) label.appendChild(textElement('span', `● ${t('settings.sessions.current')}`, 'settings-session-current'));
        row.append(label, textElement('span', fmtTs(session.lastSeenAt), 'settings-session-seen'));
        if (!session.current) {
          const button = textElement('button', t('settings.sessions.revoke'), 'beacon-dismiss-btn settings-session-revoke');
          button.type = 'button';
          button.addEventListener('click', async () => {
            await apiFetch(`${_BASE}/api/auth/sessions/${encodeURIComponent(session.id)}/revoke`, { method: 'POST' });
            loadSessionsList();
          });
          row.appendChild(button);
        }
        return row;
      }));
    } catch (error) {
      box.replaceChildren(textElement('span', `Error: ${error.message}`, 'settings-session-muted'));
    }
  }

  document.getElementById('pw-change-btn').addEventListener('click', async () => {
    const button = document.getElementById('pw-change-btn');
    const currentPassword = document.getElementById('s-pw-current').value;
    const newPassword = document.getElementById('s-pw-new').value;
    if (newPassword.length < 14) return showStatus('pw-status', t('settings.password.tooShort'), false);
    button.disabled = true;
    try {
      const data = await (await apiFetch(_BASE + '/api/auth/change-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword, revokeOtherSessions: document.getElementById('s-pw-revoke-others').checked }),
      })).json();
      if (data.success) {
        document.getElementById('s-pw-current').value = '';
        document.getElementById('s-pw-new').value = '';
        showStatus('pw-status', tVars('settings.password.changed', { count: data.revoked }), true);
        loadSessionsList();
      } else showStatus('pw-status', data.error || 'Error', false);
    } catch (error) {
      showStatus('pw-status', tVars('settings.error.withMessage', { message: error.message }), false);
    } finally { button.disabled = false; }
  });

  document.getElementById('sessions-revoke-all-btn').addEventListener('click', async () => {
    try {
      const data = await (await apiFetch(_BASE + '/api/auth/sessions/revoke-all', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      })).json();
      showStatus('sessions-status', data.success ? `✓ ${data.revoked}` : (data.error || 'Error'), data.success);
      loadSessionsList();
    } catch (error) { showStatus('sessions-status', `Error: ${error.message}`, false); }
  });
  document.querySelector('[data-tab="general"]')?.addEventListener('click', loadSessionsList);
  return { loadSessionsList };
}
