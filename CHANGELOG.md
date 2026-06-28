# Changelog

All notable changes to EgressView are documented here.

## [Unreleased]

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
