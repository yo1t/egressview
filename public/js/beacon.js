// ─── Beacon detection UI ──────────────────────────────────────────────────────

var beaconData    = [];   // current candidates from API
var beaconListOpen = false;

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtBeaconInterval(ms) {
  if (ms < 60_000)    return tVars('beacon.interval.sec', { count: Math.round(ms / 1000) });
  if (ms < 3600_000)  return tVars('beacon.interval.min', { count: Math.round(ms / 60_000) });
  const h = Math.floor(ms / 3600_000);
  const m = Math.round((ms % 3600_000) / 60_000);
  return m > 0
    ? tVars('beacon.interval.hourMin', { hours: h, minutes: m })
    : tVars('beacon.interval.hour', { count: h });
}

function beaconSrcLabel(srcIp) {
  // Try to resolve a friendly name from allConnections
  if (typeof allConnections !== 'undefined') {
    const hit = allConnections.find(c => c.src === srcIp);
    if (hit) {
      const mdns = hit.srcMdnsName ? hit.srcMdnsName.replace(/\.local$/, '') : null;
      const dns  = hit.srcDnsName  ? hit.srcDnsName.split('.')[0]            : null;
      const name = mdns || dns || null;
      if (name) return `${esc(name)} (${esc(srcIp)})`;
    }
  }
  return esc(srcIp);
}

function beaconCovClass(cov) {
  if (cov < 0.1) return 'beacon-cov-low';
  if (cov < 0.3) return 'beacon-cov-mid';
  return 'beacon-cov-high';
}

// ── API ───────────────────────────────────────────────────────────────────────

async function loadBeacons() {
  try {
    const res  = await apiFetch(`${_BASE}/api/beacons`);
    const data = await res.json();
    beaconData = (data.beacons || []).filter(b => b.status !== 'dismissed');
  } catch (e) {
    beaconData = [];
  }
  renderBeaconBanner();
}

async function dismissBeacon(id) {
  try {
    await apiFetch(`${_BASE}/api/beacons/${id}/dismiss`, { method: 'POST' });
    beaconData = beaconData.filter(b => b.id !== id);
    renderBeaconBanner();
  } catch (e) {
    // ignore
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function renderBeaconBanner() {
  const banner  = document.getElementById('beacon-banner');
  const label   = document.getElementById('beacon-banner-label');
  const chevron = document.getElementById('beacon-banner-chevron');
  const list    = document.getElementById('beacon-list');
  if (!banner) return;

  if (beaconData.length === 0) {
    banner.style.display = 'none';
    beaconListOpen = false;
    return;
  }

  banner.style.display = 'block';
  label.textContent = tVars('beacon.banner', { count: beaconData.length });
  chevron.classList.toggle('open', beaconListOpen);
  list.style.display = beaconListOpen ? 'block' : 'none';
  if (beaconListOpen) renderBeaconList(list);
}

function renderBeaconList(container) {
  const rows = beaconData.map(b => {
    const dst     = b.dstHost && b.dstHost !== b.dst
                    ? `${esc(b.dstHost)}<br><span style="color:var(--muted);font-size:10px">${esc(b.dst)}</span>`
                    : esc(b.dst);
    const covCls  = beaconCovClass(b.intervalCov);
    const covPct  = Math.round(b.intervalCov * 100);
    const first   = fmtTs(b.firstSeen);
    const last    = fmtTs(b.lastSeen);
    return `<tr>
      <td>${beaconSrcLabel(b.src)}</td>
      <td>${dst}</td>
      <td style="white-space:nowrap">${esc(fmtBeaconInterval(b.intervalMs))}</td>
      <td><span class="${covCls}">${covPct}%</span></td>
      <td style="color:var(--muted)">${b.obsCount}</td>
      <td style="color:var(--muted);font-size:10px;white-space:nowrap">${first}<br>${last}</td>
      <td><button class="beacon-dismiss-btn" data-id="${b.id}">${esc(t('beacon.dismiss'))}</button></td>
    </tr>`;
  }).join('');

  container.innerHTML = `
    <table class="beacon-table">
      <thead><tr>
        <th>${esc(t('beacon.col.src'))}</th>
        <th>${esc(t('beacon.col.dst'))}</th>
        <th>${esc(t('beacon.col.interval'))}</th>
        <th title="${esc(t('beacon.col.regularityTitle'))}">${esc(t('beacon.col.regularity'))}</th>
        <th>${esc(t('beacon.col.obs'))}</th>
        <th>${esc(t('beacon.col.firstLast'))}</th>
        <th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  container.querySelectorAll('.beacon-dismiss-btn').forEach(btn => {
    btn.addEventListener('click', () => dismissBeacon(Number(btn.dataset.id)));
  });
}

// ── Toggle ────────────────────────────────────────────────────────────────────

document.getElementById('beacon-banner-bar').addEventListener('click', () => {
  beaconListOpen = !beaconListOpen;
  renderBeaconBanner();
});
