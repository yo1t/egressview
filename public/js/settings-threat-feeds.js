// Shows which threat feeds answered, and which the Hub is matching without.
//
// The Hub matched connections with Feodo's C2 list entirely absent on
// 2026-08-29 -- abuse.ch was serving 503 from an expired certificate -- while
// every count on screen looked healthy, because the other three feeds are
// large. `Ready: 6998 IPs` is not an inventory (P3-54).
//
// Three states, shown three ways. A feed running on entries restored from the
// cache is matching, but it has not answered in this process, and collapsing
// that into "fine" is the silence this whole item exists to remove.

import { t, tVars } from './i18n.js?v=__ASSET_VERSION__';
import { _BASE } from './utils.js?v=__ASSET_VERSION__';
import { apiFetch } from './auth-socket.js?v=__ASSET_VERSION__';

const FEED_LABELS = {
  feodo: 'Feodo Tracker',
  threatfox: 'ThreatFox',
  urlhaus: 'URLhaus',
  spamhaus: 'Spamhaus DROP',
};

function when(timestamp) {
  if (!timestamp) return null;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
}

/**
 * @returns {{ kind: 'fresh'|'cached'|'absent', detail: string }}
 */
function classify(feed) {
  if (feed.lastSuccessAt) {
    return {
      kind: 'fresh',
      detail: tVars('settings.threat.feedFresh', {
        entries: feed.entries,
        at: when(feed.lastSuccessAt),
      }),
    };
  }
  if (feed.restoredAt) {
    // Matching, but on entries this process did not fetch. Saying "ok" here
    // would be the same silence in a different place.
    return {
      kind: 'cached',
      detail: tVars('settings.threat.feedCached', {
        entries: feed.entries,
        at: when(feed.restoredAt),
      }),
    };
  }
  return { kind: 'absent', detail: t('settings.threat.feedAbsent') };
}

function row(feed) {
  const { kind, detail } = classify(feed);
  const line = document.createElement('div');
  line.className = `threat-feed-row threat-feed-${kind}`;

  const icon = document.createElement('span');
  icon.className = 'threat-feed-icon';
  icon.textContent = kind === 'fresh' ? '✅' : kind === 'cached' ? '🗄️' : '⚠️';
  icon.setAttribute('aria-hidden', 'true');

  const name = document.createElement('span');
  name.className = 'threat-feed-name';
  name.textContent = FEED_LABELS[feed.name] || feed.name;

  const state = document.createElement('span');
  state.className = 'threat-feed-detail';
  state.textContent = detail;

  line.append(icon, name, state);

  if (feed.lastError) {
    const error = document.createElement('div');
    error.className = 'threat-feed-error';
    // The feed's own words. A rewritten message loses the status code that
    // says whose problem it is.
    error.textContent = tVars('settings.threat.feedError', { message: feed.lastError });
    line.appendChild(error);
  }
  return line;
}

function renderThreatFeedStatus(stats) {
  const container = document.getElementById('threat-feed-status');
  if (!container) return;
  container.replaceChildren();

  if (!stats || !Array.isArray(stats.feeds) || !stats.feeds.length) {
    // Never seen a feed. Different from "all four answered and found
    // nothing", and it has to read differently.
    const empty = document.createElement('div');
    empty.className = 'threat-feed-row threat-feed-absent';
    empty.textContent = t('settings.threat.feedNoneYet');
    container.appendChild(empty);
    return;
  }

  const heading = document.createElement('div');
  heading.className = 'threat-feed-heading';
  const missing = stats.feeds.filter(feed => !feed.lastSuccessAt).length;
  heading.textContent = missing
    ? tVars('settings.threat.feedSomeMissing', { missing, total: stats.feeds.length })
    : tVars('settings.threat.feedAllFresh', { total: stats.feeds.length });
  container.appendChild(heading);

  for (const feed of stats.feeds) container.appendChild(row(feed));
}

async function loadThreatFeedStatus() {
  try {
    const response = await apiFetch(`${_BASE}/api/status`);
    if (!response.ok) return;
    const body = await response.json().catch(() => ({}));
    renderThreatFeedStatus(body.threatIntel);
  } catch {
    // A settings pane that cannot reach the Hub has bigger problems, and they
    // are already reported elsewhere.
  }
}

export { classify, renderThreatFeedStatus, loadThreatFeedStatus };
