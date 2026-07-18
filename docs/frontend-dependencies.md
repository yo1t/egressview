# Frontend JavaScript dependencies

This note tracks the frontend ES module graph. `main.js` is the single HTML
entry point; imports determine evaluation order and cache-busted asset URLs.

## Current load order

1. `i18n.js`
2. `utils.js`
3. `connections-panel.js`
4. `auth-socket.js`
5. `graph.js`
6. `settings.js`
   - `settings-backup.js`
   - `settings-sessions.js`
   - `settings-beacons.js`
   - `settings-legacy-routers.js`
   - `settings-slack.js`
7. `map-common.js`
8. `stats.js`
9. `time-filter.js`
10. `view-tabs.js`
11. `log.js`
12. `beacon.js`
13. `threat-popup.js`
14. `devices.js`
15. `notif-log.js`
16. `main.js`

`socket.io`, D3, and topojson are loaded before the app scripts.

## Shared translation catalog (P2-29)

Client and server translations have a single source of truth in
`src/data/i18n.json`. The server reads the JSON directly. For the browser,
`http-app.js` safely serializes the same catalog as the virtual ES module
`/js/i18n-data.js`; `i18n.js` imports that module with the application asset
version. This keeps the no-build deployment model while preventing client and
server translation dictionaries from drifting apart.

## Extracted submodules (P2-25 / P2-28)

`graph.js` and `stats.js` delegate to focused submodules; each is imported by
its parent (and re-exported there for legacy importers), so load order is
resolved by the ES module graph rather than script tags:

- `graph-helpers.js` — pure graph data transforms (no DOM/D3)
- `graph-panels.js` — tooltip and side-panel rendering; owns filter-tab state
- `graph-render.js` — D3 force simulation and node/link drawing; owns the
  simulation and SVG groups
- `stats-helpers.js` — pure stats aggregation/layout helpers (no DOM/i18n)
- `stats-charts.js` — pie / timeline / bar chart rendering; owns the
  stack/line chart-mode toggle
- `stats-map.js` — globe and flat-map rendering; owns all map state
  (projection, rotation, spin, particles, zoom/pan, resize bookkeeping)

## Settings sections (P2-39)

`settings.js` coordinates the modal, data sources, and general settings.
Backup/restore, authentication sessions, beacon detection, and the legacy
Yamaha/Cisco/ASUS controls each own their listeners and API calls in a focused section module.
The parent passes only the shared status renderer, avoiding circular imports.

## Reviewed HTML sinks (P2-27)

`npm run lint:innerhtml` audits every `innerHTML` assignment under
`public/js/`. P2-27 reduced the inventory to zero, and the empty allowlist in
`scripts/frontend-innerhtml-allowlist.json` makes any reintroduction fail CI.

New rendering code should use `textContent`, `createElement`, and explicit DOM
attributes. Translation strings must also remain plain text; line breaks and
emphasis belong in fixed HTML structure and CSS classes. If an HTML insertion
API ever becomes unavoidable, it requires an explicit security review and a
documented exception rather than silently widening the empty allowlist.

The connection log, notification log, device inventory, and threat detail
markup must not use inline `style` attributes. Their modules use CSS state
classes for visibility, sorting, and filtering; only runtime `top` and `left`
popup coordinates may use the style API. `test/unit/frontend-lint.test.js`
enforces this boundary.

## Temporary public API

The following APIs are intentionally mirrored under `window.EgressView.api`
while the frontend is still migrating toward modules:

- `apiFetch`
- `socket`
- `lookupNote`
- `showStatus`
- `buildGraph`
- `buildGraphFromConnections`
- `resizeGraph`
- `scheduleGraphAutoFit`
- `stopGraph`
- `updateStats`
- `initStatsMaps`
- `updateStatsMaps`
- `applyTimeFilter`
- `refreshCurrentTimeFilterView`
- `switchView`
- `updateLogView`
- `loadDevicesView`
- `renderDevicesTable`
- `loadNotifLog`

Initializers are registered under `window.EgressView.init`:

- `graph`
- `stats`
- `timeFilter`
- `viewTabs`
- `log`
- `devices`
- `notifLog`
- `main`

## Module migration notes

- Keep `main.js` last until socket handlers can import explicit dependencies.
- Move one area at a time: graph, stats, time filter, tabs, log, devices,
  notification log, then main.
- Preserve the smoke tests for major tabs and notification detail open/close
  during the migration.
- Remove `window.EgressView` mirrors only after all call sites use imports.
