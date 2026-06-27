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
