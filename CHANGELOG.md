# Changelog

All notable changes to EgressView are documented here.

## [Unreleased]

### Changed

- Added a Contributor License Agreement (`CLA.md`, copyright-assignment style) and updated `CONTRIBUTING.md` so that submitting a contribution (e.g. opening a pull request) constitutes acceptance. This secures the relicensing rights the project's dual-licensing (AGPL-3.0 + commercial) depends on; previously contributions were taken inbound under AGPL-3.0 only, which would have prevented the Maintainer from offering the promised commercial license over outside contributions. Includes a fallback license grant and moral-rights provision for jurisdictions where assignment of future works is limited, plus a license-back so contributors retain use of their own work.

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
