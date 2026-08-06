# Changelog

All notable changes to EgressView are documented here.

## [Unreleased]

## [1.8.0] - 2026-08-06

### Added

- Added independent Slack and history switches for threat detection and new
  node detection. Both were previously raised unconditionally: the Slack send
  was gated only by the global Slack toggle and the history callback sat
  outside that gate entirely, so silencing new-node notifications meant turning
  Slack off for everything and the in-app history could not be silenced at all.
  Slack and history are separate on purpose — a new device appearing on the
  network is worth recording even when no direct message is wanted. Settings
  are persisted under a new `detectionNotifications` config section.
- Added AWS KMS signing to the offline distribution build
  (`--kms-key-id`, `--region`). The release key is an asymmetric KMS key
  (`ECC_NIST_EDWARDS25519`) whose private half cannot be exported, and signing
  is restricted to a dedicated release principal by key policy. The verifier is
  unchanged: a raw Ed25519 signature over the checksum file, verifiable with
  only `openssl` and the published public key, with no AWS account and no
  network access. The active key's fingerprint is published in `SECURITY.md`,
  both project site pages, both distribution guides, and a DNS TXT record.
- Added a dependency-free seeded fuzzing suite over the 19 functions that parse
  router CLI output, syslog lines, and conntrack tables. Each run prints its
  seed so a failure can be reproduced with `FUZZ_SEED=<value>`.
- Added Node 26 to the CI test matrix, alongside 22 and 24.

### Changed

- Upgraded `better-sqlite3` from 12.11.1 to 13.0.3, lifting the pin placed in
  1.7.0. The pin existed because the 13.0.2 `linux-arm64` prebuild required
  `GLIBC_2.38`, which the aarch64 deployment host does not provide; 13.0.3
  builds that prebuild against `GLIBC_2.34`. The bundled SQLite moves from
  3.53.2 to 3.53.4.
- Disabled dependency install scripts (`ignore-scripts=true` in `.npmrc`, and
  `npm_config_ignore_scripts` in the offline installer, which cannot read
  `.npmrc` because `npm pack` strips it). better-sqlite3 13.x ships a
  `binding.gyp` with no install script, and npm treats a bare `binding.gyp` as
  an implicit `node-gyp rebuild` — so it would compile SQLite from source on
  every install despite bundling a prebuilt binary, and a host without Python
  and a C++ toolchain could not install at all. Installing now requires a
  bundled prebuild for the host platform: darwin, linux, linuxmusl, and win32
  on arm64 and x64. `ssh2` and `fsevents` lose optional native builds and fall
  back to pure JavaScript.
- Set `min-release-age=7` so a version published less than seven days ago is
  not resolved, matching the existing Dependabot cooldown at install time.
  `npm ci` against a committed lockfile is unaffected.
- Split the MCP surface into focused modules: tool definitions, HTTP
  middleware, and publication constants and evidence now live separately from
  the server and the publication gate.
- Raised the coverage gate to 83% lines, 79% branches, and 80% functions to
  match what the suite actually covers.

### Fixed

- Fixed the MCP audit store never pruning on a schedule. Retention was applied
  only at startup, so a long-running process kept audit rows past their
  retention window indefinitely.
- Pinned patched `hono` (ReDoS) and `socket.io-parser` (memory exhaustion)
  through `overrides`, since no parent package version carried the fixes.
- Stopped rate-limit tests straddling a fixed-window boundary. The limiter
  keys on wall-clock minutes, so two calls either side of a minute edge landed
  in different windows and failed intermittently in CI.

## [1.7.0] - 2026-08-02

### Added

- Added `EGRESSVIEW_OFFLINE_MODE` for air-gapped and egress-filtered
  deployments. Internet-dependent features are decided and disabled before
  startup rather than attempted and timed out: RDAP, GeoIP, threat feeds, the
  OUI vendor database, manual threat lookup, Google OIDC, and the
  Anthropic/OpenAI/Bedrock providers. Cloud provider SDK clients are never
  constructed, so no credential resolution or connection setup occurs. Router
  SSH collection, SQLite, the web UI, and stdio/private HTTP MCP are
  unaffected. Internal DNS/PTR and a self-hosted Ollama endpoint stay disabled
  until explicitly configured with a loopback or private IP address.
  The API and settings report which features are off and why.
- Self-hosted D3 7.9.0, TopoJSON client 3.1.0, and world-atlas 2.0.2 at pinned
  versions and removed every external origin from the CSP and HTML. The map and
  graph now render with no CDN request, which also removes a third-party
  dependency from every ordinary page load.
- Added a mandatory offline portability gate for Linux hosts and a generic
  Debian container. It denies and audits external DNS/socket attempts while
  exercising Web startup/restart, Cisco and conntrack fixtures, SQLite
  backup/restore, stdio MCP, authenticated private HTTP MCP, and MCP audit.
- Added a signed portable source distribution with a CycloneDX SBOM, exact
  dependency lock, per-file manifest, SHA-256 checksum, Ed25519 signature,
  credential/runtime-data exclusion gate, and atomic install/upgrade/rollback.
  Install and upgrade may use the npm registry; runtime remains offline.
- Added a staged OAuth Resource Server mode for remote MCP testing:
  RFC 9728 metadata and challenges, authorization-server discovery, RS256
  JWKS validation, exact issuer/audience/expiry/scope checks, bounded caches,
  unknown-key refresh, and fail-closed provider errors.
- Added a fail-closed pre-publication gate for staged MCP deployments. It
  verifies unpublished DNS, TLS and OAuth metadata, invalid/expired/audience
  rejection, read/write scope separation, rate limiting, audit correlation,
  and continuing local router collection. It never publishes DNS or changes
  infrastructure; a pass only permits a separate manual DNS review.
- Added a cloud-neutral deployment-profile contract for local stdio, private
  HTTP, private OAuth, and public OAuth. Conflicting transport/auth settings now
  fail before MCP startup, with English/Japanese threat, TLS, identity, and
  outbound-dependency matrices documenting the staged air-gapped path.

### Security and Reliability

- Public MCP audit rows now carry a keyed hash of the client address. It is the
  only identifier available when a request fails before authentication, where
  subject and client id are necessarily null, so a flood from one source can
  finally be told apart from ordinary retries. The raw address is never stored,
  and `MCP_TRUST_PROXY` names the proxies allowed to set it — otherwise the
  socket address is used, so a caller cannot forge `X-Forwarded-For` to poison
  the trail. Existing audit databases gain the column in place; historical rows
  stay null rather than being backfilled with a guess.
- HTTP token mode now requires a dedicated `MCP_TOKEN` and no longer falls
  back to the full-access `EGRESSVIEW_TOKEN`. Existing private HTTP users must
  set a separate endpoint token before upgrading; stdio mode is unchanged.
- OAuth provider scopes now map to the shared `network.read` and `notes.write`
  permissions. Read-only tokens cannot discover or call `set_device_note`, and
  insufficient write scope returns a step-up-compatible `403` challenge.
- OAuth MCP API calls now require a dedicated, expiring `egv_...` service
  identity with only `network.read` and `notes.write`; the browser/admin token
  is rejected and never used as a fallback.
- Public OAuth MCP now applies global, per-subject, and per-client rate limits,
  a concurrency cap, bounded request bodies and deadlines, and a dedicated
  append-only HMAC-pseudonymized audit trail.
- Migrated the MCP server to the stable SDK v2 package split. One server
  factory now supports both the legacy `2025-11-25` initialize flow and the
  stateless `2026-07-28` discover flow with the same 11 tools.
- Extended the DNS-unpublished publication gate with dual-era discovery,
  identical tool-inventory checks, standard modern protocol-error probes, and
  versioned real-client evidence. Server-side probes still require both
  protocol revisions; client releases may use either supported revision.
  Cognito evidence can record Copilot's random-loopback callback limitation
  without claiming that client is compatible.
- Made refresh replay evidence provider-neutral: the gate accepts either
  immediate replay rejection with family continuity or replay-triggered family
  revocation, while requiring access tokens to expire within 15 minutes.
- Hardened private HTTP MCP with the same fail-closed audit, rate/concurrency
  limits, bounded bodies, deadlines, and scoped service identity used by OAuth.
  HTTP remains loopback-only by default; non-loopback bind requires an explicit
  deployment profile and a separate approval setting.
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
