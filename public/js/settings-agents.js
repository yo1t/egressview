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
  /**
   * Shows what unencrypted agent traffic exposes, and lets the operator accept
   * it.
   *
   * Listing the three concrete consequences rather than the word "insecure":
   * an operator can only accept a risk they can picture, and on a home LAN this
   * is a reasonable thing to accept knowingly.
   */
  async function loadTransport() {
    const box = document.getElementById('agent-transport-warning');
    try {
      const response = await apiFetch(_BASE + '/api/agents/transport');
      const transport = await response.json();
      if (!response.ok || transport.secure) {
        box.hidden = true;
        return;
      }
      const list = document.createElement('ul');
      list.className = 'settings-warning-list';
      for (const key of transport.risks) list.appendChild(textElement('li', t(key)));

      const label = document.createElement('label');
      label.className = 'settings-checkbox-row';
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.id = 'agent-allow-plaintext';
      toggle.checked = transport.accepted === true;
      toggle.addEventListener('change', async () => {
        const result = await apiFetch(_BASE + '/api/agents/transport', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ allowPlaintext: toggle.checked }),
        });
        const body = await result.json();
        showStatus('agents-status', result.ok ? t('settings.agents.transportSaved') : body.error, result.ok);
        if (!result.ok) toggle.checked = !toggle.checked;
      });
      label.append(toggle, textElement('span', t('agent.transport.consent')));

      box.replaceChildren(
        textElement('div', t('agent.transport.http'), 'settings-warning-title'),
        list,
        label,
        textElement('p', t('agent.transport.consent.hint'), 'settings-field-hint'),
        textElement('p', t('agent.transport.fix'), 'settings-field-hint')
      );
      box.hidden = false;
    } catch {
      box.hidden = true;
    }
  }

  /**
   * Pending requests. Approval is the step that turns a claim into a
   * credential, so the row shows what the applicant said about itself and
   * warns when approving would collide with a machine already registered.
   */
  async function loadRequests() {
    const block = document.getElementById('agent-requests-block');
    const box = document.getElementById('agent-requests-list');
    try {
      const response = await apiFetch(_BASE + '/api/agents/enrollment-requests');
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not load requests');
      const requests = body.requests || [];
      block.hidden = requests.length === 0;
      if (!requests.length) return;

      box.replaceChildren(...requests.map(request => {
        const row = textElement('div', '', 'settings-agent-row');
        const details = textElement('span', '', 'settings-agent-details');
        details.append(
          textElement('strong', request.hostName, 'settings-agent-host'),
          textElement(
            'span',
            `${request.platform} ${request.osVersion} · ${request.agentVersion}`,
            'settings-session-muted'
          ),
          textElement('span', tVars('settings.agents.requestedAt', { time: fmtTs(request.createdAt) }), 'settings-session-seen')
        );
        if (request.duplicateHostName) {
          details.appendChild(textElement('span', t('settings.agents.duplicateHost'), 'settings-agent-revoked'));
        }
        row.appendChild(details);

        const approve = textElement('button', t('settings.agents.approve'), 'connect-btn settings-inline-button');
        approve.type = 'button';
        approve.addEventListener('click', async () => {
          // Replacing is offered only when it is actually the situation, so the
          // question is never asked in the abstract.
          let replaceExisting = false;
          if (request.duplicateHostName) {
            replaceExisting = confirm(tVars('settings.agents.replaceConfirm', { host: request.hostName }));
          }
          const result = await apiFetch(
            `${_BASE}/api/agents/enrollment-requests/${encodeURIComponent(request.requestId)}/approve`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ replaceExisting }),
            }
          );
          const resultBody = await result.json();
          showStatus('agents-status', result.ok ? t('settings.agents.approved') : resultBody.error, result.ok);
          if (result.ok) { await loadRequests(); await loadAgents(); }
        });

        const reject = textElement('button', t('settings.agents.reject'), 'beacon-dismiss-btn');
        reject.type = 'button';
        reject.addEventListener('click', async () => {
          const result = await apiFetch(
            `${_BASE}/api/agents/enrollment-requests/${encodeURIComponent(request.requestId)}/reject`,
            { method: 'POST' }
          );
          showStatus('agents-status', result.ok ? t('settings.agents.rejected') : t('settings.agents.rejectFailed'), result.ok);
          if (result.ok) await loadRequests();
        });

        row.append(approve, reject);
        return row;
      }));
    } catch (error) {
      block.hidden = false;
      box.replaceChildren(textElement('span', error.message, 'settings-session-muted'));
    }
  }

  // Read-only: a revoked enrolment cannot be resumed, so there is nothing to
  // act on here. Rows are kept rather than deleted -- the observations they
  // sent still reference them.
  function renderRevokedAgents(revoked) {
    const box = document.getElementById('revoked-agents-list');
    if (!box) return;
    if (!revoked.length) {
      box.replaceChildren(
        textElement('span', t('settings.log.noRevokedAgents'), 'settings-session-muted')
      );
      return;
    }
    box.replaceChildren(...revoked.map(agent => {
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
          tVars('settings.agents.revokedAt', { time: fmtTs(agent.revokedAt) }),
          'settings-agent-revoked'
        )
      );
      row.appendChild(details);
      return row;
    }));
  }

  async function loadAgents() {
    const box = document.getElementById('agents-list');
    try {
      const response = await apiFetch(_BASE + '/api/agents');
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not load Agents');
      const agents = body.agents || [];
      updateAgentSources(agents);
      // Revoked agents go to the log screen. Two thirds of this list was
      // finished registrations, so the two agents actually running were being
      // picked out of nine rows.
      renderRevokedAgents(agents.filter(agent => agent.revokedAt));
      const live = agents.filter(agent => !agent.revokedAt);
      if (!live.length) {
        box.replaceChildren(textElement('span', t('settings.agents.none'), 'settings-session-muted'));
        return;
      }
      box.replaceChildren(...live.map(agent => {
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
            tVars('settings.agents.lastSeen', { time: fmtTs(agent.lastSeenAt) }),
            'settings-session-seen'
          )
        );
        row.appendChild(details);
        {
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
      await loadRequests();
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

  function loadAll() {
    loadTransport();
    loadRequests();
    loadAgents();
  }

  // Lives on the L3/L4 tab: an operator thinks about data sources in one place.
  document.querySelector('[data-tab="l3l4"]')?.addEventListener('click', loadAll);
  // The log screen reads the same list, so opening it directly still fills it.
  document.querySelector('[data-tab="log"]')?.addEventListener('click', loadAgents);
  return { loadAgents, loadRequests, loadTransport, loadAll };
}
