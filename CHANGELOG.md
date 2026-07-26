# Changelog

All notable changes to EgressView are documented here.

## [Unreleased]

### Security and Reliability

- Added a staged, read-only OAuth Resource Server mode for remote MCP testing:
  RFC 9728 metadata and challenges, authorization-server discovery, RS256
  JWKS validation, exact issuer/audience/expiry/scope checks, bounded caches,
  unknown-key refresh, and fail-closed provider errors.
- HTTP token mode now requires a dedicated `MCP_TOKEN` and no longer falls
  back to the full-access `EGRESSVIEW_TOKEN`. Existing private HTTP users must
  set a separate endpoint token before upgrading; stdio mode is unchanged.
- OAuth mode omits `set_device_note` until scoped write authorization and a
  least-privilege internal service identity land in the next P2-60 phase.
- Added least-privilege browser roles. Local login remains `admin`, an explicitly
  allowed Google email becomes `operator`, and a domain-only match becomes
  read-only `viewer`. Authentication allowlists no longer imply administrator
  access.
- Existing local sessions remain administrators during migration. Existing
  OIDC and unknown sessions are revoked once and must reauthenticate so their
  role is derived from a newly verified allowlist match.
- Kept provider-billed AI execution admin-only. Operators may update device
  notes but cannot run AI, change settings or credentials, restore backups, or
  manage authentication.

## [1.6.0] - 2026-07-26

### Added

- Added request correlation for every HTTP response through `X-Request-Id`, with safe caller-provided IDs, generated UUID fallbacks, asynchronous logger context, and correlated slow/error logs.
- Added unified inventory and capacity diagnostics for normal and pre-migration SQLite backups, including schema, integrity, disk headroom, and next-migration readiness.
- Added dry-run and confirmed cleanup for verified backup generations, with optional explicit auto-prune and configurable storage limits.
- Moved AI list prices into a validated, versioned data catalog with required effective dates and source URLs, so price updates no longer require pricing-logic changes.
- Added separate diagnostics for unknown model prices and successful calls where the provider returned no token usage.
- Added official GPT-5.5 standard API pricing so future token usage contributes to the estimated USD total instead of remaining explicitly unpriced.
- Added pricing coverage for major OpenAI text-generation models, model-level coverage checks in AI settings, grouped unpriced-usage diagnostics, and explicit partial-total USD labels.
- Added production Bedrock guidance for least-privilege IAM, invocation logging, PrivateLink, and standard versus adaptive AWS SDK retries.
- Added unauthenticated, minimal `/healthz` liveness and `/readyz` bootstrap-readiness endpoints for monitoring and deployment gates.

### Security and Reliability

- **Google OIDC domain allowlists now warn that every matching user becomes a full administrator.** EgressView authenticates users but does not separate permissions yet, so any account passing the allowlist can read all captured traffic, change router credentials, rotate secrets, and restore backups. A domain allowlist extends that to everyone in the domain, including accounts created after it was configured. The warning appears in the server log at startup, in Settings while any domain is present — saved or still being typed — and again in a confirmation prompt when an enabled configuration with a domain allowlist is saved. Both READMEs, the project site, and the authentication guide document the risk and how to move to an explicit email allowlist without losing access. Existing configurations keep working unchanged — EgressView never disables an allowlist for you, because silently locking out remote users would be worse than the risk being reported. Prefer an explicit email allowlist until role-based access control ships.
- Settings now describes the local administrator accurately for the configuration in use: it is presented as the ordinary sign-in path while Google OIDC is disabled, and as the emergency fallback that survives an IdP outage once OIDC is enabled. The account itself is unchanged and remains always available. Wording switches on the saved OIDC setting alone — EgressView does not infer whether it is reachable from the internet, because a port forward or unknown reverse proxy would defeat that guess.
- Restored saved ASUS polling automatically after service restarts and coalesced overlapping polls to avoid duplicate token renewals and API request bursts.
- Started a fresh append-only AI conversation automatically when the configured provider or model changes, preserving the previous conversation instead of rejecting the next question.
- Preserved AI chat questions when provider generation fails after server-side persistence, and restored unsent questions to the input when a request fails before persistence.
- Made every device-note write path fail closed: failed writes restore the previous runtime snapshot, suppress success notifications, and prevent dependent device merges from starting.
- Replaced ambiguous 8-second literals with domain-owned timeout and input-limit constants while preserving existing values, abort behavior, and error contracts.
- Completed strict Zod request validation across all 13 endpoint-bearing route modules. Unknown fields, arrays or objects supplied for scalar parameters, and oversized values are rejected before route logic runs while existing SSRF checks, defaults, limits, and error shapes are preserved.
- Backup cleanup always protects at least two normal generations and the latest migration generation, never removes corrupt or unverified files, and regenerates plus reverifies the plan immediately before deletion.
- Disk warnings now appear before deployment-time migration failures while the existing fail-closed migration and restore paths remain unchanged.
- Isolated demo runtime databases and backups in one ignored directory and refreshed the committed demo snapshot to prevent migration backups accumulating in the repository root.
- Historical AI usage keeps the rates recorded at invocation time; later catalog updates do not recalculate prior estimates.
- Moved verified backup cleanup planning and execution to a single-concurrency worker job with progress, cancellation, timeout, and status APIs so multi-gigabyte integrity checks do not block collection or HTTP.

## [1.5.1] - 2026-07-20

### Fixed

- Restored the shared connected-device list on AI Insights and every other tab after making AI Insights the default start page.
- Populated the device list directly from bounded summary data without requiring the hidden graph renderer or the initial Socket.IO snapshot to complete.

### Testing

- Added desktop and mobile browser coverage that verifies the connected-device list across all six tabs.
- Added startup coverage with live Socket.IO transport unavailable and preserved configured URL subpaths in deployed smoke tests.
- Verified the fix through the production `/egressview` reverse-proxy path on EC2 with live Yamaha and Cisco data.
- Added separate English and Japanese AI Insights screenshots with IP and MAC addresses redacted, and promoted them to the first README and GitHub Pages screenshots.

## [1.5.0] - 2026-07-19

### Added

- Added an AI Insights start page with local live metrics, bounded manual analysis, and append-only chat through Ollama, Anthropic, OpenAI, or Amazon Bedrock.
- Added schema v7 append-only AI token usage, current/previous monthly totals, versioned USD estimates, and per-answer provider/model/token/cost metadata. Unknown model prices remain explicitly unpriced rather than guessed.
- Added Bedrock model/inference-profile and Guardrail discovery, geo-aware selection, Converse-based connection testing, and AWS default credential-chain authentication without storing AWS keys.
- Added runtime CPU profiling and per-stage router polling diagnostics for production performance analysis.

### Changed

- Made AI Insights the leftmost default view while retaining all existing Graph Map, Statistics, Connection Log, Devices, and Detection Log workflows.
- Placed monthly AI usage at the end of the Insights page so live posture, generated analysis, and chat remain the primary workflow.
- Made estimated-cost formatting language-aware: English uses dollar notation and Japanese uses explicit `USD` notation; no exchange-rate conversion is implied.
- Restored bounded five-minute live graph detail while retaining summary rendering for larger ranges, extended enrichment cache lifetimes, throttled stale refresh work, and batched router poll persistence to reduce steady-state CPU and API load.

### Security and Reliability

- Cloud AI providers remain explicit opt-in and require saved plus per-request consent. AI context is bounded, credentials and router management details are excluded, and provider failures cannot stop collection.
- Schema v7 preserves all earlier migrations and uses the existing verified fail-closed pre-migration backup path.

### Upgrade Notes

- Existing databases migrate automatically from schema v6 to v7. Startup first creates and verifies a full pre-migration backup and stops without changing the database if free space, checkpoint, copy, or integrity verification fails.
- Amazon Bedrock uses the AWS SDK default credential chain. Foundation-model access or Marketplace subscription may still be required for the selected model; see the Bedrock setup guide.

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
