# Frontend JavaScript dependencies

This note tracks the pre-module frontend script wiring for P2-13/P2-13a.
EgressView still loads classic scripts from `public/index.html`, so load order
and top-level side effects matter. The temporary public surface is
`window.EgressView`.

## Current load order

1. `i18n.js`
2. `utils.js`
3. `connections-panel.js`
4. `auth-socket.js`
5. `graph.js`
6. `settings.js`
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
