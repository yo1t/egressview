# EgressView Code Quality Report

- **Assessment date**: 2026-08-12
- **Baseline**: `30e7bce` (previous report); this cycle evaluates through `e5835a4`
- **Version**: 1.9.0
- **Node.js**: >=22 (CI: 22, 24, and 26)
- **Method**: automated tests, V8 coverage, static analysis, dependency/secret scans, browser smoke tests, parser fuzzing, and manual review

> This report evaluates the current main line. SonarQube and OpenSSF scores are repository-based estimates; neither official scanner was run. No penetration test was performed.

---

## Executive Summary

**Overall grade: A**

No critical or high-severity defect was found. This was a large cycle: 27 PRs (#186--#212) landed and **v1.9.0 shipped**, also signed and published. The headline is a new collection path — a **macOS Hub-Agent** that observes per-process outbound connections on an endpoint and reports them to the Hub over an authenticated ingest API, where they are stored idempotently, correlated with router observations, and matched against the same threat feeds. Around it, a **shared collection source selector** now scopes every view to a chosen router or agent, the **notification-log freeze** that could wedge the whole server was fixed at its root and backed by an event-loop watchdog, and the macOS agent became an installable, signed artifact.

The new ingest surface is the most security-relevant change, and it is built the way the rest of the system is: it is a distinct `agent` access class in the permission matrix, gated by a dedicated `agent.ingest` permission; every agent authenticates with a bearer secret stored only as an HMAC-SHA256 hash under a pepper; enrollment produces an administrator-approved *request* rather than a self-serve identity, with attempt limiting on the short human-readable code; and every observation is validated twice — by Zod at the edge and by table CHECK constraints in SQLite — then deduplicated by `(agentId, observationId)` so a replayed batch changes nothing.

**One change of substance from the previous report: coverage is now reported in a single scope.** The prior report printed two coverage figures — a whole-tree number and a higher `src/`-only number — to correct an earlier mismatch against the CI gate. But the `src/`-only figure is not what `npm run test:coverage` prints and is not what the gate checks, so it reintroduced the same problem it was meant to fix. This report gives the one number the command emits and the gate enforces: **84.95% lines, 80.07% branches, 81.70% functions**, measured across the instrumented server-side tree, against the CI gate of 83/79/80 — a deliberately narrow margin that tracks reality rather than flattering it. The test-to-source ratio is 100.3%. The permission matrix grew with the agent surface to 119 entries (108 HTTP routes + 11 MCP tools).

| Framework | Result | Verdict |
|---|---:|---|
| OWASP ASVS Level 1 | 14/14 areas satisfied or mitigated | Fully compliant |
| OpenSSF Scorecard | ~9.4/10 estimated | Signed-Releases satisfied by a published signed asset |
| ISO/IEC 25010 | 9.1/10 average | High quality |
| Node.js Best Practices | 47/50 | Excellent |
| SonarQube-equivalent gate | Passed; coverage rating A | No high-severity blocker |

## Review Findings

### Changes since previous report (`30e7bce` baseline)

Twenty-seven PRs merged (#186--#212). The work clusters into a few themes rather than a flat list:

| Theme | What landed | PRs |
|---|---|---|
| macOS Hub-Agent | Collection spike, host + system extension, connection-activity UI, secure enrollment identities, idempotent ingest storage, opt-in Hub sender, live-delivery hardening, agent/router correlation, threat-matching of agent flows, per-address capacity, capability negotiation | #187--#197, #204, #207, #210--#212 |
| Enrollment by approval | Short human-readable code produces an administrator-approved request instead of a transcribed long token | #201 |
| Collection source scope | Shared source selector applied across views; AI conversation source scope preserved; router names detected from SSH prompts | #198 |
| Reliability | Notification-log agent-scope freeze fixed with a composite index, plus an event-loop watchdog as defense-in-depth | #202 |
| macOS agent distribution | Packaged as an installable signed DMG; history controls, launch-at-login, menu-bar icon | #199, #200, #203, #205 |
| Release & deps | v1.9.0 prepared and published with signed assets; Dependabot minor-and-patch group; demo/outbound-safety hardening | #186, #191, #209 |
| Documentation | README restructure, architecture doc with the agent in it, quieter dotenv, agent-install scope corrected | #206, #208 |

### Key improvements

- **A new collection path, guarded like the rest of the system.** The macOS agent adds three routes under a new `agent` access class — ingest, token rotation, and capability discovery — none of which are reachable by a session or an API identity. An agent authenticates with an `egva_`-prefixed 256-bit bearer secret that is stored only as an HMAC-SHA256 hash under a pepper, so a database copy does not yield a usable credential. Ingest is idempotent: batches and observations carry client-generated IDs and a replayed batch is counted as duplicates, not re-inserted. Every field is validated by Zod at the route and again by SQLite CHECK constraints, including the 64-bit byte counters, which are range-checked as decimal strings so a hostile payload cannot smuggle an out-of-range value past the edge validator.
- **Enrollment by approval, not by transcription.** The enrollment code shrank from a long transcribed token to six human-readable characters, which on its own would be guessable inside its ten-minute window. It is deliberately not the last line of defence: a correct code produces a *pending request*, an administrator who did not initiate it must approve that request before it becomes an agent, and an attempt counter closes the window in the meantime. This is the same deny-by-default posture applied to onboarding.
- **The notification-log freeze fixed at the root, then fenced.** An agent-scoped notification-log query ran a correlated `EXISTS` over `agent_observations` filtered by `(agentId, localAddress, ...)`. Without a composite index leading on those columns the planner fell back to an agent-only index and rescanned every observation for that agent per notification row — a synchronous, unbounded scan that blocked the event loop until `/healthz` stopped answering and the proxy returned 504. A `(agentId, localAddress, remoteAddress, remotePort)` index makes the lookup a seek. Because `better-sqlite3` is synchronous, a single pathological query is a whole-process risk, so an **event-loop watchdog** was added: a worker thread watches a heartbeat the main thread bumps each tick and force-kills the process (unblockable SIGKILL) if it goes stale past a threshold (default 120s, `EGRESSVIEW_WATCHDOG_STALL_MS`); the service manager restarts it within seconds. The watchdog is fully unref'd and adds one timer and one lightweight thread.
- **Collection source scope across the product.** A shared selector lets an operator scope every view — devices, connections, history, AI conversation — to one router or one agent. The scope is validated as a pair (kind and id must arrive together) and checked against the live set of enabled routers and non-revoked agents, so a stale or forged source id is rejected with a 400 rather than silently widening the query. AI messages persist their source scope in an append-only side table, keeping message bodies immutable while remembering what a conversation was about.
- **A signing pipeline that carried forward.** v1.8.0 was the project's first signed release and was verified from its *downloaded* assets — checksum, `openssl pkeyutl -verify`, and a fingerprint match against the trust registry — with three tamper cases each exiting non-zero. That pipeline carried into v1.9.0, which is published with the same four-asset set (archive, checksum, detached signature, public key) alongside the installable macOS agent. The trust anchor remains the DNS TXT record at `_egressview-release.egressview.com`, served under separate credentials from the repository, which is the comparison that actually carries the trust — the copies in `SECURITY.md`, `trusted-fingerprints.json`, and the website would all change together under a single account compromise.

### Open risks

- **Low, new attack surface**: the agent ingest API is a new authenticated write path. It is permission-gated, doubly validated, idempotent, and rate-limited by the global limiter, but it is exposed to whatever network the agent reaches the Hub over and should be kept behind the same transport protections as the rest of the API.
- **Low, operational**: the four hardware/external-service integration files are not part of the default CI workflow.
- **Low, reliability supervision**: the event-loop watchdog force-kills a wedged process but depends on an external service manager (`Restart=on-failure`) to bring it back; there is still no in-repo supported service unit.
- **Low, ecosystem**: no OpenAPI contract, and no supported production OCI image (the only tracked Dockerfile builds the read-only demo).
- **Low, maintainability**: several modules grew with the agent work (see hotspots). `public/js/ai-insights.js` (892 lines) and `src/history.js` (847 lines) remain the largest, and `src/db-migrate.js` grew to 755 lines carrying migrations v1--v16.
- **Low, supply chain**: `npm audit` cannot see SQLite CVEs inside the `better-sqlite3` amalgamation; the blind spot is documented with manual verification steps. The bundled SQLite tracks upstream's current release. Install scripts remain disabled, so installation depends on a bundled prebuilt binary existing for the host.
- **Low, demo exposure**: the public demo authenticates every visitor as an anonymous `viewer`, which is the point of a demo. No credential is published: anonymous access requires both `DEMO_MODE` and `DEMO_READ_ONLY`, the internal admin token is randomised at every start under that combination, and writes are refused by the viewer permission set and again by the read-only middleware.

---

## Measured Evidence

| Check | Result |
|---|---|
| Unit tests with coverage | 2,088 passed, 0 failed (485 suites) |
| V8 coverage (`npm run test:coverage`, instrumented server-side tree) | 84.95% lines, 80.07% branches, 81.70% functions |
| CI coverage minimums | 83% lines, 79% branches, 80% functions -- passed |
| Parser fuzz tests | 30 passed (3 suites) |
| Playwright browser smoke | Passing CI gate (single spec, 1,901 lines) |
| ESLint | Passed |
| Frontend HTML insertion audit | 0 `innerHTML` / `insertAdjacentHTML` assignments |
| Production dependency audit | 0 vulnerabilities |
| Secret scan | Passed; no high-signal secrets or environment-specific LAN IPs |
| ASH (Automated Security Helper) | 0 actionable findings (36 suppressed, tool 3.5.7) |
| GitHub Actions SHA pinning | 20/20 pinned, 0 unpinned |
| Published release verification | v1.9.0 published with a detached signature asset; the download-and-verify procedure, including three tamper cases, was exercised on the v1.8.0 assets |

### Codebase Metrics

| Metric | Value |
|---|---:|
| Source lines (`server`, `mcp`, `src`, `public/js`) | 34,890 (31,482) |
| Test lines (unit, integration, smoke, fuzz, portability) | 35,011 (32,450) |
| Test-to-source ratio | 100.3% (103.1%) |
| Unit test files | 151 (141) |
| Integration test files | 4 |
| Fuzz test files | 2 (3), 3 suites |
| Browser smoke file | 1 (1,901 lines) |
| Portability test file | 1 |
| Source modules under `src/` | 124 (114) |
| Poller modules | 16 (15) |
| Route modules | 19 (18) |
| HTTP routes in permission matrix | 108 (94) |
| MCP tools | 11 |
| Permission matrix entries | 119 (105) |
| Route access split | 94 permission-gated, 1 authenticated, 3 agent, 10 public |
| Agent-authenticated routes | ingest, token rotation, capability discovery |
| State-changing routes | under `/api`, where the demo read-only middleware mounts |
| Defined permissions | 8 (7) |
| Roles | 3 (viewer, operator, admin) |
| Production dependencies | 13 |
| Documentation files under `docs/` | 47 (37) |
| Database schema version | 16 (12) |
| Parameterized SQL preparation sites | 196 (152) |
| Server-side `var` | 0 |
| `eval` / `new Function` | 0 |
| TODO/FIXME/HACK markers | 0 |
| `innerHTML` / `insertAdjacentHTML` | 0 |
| CI Node.js versions | 22, 24, 26 |
| Release signing key | 1 active (KMS Ed25519); v1.8.0 and v1.9.0 signed and published |

Values in parentheses are the previous report's figures where they changed.

---

## 1. OWASP ASVS Level 1

**Verdict: fully compliant (14/14 areas satisfied or mitigated).**

| Area | Status | Evidence |
|---|---|---|
| Authentication | Pass | scrypt with versioned KDF migration, timing-safe comparisons, 256-bit session tokens, delayed failures, per-IP lockout, Google OIDC with PKCE; agent bearer secrets hashed with HMAC-SHA256 under a pepper |
| Session management | Pass | Hashed tokens, sliding expiry, revocation, password-change handling, periodic pruning, role-bound sessions |
| Access control | Pass | Of 108 HTTP routes, 94 are permission-gated, 1 is authentication-only, 3 are agent-authenticated, and 10 are public (including `/healthz` and `/readyz`). Deny-by-default boundary, applied identically to the WebSocket handshake. Permission matrix holds 119 entries. Agent enrollment requires administrator approval |
| Input validation | Pass | 64 KB JSON limit, strict Zod on endpoint modules, unknown-key rejection, bounded strings/ranges, SSRF guard for outbound endpoints; agent observations validated by Zod and again by SQLite CHECK constraints, including decimal-string range checks on 64-bit byte counters |
| Cryptography | Pass | `randomBytes`/UUID for secrets and correlation, SHA-256 for session/TOFU/principalHash, HMAC-SHA256 for agent credentials, timing-safe equality, RS256 JWT verification for MCP, KMS Ed25519 for release signing |
| Error handling | Pass | Generic 500 responses, no stack exposure, request-correlated server logs |
| Data protection | Pass | Config, backup, and TLS key mode 0600; secrets excluded from public config and logs; API identity and agent credentials stored hash-only |
| Communications | Pass | HTTPS/HSTS supported; OIDC callback enforces secure redirect; MCP OAuth via HTTPS JWKS |
| Malicious code | Pass | No eval; frontend HTML insertion audit is enforced in CI |
| File handling | Pass | Bounded uploads, validated backup names, traversal checks, fail-closed restore/migration |
| API security | Pass | Method-specific routes, strict schemas, response-size/time bounds, authenticated exports, MCP rate limiting; idempotent agent ingest |
| Configuration | Pass | No hard-coded credentials, example configuration, secret scan, production demo-mode refusal |
| Business logic | Pass | HttpOnly cookies with CSRF protection; explicit permission tokens for API identities; administrator-approved agent enrollment with attempt limiting; deny-by-default enforcement |
| Audit and logging | Pass | Append-only audit_events with pseudonymous actorHash/principalHash, 180-day retention enforced on a 24-hour schedule, MCP-separate audit store with keyed client address |

---

## 2. OpenSSF Scorecard (Estimated)

**Estimated score: 9.4/10.**

| Check | Score | Evidence |
|---|---:|---|
| Pinned dependencies | 10 | All 20 GitHub Actions pinned to full commit SHA |
| Token permissions | 10 | Read-only default; Pages widens only the permissions it needs |
| Dangerous workflow | 10 | No `pull_request_target` |
| Binary artifacts | 10 | No committed binaries |
| Security policy | 10 | `SECURITY.md` and private vulnerability reporting |
| License | 10 | AGPL-3.0-only |
| SAST | 10 | ASH, secret scan, ESLint, frontend insertion audit, npm audit |
| Vulnerabilities | 10 | Production `npm audit` in CI; 0 findings in this review |
| Dependency updates | 10 | Weekly Dependabot for npm and Actions with a 7-day cooldown |
| CI tests | 10 | Unit/coverage, parser fuzz, and browser smoke on PRs; Node 22/24/26 matrix; separate macOS agent workflow |
| Maintained | 10 | Active release and PR history through PR #212 |
| Code review | 8 | PR workflow with required checks; RBAC and permission matrix enforce review standards |
| Fuzzing | 5 | Parser fuzzing covers functions that read untrusted device input, with time-budget and shape assertions; dependency-free, runs in CI. Not yet a continuous-fuzzing service |
| Signed releases | 8 | **v1.8.0 and v1.9.0 are published with detached signature assets**, which is what this check inspects — it reads release assets by extension (`.sig`, `.asc`, `.minisig`, `.sigstore`, `.intoto.jsonl`), not git tag signatures. The KMS Ed25519 key is enrolled with multi-channel fingerprint publication and trust-registry tests. The remaining 2 points require SLSA provenance |

---

## 3. ISO/IEC 25010

| Characteristic | Score | Strengths | Remaining gap |
|---|---:|---|---|
| Functional suitability | 9 | Multi-router collection, a macOS endpoint agent with per-process attribution, agent/router correlation, AI insights with notifications, threat investigation, exports, MCP with OAuth | No OpenAPI contract |
| Performance efficiency | 9 | WAL, batching, bounded summaries, caches, worker-isolated backup, MCP concurrency cap, indexed agent-scoped lookups | Heavy backup checks can still create short host-level latency spikes |
| Compatibility | 9 | Node 22/24/26, JA/EN, Yamaha/Cisco/ASUS/conntrack paths and a macOS agent, Cognito compatibility profile, correct operation at `/` and at a subpath behind a proxy | Hardware-specific verification remains fixture-dependent in CI |
| Usability | 9 | Responsive UI, setup guides, auto-detection, health diagnostics, role display, per-detection notification switches, a shared collection source selector, an installable macOS agent, public read-only demo | Router-side setup (SSH user, syslog forwarding) is still the real onboarding cost |
| Reliability | 9 | Fail-closed migration/restore/config/notes, health/readiness, cancellation, request IDs, ASUS auto-reconnect, rate limiting, scheduled audit retention, an event-loop watchdog against synchronous stalls | The watchdog depends on an external service manager to restart |
| Security | 10 | OIDC/PKCE, RBAC, deny-by-default permissions including a separate agent class, CSRF, HttpOnly cookies, hash-only API identity and agent credentials, administrator-approved enrollment, MCP OAuth/JWKS, audit trail, rate limits, SSRF guard, a signed and independently re-verified release, install scripts disabled | -- |
| Maintainability | 9 | 124 modules, strong tests (100.3% test-to-source ratio), split route/poller/query boundaries, permission matrix, MCP decomposed, parser fuzz, native-dep blind spot documented | Several modules grew with the agent work; `public/js/ai-insights.js` and `src/history.js` remain large |
| Portability | 9 | Cloud-neutral profiles, a published KMS-signed portable source bundle, offline mode with pre-startup feature policy, offline portability gates, versioned rollback, Node 22/24/26 CI | No supported production OCI image/systemd unit |

**Average: 9.1/10.**

---

## 4. Node.js Best Practices

**Adherence: 47/50 (94%).**

- Domain modules, route modules, poller adapters, the agent ingest/correlation modules, DB bootstrap, auth middleware, and browser rendering responsibilities are separated.
- Async external calls have timeouts/AbortSignal bounds; backup pruning uses a worker and single-flight job state; ASUS polling coalesces overlapping cycles; MCP requests are concurrency-capped.
- A synchronous database call can block the whole process, so an event-loop watchdog on a worker thread force-restarts a wedged process, and the pathological query that motivated it was fixed at the index level.
- The logger adds a bounded `X-Request-Id` context through `AsyncLocalStorage` without logging query strings.
- Graceful shutdown, readiness, schema migration, config rollback, persistence failure, and permission enforcement tests cover lifecycle boundaries.
- ESLint, V8 coverage, Node 22/24/26, Playwright, parser fuzz, ASH, secret scanning, and dependency audit run as PR gates; the macOS agent has its own workflow.
- Authentication and agent-identity logic are separated into dedicated modules following single-responsibility.
- Untrusted input is validated in depth: agent observations pass Zod at the edge and SQLite CHECK constraints at rest, and parser inputs from untrusted devices are fuzzed with shape and time-budget assertions.
- SSRF protection resolves operator-configured outbound endpoint hostnames, rejects any link-local, metadata, multicast, or broadcast result, and pins the checked address for the connection to prevent DNS rebinding.
- Release integrity uses KMS-managed keys with an enrolled trust registry, and the fingerprint is anchored outside the repository in a DNS TXT record served under separate credentials.
- Dependency install scripts are disabled, so no dependency runs code during installation and native modules come from bundled prebuilt binaries; the native-dependency audit blind spot is documented with manual verification steps.

Points are withheld for no default hardware integration CI, no supported process-manager/OCI artifact, and no OpenAPI contract.

---

## 5. SonarQube-Equivalent Gate

| Metric | Result | Rating |
|---|---:|---|
| Reliability | No known critical/high defect; the notification-log freeze is fixed and fenced | A |
| Security | No open high-signal secret or dependency finding; full RBAC with a separate agent class, audit, SSRF protection, and KMS release signing | A |
| Maintainability | Several modules grew with the agent feature but remain bounded by tests | A |
| Coverage | 84.95% lines / 80.07% branches / 81.70% functions, the scope the CI gate checks | A |
| Duplication | No material new duplication identified in manual/static review | A (estimated) |

**Quality gate: passed.**

### Primary Maintainability Hotspots

| File | Lines | Review note |
|---|---:|---|
| `public/js/ai-insights.js` | 892 | Notification and insight rendering share one view module |
| `src/history.js` | 847 | Store orchestration remains large after query/cache/bootstrap extraction |
| `server.js` | 811 | Bootstrap and dependency wiring; grew with agent and watchdog startup |
| `src/db-migrate.js` | 755 | Schema migrations v1--v16 |
| `public/js/log.js` | 734 | Pagination, filtering, and rendering share one view module |
| `public/js/graph.js` | 679 | Orchestrates extracted graph helpers/panels/renderer |
| `src/devices.js` | 665 | Device identity, persistence, and merge lifecycle |
| `src/pollers/cisco.js` | 661 | Stateful SSH lifecycle around extracted parser/handshake modules |
| `src/mcp-publication-gate.js` | 639 | Publication decision, client release timing, and diagnostics |
| `src/pollers/yamaha.js` | 627 | Stateful SSH lifecycle around adapter parsers |
| `public/js/devices.js` | 594 | Device UI orchestration |
| `public/js/auth-socket.js` | 575 | Auth-aware socket bootstrap and reconnection |
| `mcp-server.js` | 570 | Transport bootstrap and OAuth wiring |
| `src/routes/agents.js` | 569 | Agent enrollment, approval, ingest, and capability routes |
| `src/ai-provider.js` | 563 | Multi-provider AI client with SSRF guard |
| `src/device-identify.js` | 559 | Device fingerprinting heuristics |

Growth this cycle is concentrated in the modules the Hub-Agent touched — `db-migrate.js` (four new migrations), `history.js`, `server.js`, and the new `routes/agents.js`. None crossed into unmanageable territory, and each stayed within its test coverage.

---

## Conclusion

The current main line is suitable for its documented self-hosted deployment model with strong multi-user security controls. Automated quality gates are broad, data-changing operations fail closed, AI provider calls are time-bounded and context-capped, full RBAC with deny-by-default permissions is enforced, MCP access is OAuth-protected with rate limiting and audit, and no critical or high issue remains.

The defining work this cycle was the macOS Hub-Agent, and the notable thing about it is that a whole new ingest surface was added without loosening the security model. The agent is its own access class rather than a reused session, credentials are stored hash-only, enrollment ends in an administrator approval rather than a self-serve token, and observations are validated twice and stored idempotently. A new authenticated write path is exactly where a project tends to cut a corner, and this one did not.

The reliability story is the second thread. A single agent-scoped query could block the synchronous database driver long enough to freeze the whole process behind a 504 — the kind of failure that looks like an outage rather than a slow page. It was fixed where it belonged, with an index that turns the scan into a seek, and then fenced with an event-loop watchdog so that a future pathological query degrades into a fast restart instead of a hang. The watchdog still leans on an external service manager to bring the process back, which is the honest limit of a single-process design.

Coverage holds at the A rating, now reported in the single scope the command emits and the gate enforces, which removes the two-figure ambiguity the previous report carried. Maintainability moved in the expected direction for a large feature: several modules grew, none alarmingly, and the growth is where the new capability lives. The clearest remaining improvements are unchanged in kind — SLSA provenance for the last 2 points of Signed-Releases, continuous fuzzing via OSS-Fuzz, an OpenAPI contract, and a supported OCI/service artifact — all requirement-driven enhancements rather than release blockers.
