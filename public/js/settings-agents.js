import { t, tVars } from './i18n.js?v=__ASSET_VERSION__';
import { _BASE, fmtTs } from './utils.js?v=__ASSET_VERSION__';
import { apiFetch } from './auth-socket.js?v=__ASSET_VERSION__';
import { updateAgentSources } from './display-scope.js?v=__ASSET_VERSION__';

function textElement(tag, text, className = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text == null ? '' : String(text);
  return element;
}

export function initAgentSettings(showStatus) {
  async function loadAgents() {
    const box = document.getElementById('agents-list');
    try {
      const response = await apiFetch(_BASE + '/api/agents');
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not load Agents');
      const agents = body.agents || [];
      updateAgentSources(agents);
      if (!agents.length) {
        box.replaceChildren(textElement('span', t('settings.agents.none'), 'settings-session-muted'));
        return;
      }
      box.replaceChildren(...agents.map(agent => {
        const row = textElement('div', '', 'settings-agent-row');
        const details = textElement('span', '', 'settings-agent-details');
        details.append(
          textElement('strong', agent.hostName, 'settings-agent-host'),
          textElement(
            'span',
            `${agent.platform} ${agent.osVersion} · ${agent.agentVersion}`,
            'settings-session-muted'
          ),
          textElement(
            'span',
            agent.revokedAt
              ? tVars('settings.agents.revokedAt', { time: fmtTs(agent.revokedAt) })
              : tVars('settings.agents.lastSeen', { time: fmtTs(agent.lastSeenAt) }),
            agent.revokedAt ? 'settings-agent-revoked' : 'settings-session-seen'
          )
        );
        row.appendChild(details);
        if (!agent.revokedAt) {
          const revoke = textElement('button', t('settings.agents.revoke'), 'beacon-dismiss-btn');
          revoke.type = 'button';
          revoke.addEventListener('click', async () => {
            if (!confirm(tVars('settings.agents.revokeConfirm', { host: agent.hostName }))) return;
            const result = await apiFetch(
              `${_BASE}/api/agents/${encodeURIComponent(agent.agentId)}/revoke`,
              { method: 'POST' }
            );
            const resultBody = await result.json();
            showStatus('agents-status', result.ok ? t('settings.agents.revoked') : resultBody.error, result.ok);
            if (result.ok) await loadAgents();
          });
          row.appendChild(revoke);
        }
        return row;
      }));
    } catch (error) {
      box.replaceChildren(textElement('span', error.message, 'settings-session-muted'));
    }
  }

  document.getElementById('agent-enrollment-create-btn').addEventListener('click', async () => {
    const button = document.getElementById('agent-enrollment-create-btn');
    button.disabled = true;
    try {
      const response = await apiFetch(_BASE + '/api/agents/enrollment-tokens', { method: 'POST' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not create enrollment code');
      prompt(t('settings.agents.codePrompt'), body.code);
      showStatus(
        'agents-status',
        tVars('settings.agents.codeCreated', { time: fmtTs(body.expiresAt) }),
        true
      );
    } catch (error) {
      showStatus('agents-status', error.message, false);
    } finally {
      button.disabled = false;
    }
  });

  document.querySelector('[data-tab="general"]')?.addEventListener('click', loadAgents);
  return { loadAgents };
}
