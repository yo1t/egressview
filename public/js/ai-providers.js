/**
 * Which AI provider is in use, and what to call it on screen.
 *
 * Split out of `ai-insights.js` (P2-97). The chat panel and the notification
 * settings both need this, and neither should have to import the other to get
 * it.
 */

import { tVars } from './i18n.js?v=__ASSET_VERSION__';
import { _BASE } from './utils.js?v=__ASSET_VERSION__';
import { apiFetch } from './auth-socket.js?v=__ASSET_VERSION__';

// Providers that transmit data externally and require per-request consent.
const CLOUD_CONSENT_PROVIDERS = ['anthropic', 'openai', 'bedrock'];
const PROVIDER_LABELS = { ollama: 'Ollama', anthropic: 'Anthropic', openai: 'OpenAI', bedrock: 'Amazon Bedrock' };

async function updateProviderLabel() {
  const el = document.getElementById('ai-analysis-privacy');
  if (!el) return;
  try {
    const response = await apiFetch(`${_BASE}/api/config/ai`);
    const config = await response.json().catch(() => ({}));
    if (!response.ok) return;
    const label = PROVIDER_LABELS[config.provider];
    // Only rename to a specific provider; leave the generic default when disabled.
    if (label) el.textContent = tVars('ai.analysis.privacyProvider', { provider: label });
  } catch { /* keep the generic default text */ }
}

export { CLOUD_CONSENT_PROVIDERS, PROVIDER_LABELS, updateProviderLabel };
