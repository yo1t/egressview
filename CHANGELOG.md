# Changelog

All notable changes to EgressView are documented here.

## [Unreleased]

## [1.4.0] - 2026-07-18

### Added

- Added CSV and JSON export for filtered connection history.
- Added explicit, rate-limited threat investigation through AbuseIPDB, VirusTotal, and AlienVault OTX, with server-side caching and no automatic external submission.
- Added a Linux conntrack router preview over SSH, including command/procfs parsers and Docker integration coverage. Physical router validation remains pending.
- Added a responsive mobile monitoring view for router health, Graph Map, Statistics, Connection Log, Devices, and Detection Log.
- Added English and Japanese REST API and architecture references, plus a dedicated GitHub Pages deployment workflow.
- Added an operational observation-consistency monitor for validating multi-router data before schema contraction.

### Changed

- Completed the schema v5 expand-contract migration by removing the legacy `connections.source` column after a consistency gate; router observations now use `connection_observations` exclusively.
- Unified browser and server translations in one catalog and split large graph, statistics, settings, history, and authentication modules into focused components.
- Replaced frontend HTML-string rendering with DOM APIs and removed the remaining inline-style CSP exception.
- Added schema-based validation to HTTP routes and made graph summaries available independently of the Statistics view.
- Reduced summary-query work through bounded aggregation and caching while preserving complete SQLite history.

### Security and Reliability

- Database restore now fails closed: the upload, safety backup, restored database, and post-restore state are integrity-checked before the service accepts the restore.
- Configuration writes now report failures to callers and roll back in-memory state instead of reporting a false success.
- Schema v5 migration requires a verified pre-migration backup and aborts on observation inconsistency; existing v1-v4 migrations remain available for older databases.
- Expanded failure-path, browser smoke, route validation, migration, export, and responsive-layout coverage.

### Upgrade Notes

- Upgrading an existing database is automatic. Startup creates and verifies a backup before schema v5 is applied; if backup or consistency verification fails, startup stops without modifying the database.
- Linux conntrack support is a preview validated in Docker, not yet a claim of physical-router compatibility. Yamaha RTX and Cisco IOS remain the physically validated router integrations.

## [1.3.5] - 2026-07-14

### Added

- Multi-router monitoring for up to 10 Yamaha RTX and Cisco IOS routers in any combination, with per-router settings, status, and graph identity.
- Generic router registry and scheduler with staggered polling, a three-poll concurrency limit, timeout/backoff handling, and per-router failure isolation.
- SQLite schema v4 observation junction table, retaining every observing router while storing duplicate connections only once.
- Authenticated memory diagnostics endpoint and `EGRESSVIEW_HISTORY_HOT_MAX` configuration for bounded in-memory history.

### Changed

- Router pollers are now multi-instance factories, separating router type from persistent router identity.
- Existing single Yamaha/Cisco settings migrate automatically to deterministic `yamaha1` / `cisco1` router records with a verified configuration backup.
- Full connection history remains in SQLite while memory keeps the newest 100,000 entries by default; cold entries are hydrated on re-observation without losing `firstSeen` or observer data.
- Database initialization now has an explicit bootstrap boundary so schema migration completes before sessions, devices, enrichment, and beacon connections open the database.
- Documentation and GitHub Pages now describe formal Cisco-only, Yamaha-only, and mixed multi-router support and its physical-validation boundary.

### Reliability

- Pre-migration backups now fail closed: migrations stop on insufficient disk space, busy WAL checkpoints, copy failures, or failed backup integrity checks.
- Migration completion verifies database integrity and schema version, with a clear backup-and-old-binary rollback path on failure.
- Added a deterministic 10-router load gate covering 10,000 observations, concurrency limiting, deduplication, and continued collection when one router fails.
- Replaced timing-dependent scheduler tests with injected timers.

### Validation

- Supplementally tested one physical Cisco and one physical Yamaha registered under two router IDs each, confirming parallel collection and duplicate-observer tracking. This does not claim physical HA or failover validation.
- On the production-sized EC2 database, bounded history reduced RSS from approximately 995 MB to 604 MB while retaining all 216,000+ persisted connections.

## [1.3.0] - 2026-07-12

### Added

- Formal Cisco IOS support, physically validated on C841M-4X-JSEC/K9 with IOS 15.5(3)M9.
- Cisco verbose NAT creation-age and measured-TTL ingestion, with automatic plain-output fallback.
- Redacted physical-device fixtures for ARP, empty NDP, interface discovery, NAT statistics, and multiline verbose NAT output.

### Changed

- Cisco LAN IP auto-detection now prefers the interface reported as NAT inside.
- L3/L4 header status aggregates enabled routers: green when all are ready, yellow when partially ready, and red when none are ready.
- L3/L4 and L2 header indicators no longer display a misleading single IP address.

### Security

- Physically verified SSH host-key TOFU persistence and mismatch rejection.
- Physically verified automatic reconnect and continued NAT collection.

## [1.2.2] - 2026-06-28

### Added

- **Yamaha auto-detect diagnostic display**: when "Connect & Auto-detect" fails, the UI now shows the specific SSH error reason (connection refused, timeout, authentication failed, host key mismatch) with a troubleshooting hint for each case. If SSH succeeds but NAT is not found, the display lists which NAT descriptor candidates were tried and suggests entering the number manually.
- **Yamaha SSH troubleshooting guide**: expanded `docs/setup-yamaha.md` and `docs/setup-yamaha.ja.md` with a full troubleshooting section covering each SSH failure type, the host-key TOFU mechanism, and a security warning for unexpected host-key changes.
- **Dependabot**: automatic weekly dependency updates for npm packages and GitHub Actions.
- **Node.js 24 CI**: CI now runs tests against both Node.js 22 and 24 in parallel.
- **Frontend unit tests**: 53 new unit tests for frontend pure functions (graph layout, statistics, connection panel, auth socket helpers).

### Changed

- **Frontend migrated to ES modules**: all client-side JavaScript now uses native `import`/`export`. Eliminates implicit global-scope dependencies and makes module boundaries explicit.
- **CSP hardened**: split `style-src` into `style-src 'self'`, `style-src-elem 'self'`, and `style-src-attr 'unsafe-inline'` to reduce the scope of the inline-style exception. `script-src` remains nonce-protected.
- **Server error messages internationalised**: all server-side error strings are now routed through the i18n layer, ensuring Japanese/English language selection is respected consistently.

### Fixed

- Fixed GitHub Actions workflow using non-existent action versions.
- Fixed two hardcoded Japanese strings in device identification that bypassed i18n.
- Fixed password whitespace validation ordering relative to the rate-limit check.
- Fixed Yamaha settings fallback when SSH configuration is partially missing.

## [1.2.1] - 2026-06-21

### Changed

- Raised minimum Node.js requirement from 18 to 22 (active LTS). Node 18 and 20 are past their end-of-life dates (April 2025 and April 2026 respectively). If you are running Node 18 or 20, please upgrade to Node.js 22 before updating EgressView.

## [1.2.0] - 2026-06-20

### Added

- Added `get_device_notes` MCP tool: lists all devices with memo notes, or returns the note for a specific device by IP.
- Added `set_device_note` MCP tool: sets, updates, or deletes a device memo note by IP address (empty string deletes).

### Fixed

- Increased login lockout duration from 30 s to 5 minutes.
- Applied brute-force rate limiting to `/auth/change-password` and `/admin/regenerate-token`.
- Added upper bound (1440 min / 24 h) to Slack notification `cooldownMinutes` to prevent silent suppression.
- Fixed `groupDstByTimeRange` `GROUP BY dst, dstHost` duplicate-counting bug; now uses `MAX(dstHost)`.
- Fixed sort-after-limit bug in `/connections/threat-connections` (collect all → sort → slice).
- Fixed `queryNewNodes` returning wrong results when `from`/`to` is null.
- Added `revokeAll` after backup upload restore to invalidate stale sessions.
- Added try-catch to async route handlers in `backup.js` and `slack.js`.
- Unified `parseInt` radix to base 10 across `threat-intel.js`, `utils.js`, `yamaha.js`, `asus.js`.
- Extracted `createAuthMiddleware` in `mcp-server.js` for testability; guarded entry point with `require.main === module`.
- Added `.env.mcp.example` to `package.json` files array.
- Fixed stale `docs/nginx-mcp.conf` reference in `mcp-server.js` comment.
- Fixed deviceId-keyed memo display in the side panel and note modal for notes set through MCP/API.
- Added brute-force protection to `/admin/verify`.
- Rendered backup action buttons without inline event-handler HTML.

## [1.1.0] - 2026-06-20

### Added

- Added Model Context Protocol (MCP) server support for AI assistants to query EgressView network data.
- Added MCP setup documentation for local stdio mode and HTTP mode behind Apache / nginx.
- Added MCP configuration examples for Claude Desktop, Claude Code, Cursor, Zed, and custom MCP clients.

## [1.0.1] - 2026-06-20

### Fixed

- Stabilized GitHub Actions browser smoke tests for the authenticated UI and statistics map.
- Updated GitHub Actions dependencies to avoid Node.js 20 runtime deprecation warnings.

## [1.0.0] - 2026-06-20

### Added

- Initial public release candidate for Yamaha RTX based home/SOHO egress monitoring.
- Browser login sessions, API token support, HTTPS option, and security reporting policy.
- Graph Map, Statistics, Connection Log, Devices, Detection Log, and Settings views.
- Threat intelligence matching, Slack notifications, connection history, backups, and optional ASUS AP/data-source integrations.
- OSS project templates, release safety checks, npm package allow-list, and documentation in English and Japanese.

### Fixed

- Period-filter refresh paths for graph, log, and statistics views.
- Log pagination/filter behavior for server-side and client-side-only filters.
- Security hardening around error messages, backup validation, and public package contents.
