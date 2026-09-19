# EgressView Code Quality Report

- **Assessment date**: 2026-09-19
- **Baseline**: previous report at `8caee36`; this cycle evaluates through `95e4ef0` (150 commits)
- **Version**: Hub 1.10.0 · Agent for Mac 0.5.81 · Agent for Windows (three projects, MSI, CI-gated) · EgressView pack 2.0.3 + `[Unreleased]`
- **Node.js**: >=22 (CI: 22, 24, and 26); **macOS agent**: Swift 6 toolchain, minimum macOS 13; **Windows agent**: .NET 10 (C#), WPF tray UI, Windows service
- **Method**: automated tests, V8 coverage, static analysis, dependency/secret scans, browser smoke tests, parser fuzzing, and manual review. Each client is judged against the expectations of *its own* platform: the macOS agent against a Mac-application framework (§6), the Windows agent against a Windows-application framework (§7)

> This report evaluates the current main line. SonarQube and OpenSSF scores are repository-based estimates; neither official scanner was run. No penetration test was performed. The macOS and Windows agents are platform-specific builds (Network Extension / ETW, keychain / Credential Manager, code-signing), so their native suites and signing pipelines are evaluated from source and CI evidence rather than executed here — except the macOS agent's Swift suite, which was run on macOS for this review. The Windows suite, the MSI build and Authenticode signing run only on `windows-latest` in CI.

---

## Executive Summary

**Overall grade: A**

No critical or high-severity defect was found. This was a *client-agent* cycle. The bigger arc is the maturing of the **macOS agent** from a headless source of rows into a **first-class Mac application** — a menu-bar app with a globe, a Sankey, a timeline and a map, a filterable connection log, CSV export, local threat matching, a signed installer package, in-app self-updates, a health check that raises the alarm when it stops recording, and a machine-readable privacy manifest. Alongside it, the **Windows agent** (`apps/agent-windows`, .NET 10) grew from a vertical slice into a real application: ~2,568 to **14,447 lines of C#** across three projects, a service running as `LocalService`, an ACL'd named-pipe IPC, a WPF tray UI, a **per-machine MSI**, and six CI checks of its own. Its distribution chain is the unfinished part — the MSI is built unsigned (§7). The Hub itself moved once (to 1.10.0) to serve the agents read-only endpoints and to make *releasing and signing a single act*; almost everything else this cycle happened inside `apps/`.

This report therefore judges each client against its own platform, in two separate frameworks (§6 Mac, §7 Windows) rather than one merged checklist. The two defend different boundaries — sandbox, entitlements and notarization on macOS; service identity, a local IPC surface and an installer on Windows — and scoring one by the other's questions would miss what each actually gets right or wrong.

The defining property of the macOS work is *restraint about what leaves the Mac*. The agent observes outbound connections with a **pass-only Network Extension content filter** that never blocks traffic and, by default, reads nothing inside a connection. Destination names come from macOS for free; the one thing the agent can be asked to read — the server name in the opening TLS ClientHello — is strictly opt-in, bounds-checked, capped at 4 KB, and never leaves the machine. QUIC is deliberately **not decoded**: rather than build a decoder to find out whether udp/443 traffic could yield names, the agent classifies those callbacks structurally and *counts* them, retaining no bytes, addresses, or process identity. Threat intelligence follows the same rule — the agent pulls the whole indicator set from the Hub (or, opt-in, the same public feeds directly) and matches locally, so "is this address dangerous?" is never asked of anyone else. As of 0.5.29 the agent ships a `PrivacyInfo.xcprivacy` for both the app and its extension declaring **no tracking and an empty collected-data list**, backed by a repository test that fails the build if the code uses a privacy-relevant API without a matching declaration.

The second thread is the honest, hard-won engineering of a **sandboxed self-updating Mac app**, and of a release process that cannot forget to sign. A long sequence of fixes (P3-24, then P3-31) worked through a real constraint: macOS quarantines everything a sandboxed app writes and refuses to *launch* an app taken from such a location, so an in-app update delivered as a disk image cannot work — but an installer *package* can, because `installd` installing a `.pkg` is not "launching." The agent now downloads an update, verifies it against a manifest signed with an embedded Ed25519 release key (checked *before* the JSON is parsed), confirms the package's Team ID against the running build in-process (not via `spctl`, which fails inside the sandbox), and stops at a verified package rather than swapping itself silently. On the Hub side, 2.0.3 made release-and-sign one command (`npm run release:publish`): it refuses to run on a dirty tree, proves three tamper cases fail, checks the key fingerprint against both the DNS anchor and the registry, uploads to a **draft**, verifies the assets *as downloaded from the release page*, and only then publishes — after the discovery that 2.0.0–2.0.2 had been published with no signed assets at all because signing was a separate step someone had to remember.

**Coverage is reported in the single scope the command emits.** `npm run test:coverage` reports **84.59% lines, 80.11% branches, 81.96% functions** across the instrumented server-side tree, against the CI gate of 83/79/80. That is a narrow margin, and it is the real one: the previous report printed 92.40/88.45/89.55, which this review could not reproduce by running the command it names. The figure here is what the gate enforces, and the gap to it is small enough to be worth watching rather than celebrating. The permission matrix holds **122 entries** (111 HTTP routes + 11 MCP tools); the `agent` access class is **six routes**, shared by the macOS and Windows agents rather than duplicated per platform.

| Framework | Result | Verdict |
|---|---:|---|
| OWASP ASVS Level 1 | 14/14 areas satisfied or mitigated | Fully compliant |
| OpenSSF Scorecard | ~9.6/10 estimated | Signed-Releases satisfied; continuous fuzzing added |
| ISO/IEC 25010 | 9.1/10 average | High quality |
| Node.js Best Practices | 47/50 | Excellent |
| Mac Application Quality (Apple platform) | 9.2/10 estimated | Strong platform citizen |
| Windows Application Quality (Microsoft platform) | 8.3/10 estimated | Sound service design; distribution chain incomplete |
| SonarQube-equivalent gate | Passed; coverage rating A | No high-severity blocker |

## Review Findings

### Changes since previous report (`8caee36` baseline)

Well over 100 PRs merged (#214 onward). The work is almost entirely client agents, and clusters into a few themes:

| Theme | What landed | Roadmap |
|---|---|---|
| macOS agent as a viewable Mac app | Globe with great-circle arcs, Sankey, timeline on one shared period; filterable/sortable connection log; CSV export; country coverage; "what share of the period was actually watched" | P3-15/16/18 |
| macOS local threat intelligence | New Hub endpoint hands the whole indicator set to an enrolled agent; agent matches destinations locally so the address never leaves the Mac; opt-in direct download of the same public feeds; three-condition fallback; Hub-parity confidence scoring; feed-answered/not-answered reporting | P3-30/P3-19/P3-53/P3-54 |
| macOS signed installer + in-app updates | Publish signed agent releases; scheduled update check that stops at a verified package; the sandbox self-update saga resolved by shipping a `.pkg` installer; install logging when a relaunch fails | P3-24/P3-31 |
| macOS destination naming | Read the name the application asked for (macOS-supplied, plus opt-in TLS ClientHello SNI), locally only; QUIC feasibility counted, not decoded | P3-14/P3-29/P3-33 |
| macOS reliability, cost & privacy manifest | Detect and announce "stopped recording"; keychain work off the main thread; App Nap; notification kinds with cooldown and daily budget; `PrivacyInfo.xcprivacy` for app and extension, enforced by a repository test | P3-23 |
| Windows agent, from slice to application | ETW collection in a `LocalService` service; persistence failing closed on DB errors; ACL'd named-pipe IPC; WPF tray UI with charts, a render check and a render-cost budget; Credential Manager storage; **per-machine WiX MSI** with platform failure recovery and a dev-to-MSI migration; shared wording pinned against the Mac strings. Grew from ~2,568 to **14,447** lines of C# | P3-2 |
| Hub: releases, threat feeds, hygiene | Release-and-sign as one act with draft-then-verify; offline bundle now extracts on Linux (extended-attribute fix); threat indicators persist across restart; startup integrity reporting; split two oversized modules | P2-88/P2-96/P2-97, 2.0.3 |
| Download site & docs | A front door for `dl.egressview.com`; `docs/agent-privacy.md`; roadmap/README updates | — |

### Key improvements

- **A Mac endpoint that watches without interfering.** Observation is a `NEFilterDataProvider` running in **pass-only** mode: every flow verdict is `.allow()` with reporting enabled, so byte totals arrive when a flow closes but no traffic is ever held or blocked. Process attribution (pid → name) is resolved through a small C bridge over `libbsm`. The only thing the extension can be asked to read inside a connection is the opening TLS ClientHello, and only when the operator opts in; the parser is fully bounds-checked, rejects implausible hostnames, and caps its read at 4 KB. The extension reads that opt-in *per flow* rather than once at launch.
- **Questions that never leave the machine, and a promise a machine can read.** The agent's threat matching mirrors the Hub's exact three-step order and now its confidence scoring, running entirely locally against a downloaded indicator set; the screen names which of Hub / cached / public feeds answered. The `PrivacyInfo.xcprivacy` manifests declare no tracking, no tracking domains, and an empty collected-data list; a repository test fails the build if a privacy-relevant API is used without a matching declaration, so the promise cannot silently drift from the code.
- **A sandboxed app that can update itself, and a release that cannot forget to sign.** The in-app update path was shipped, found broken on a real machine four times in a row (every failure with passing tests), and fixed until it worked; the resolution — distribute a notarized `.pkg` because `installd` may install what a sandboxed app may not launch — is documented in the code. Update integrity is layered: an embedded Ed25519 key with a DNS-anchored fingerprint, signature verified *before* JSON decode, downgrade refusal, size + SHA-256 checks, and an independent Team-ID cross-check. On the Hub, `release:publish` unifies releasing and signing, verifies assets *as downloaded*, and leaves a draft on any failure — closing the gap that had shipped three unsigned releases.
- **An agent that admits when it has gone quiet, and leaves a trace when it can't restart.** A Mac once recorded nothing for 13.5 hours while the health check reported "healthy" ~800 times. The health check now detects silent stalls, counts only awake time, spells the state out in the menu bar, and notifies — and monitoring alerts are **exempt from the notification daily budget**. When an update's relaunch fails, the installer now writes to `/var/log/egressview-agent-install.log` with two staggered checks, so "never started" can be told from "started and died at once."
- **A Windows agent that defends the boundaries Windows actually has.** It reuses the Hub's existing `agent` enrollment/ingest boundary rather than opening a second one, and on the client side it makes the choices a rushed port usually gets wrong: the service installs as **`NT AUTHORITY\LocalService`**, not `LocalSystem`; the named pipe **denies the Network SID outright** before allowing `LocalSystem` and one explicit SID, because a pipe left at defaults is reachable over SMB; the Hub bearer goes to **Credential Manager**, not a file the service writes; and the MSI is `perMachine` with a real `ServiceInstall`, Windows' own failure recovery, and a migration that removes a previously hand-installed service instead of shadowing it. Its CI runs six checks of its own, including a **render-cost budget** for the charts. The distribution chain is the unfinished part — see §7.
- **Non-public addresses stopped leaving either agent.** The macOS agent's third-party location lookup was asking about the local network: measured on one Mac minutes after install, **400 of the day's 500 requests were spent** on routers, private subnets, link-local and multicast addresses. The Hub had refused those since it first had a geo lookup; the agent now uses the same IANA range list, never queues or asks about such an address (of anyone, including the Hub), purges the ones already queued, and remembers a failed lookup for a week instead of re-sending it every run.

### Open risks

- **Medium, the Windows MSI is unsigned**: CI's step is literally "Build unsigned Windows MSI", and there is no Authenticode signing, timestamping or signature verification for it, nor a published Windows update manifest. A Windows user therefore gets a SmartScreen warning and no way to verify origin, where a Mac user gets a notarized, stapled package. This is the one item in this report rated above Low, and the clearest next piece of work (§7).
- **Low, Windows test rigour trails the rest**: 2,906 test lines against 14,447 of source, run by a plain `Program.cs` with ~450 assertions rather than a framework — so no per-test isolation, no failure list, and the first failure ends the run.
- **Low, platform-only verification**: the Windows build, MSI and signing run only on `windows-latest`, so §7 is evaluated from source and CI rather than by execution. The macOS agent's Swift suite *was* executed on macOS for this review (730 tests).
- **Low, no App Store distribution**: the macOS agent ships as a Developer ID-signed, notarized DMG/PKG and self-updates from `dl.egressview.com`, so it carries its own update-integrity chain instead of inheriting a store's.
- **Low, operational**: the hardware/external-service integration tests are still not part of the default CI workflow.
- **Low, reliability supervision**: the Hub's event-loop watchdog force-kills a wedged process but still depends on an external service manager to restart it; there is still no in-repo supported service unit.
- **Low, ecosystem**: no OpenAPI contract, and no supported production OCI image (the only tracked Dockerfile builds the read-only demo).
- **Low, maintainability**: two modules crossed 1,000 lines this cycle — `src/db-migrate.js` (1,202 lines, migrations v1--v24) and `public/js/log.js` (1,050 lines) — and `src/devices.js` grew 34% to 891.
- **Low, supply chain**: `npm audit` cannot see SQLite CVEs inside the `better-sqlite3` amalgamation; the blind spot is documented with manual verification steps. Install scripts remain disabled.

---

## Measured Evidence

| Check | Result |
|---|---|
| Hub unit tests | **2,654 passed, 0 failed** (576 suites), executed for this review |
| macOS agent tests | **730 passed, 0 failed** (2 skipped), `swift test` executed on macOS for this review |
| Windows agent tests | ~450 assertions in one console runner; executed only on `windows-latest` in CI, covering persistence, bounded drops, privacy-safe diagnostics, and shared wording against the Mac strings |
| V8 coverage (`npm run test:coverage`, instrumented server-side tree) | **84.59% lines, 80.11% branches, 81.96% functions** |
| CI coverage minimums | 83% lines, 79% branches, 80% functions -- passed, by 1.6 / 1.1 / 2.0 points |
| Parser fuzz tests | **32 passed, 0 failed** (short campaign; a continuous 20-minute campaign runs every 6 hours and commits findings to a corpus) |
| Playwright browser smoke | Passing CI gate |
| ESLint + frontend HTML insertion audit | Passed; 0 `innerHTML` / `insertAdjacentHTML` assignments |
| Production dependency audit | **0 vulnerabilities** |
| Secret scan | Passed; no high-signal secrets or environment-specific LAN IPs. Tracked-database and tracked-symlink scans also pass |
| ASH (Automated Security Helper) | **0 actionable findings** (134 suppressed) |
| GitHub Actions SHA pinning | **39/39 pinned** to full commit SHA, 0 unpinned |
| macOS agent CI | `macos-agent.yml` on macOS: `swift test`, unsigned `xcodebuild` of app + System Extension, and a System-Extension identity gate |
| Windows agent CI | `windows-latest`: `dotnet build` of the solution, **unsigned MSI build**, PowerShell parse check of every script, the core test runner, a chart render check and a **render-cost budget** |
| Release verification | `release-gate.yml` checks published releases on publish, on edit, and weekly; `release:publish` verifies assets as downloaded and leaves a draft on any failure. macOS agent releases are Developer ID-signed, notarized, and stapled |

### Codebase Metrics

| Metric | Value |
|---|---:|
| Hub source lines (`server`, `mcp`, `src`, `public/js`) | 39,497 (37,617) |
| Hub test lines (unit, integration, smoke, fuzz, portability) | 44,116 (40,587) |
| macOS agent source lines (Swift, `Sources` + `Xcode`) | 25,587 (19,243) |
| macOS agent test lines / files | 12,379 / 80 (8,645 / 53) |
| **Windows agent source lines (C#)** | **14,447 across 72 files** (~2,568) |
| **Windows agent test lines (C#)** | **2,906** |
| Windows agent XAML / PowerShell lines | 572 / 375 |
| Windows agent projects | 3 (`Core`, `Service`, `Ui`) + 2 render tools + 1 test project |
| Unit test files (Hub) | 218 (193) |
| Source modules under `src/` | 134 (132) |
| HTTP routes in permission matrix | 111 |
| MCP tools | 11 |
| Permission matrix entries | 122 |
| Route access split | 94 permission-gated, 1 authenticated, 6 agent, 10 public |
| Agent-authenticated routes | ingest, token rotation, registration revoke, capabilities, geo-cache, threat-intel |
| Defined permissions | 8 |
| Roles | 3 (viewer, operator, admin) |
| Production dependencies | 13 |
| Documentation files under `docs/` | 53 (42) |
| Database schema version | **24** (19) |
| CI workflows | 7 (ci, pages, macos-agent, dl-deploy, site-deploy, release-gate, fuzz-continuous) |
| `eval` / `new Function` · `innerHTML` / `insertAdjacentHTML` | 0 · 0 |
| CI Node.js versions | 22, 24, 26 |
| macOS agent version | **0.5.81**, minimum macOS 13 |

Values in parentheses are the previous report's figures where they changed.

---

## 1. OWASP ASVS Level 1

**Verdict: fully compliant (14/14 areas satisfied or mitigated).**

| Area | Status | Evidence |
|---|---|---|
| Authentication | Pass | scrypt with versioned KDF migration, timing-safe comparisons, 256-bit session tokens, delayed failures, per-IP lockout, Google OIDC with PKCE; agent bearer secrets hashed with HMAC-SHA256 under a pepper; macOS keychain uses `AfterFirstUnlockThisDeviceOnly` |
| Session management | Pass | Hashed tokens, sliding expiry, revocation, password-change handling, periodic pruning, role-bound sessions |
| Access control | Pass | Of 111 HTTP routes, 94 are permission-gated, 1 authentication-only, 6 agent-authenticated, and 10 public. Deny-by-default boundary applied identically to the WebSocket handshake. 122 matrix entries. Agent enrollment requires administrator approval; both client platforms reuse this single boundary |
| Input validation | Pass | 64 KB JSON limit, strict Zod on endpoint modules, unknown-key rejection, bounded strings/ranges, SSRF guard; agent observations validated by Zod and again by SQLite CHECK constraints, including decimal-string range checks on 64-bit byte counters. The macOS TLS ClientHello parser bounds every attacker-controlled length and caps its read at 4 KB |
| Cryptography | Pass | `randomBytes`/UUID for secrets and correlation, SHA-256 for session/TOFU/principalHash, HMAC-SHA256 for agent credentials, timing-safe equality, RS256 JWT for MCP, KMS Ed25519 for Hub release signing, an embedded Ed25519 key for agent update manifests |
| Error handling | Pass | Generic 500 responses, no stack exposure, request-correlated server logs |
| Data protection | Pass | Config, backup, and TLS key mode 0600; secrets excluded from public config and logs; credentials stored hash-only; agent threat questions never sent off-device; a declared, test-enforced empty privacy manifest |
| Communications | Pass | HTTPS/HSTS supported; OIDC callback enforces secure redirect; MCP OAuth via HTTPS JWKS; agent update checks use an ephemeral, cookie-less session with a minimal User-Agent and no device identifier |
| Malicious code | Pass | No eval; frontend HTML insertion audit enforced in CI |
| File handling | Pass | Bounded uploads, validated backup names, traversal checks, fail-closed restore/migration |
| API security | Pass | Method-specific routes, strict schemas, response-size/time bounds, authenticated exports, MCP rate limiting; idempotent agent ingest; agent read endpoints use `ETag`/`304` |
| Configuration | Pass | No hard-coded credentials, example configuration, secret scan, production demo-mode refusal; agent release builds reject forbidden entitlements at build time |
| Business logic | Pass | HttpOnly cookies with CSRF protection; explicit permission tokens for API identities; administrator-approved agent enrollment with attempt limiting; deny-by-default enforcement |
| Audit and logging | Pass | Append-only audit_events with pseudonymous actorHash/principalHash, 180-day retention on a 24-hour schedule, MCP-separate audit store with keyed client address |

---

## 2. OpenSSF Scorecard (Estimated)

**Estimated score: 9.6/10.**

| Check | Score | Evidence |
|---|---:|---|
| Pinned dependencies | 10 | All 38 GitHub Actions references pinned to full commit SHA |
| Token permissions | 10 | Read-only default; deploy workflows widen only what they need |
| Dangerous workflow | 10 | No `pull_request_target` |
| Binary artifacts | 10 | No committed binaries |
| Security policy | 10 | `SECURITY.md` and private vulnerability reporting |
| License | 10 | AGPL-3.0-only |
| SAST | 10 | ASH, secret scan, ESLint, frontend insertion audit, npm audit |
| Vulnerabilities | 10 | Production `npm audit` in CI; 0 findings in this review |
| Dependency updates | 10 | Weekly Dependabot for npm and Actions with a 7-day cooldown, matched by an `npm` `min-release-age` install-time floor |
| CI tests | 10 | Unit/coverage, parser fuzz, and browser smoke on PRs; Node 22/24/26 matrix; a separate macOS-agent workflow with a System-Extension identity gate |
| Maintained | 10 | Active release and PR history through the current main |
| Code review | 8 | PR workflow with required checks; RBAC and permission matrix enforce review standards |
| Fuzzing | 7 | Parser fuzzing runs on every PR and, via `fuzz-continuous.yml`, in 20-minute campaigns every 6 hours that persist found inputs into `test/fuzz/corpus/`. It is deliberately not OSS-Fuzz (no coverage-guided feedback), which caps the remaining points |
| Signed releases | 9 | Hub releases are published with detached signature assets through a unified release-and-sign command that verifies assets as downloaded and is re-checked on publish/edit/weekly; macOS agent releases are Developer ID-signed and notarized. The remaining point requires SLSA provenance |

The estimate rises from ~9.4 chiefly because continuous fuzzing now runs and because releasing and signing were unified after unsigned releases were caught.

---

## 3. ISO/IEC 25010

| Characteristic | Score | Strengths | Remaining gap |
|---|---:|---|---|
| Functional suitability | 9 | Multi-router collection, a mature macOS endpoint agent with per-process attribution and its own visualisation, an emerging Windows agent, agent/router correlation, local threat matching, AI insights, exports, MCP with OAuth | No OpenAPI contract |
| Performance efficiency | 9 | WAL, batching, bounded summaries, caches, worker-isolated backup, MCP concurrency cap, indexed agent-scoped lookups; the agent serves charts from an hourly aggregate and uses App Nap to stay cheap | Heavy backup checks can still create short host-level latency spikes |
| Compatibility | 9 | Node 22/24/26, JA/EN, Yamaha/Cisco/ASUS/conntrack paths, a macOS 13+ agent and a nascent Windows agent, Cognito compatibility profile, correct operation behind a subpath proxy; the offline bundle now extracts on Linux | Hardware-specific verification remains fixture-dependent in CI |
| Usability | 9 | Responsive UI, setup guides, auto-detection, health diagnostics, per-detection notification switches, a shared collection source selector, an installable menu-bar macOS agent with a self-clearing "stopped recording" alarm and legible threat-source labelling, public read-only demo | Router-side setup remains the real onboarding cost |
| Reliability | 9 | Fail-closed migration/restore/config/notes, health/readiness, cancellation, request IDs, rate limiting, scheduled audit retention, an event-loop watchdog; the macOS agent detects and announces silent stalls and logs failed relaunches; the Windows agent fails closed on database errors | The Hub watchdog depends on an external service manager to restart |
| Security | 10 | OIDC/PKCE, RBAC, deny-by-default permissions including a separate agent class shared across platforms, CSRF, HttpOnly cookies, hash-only credentials, administrator-approved enrollment, MCP OAuth/JWKS, audit trail, rate limits, SSRF guard, a unified signed-release pipeline, an independently verified agent update chain, agent App Sandbox + hardened runtime, on-device threat matching | -- |
| Maintainability | 9 | 132 Hub modules and a cleanly split Swift agent (Core / Network Extension / host app), strong tests on both sides, permission matrix, parser fuzz, native-dep blind spot documented; two oversized modules were split this cycle | `db-migrate.js` and `log.js` remain large |
| Portability | 9 | Cloud-neutral profiles, a KMS-signed portable source bundle that now unpacks on Linux, offline mode with pre-startup feature policy, versioned rollback, Node 22/24/26 CI; the agent bundles offline map outlines rather than calling a tile service | No supported production OCI image/systemd unit |

**Average: 9.1/10.**

---

## 4. Node.js Best Practices

**Adherence: 47/50 (94%).**

- Domain modules, route modules, poller adapters, the agent ingest/correlation/threat-intel modules, DB bootstrap, auth middleware, and browser rendering responsibilities are separated; two files that had grown past comfortable reading were split this cycle.
- Async external calls have timeouts/AbortSignal bounds; backup pruning uses a worker and single-flight job state; ASUS polling coalesces overlapping cycles; MCP requests are concurrency-capped.
- A synchronous database call can block the whole process, so an event-loop watchdog on a worker thread force-restarts a wedged process; the pathological query that motivated it was fixed at the index level.
- The logger adds a bounded `X-Request-Id` context through `AsyncLocalStorage` without logging query strings.
- Graceful shutdown, readiness, schema migration, config rollback, persistence failure, and permission enforcement tests cover lifecycle boundaries; a startup check reports when the database is missing something.
- ESLint, V8 coverage, Node 22/24/26, Playwright, parser fuzz (on PRs and continuously every 6 hours), ASH, secret scanning, and dependency audit run as gates; the macOS agent has its own workflow with a System-Extension identity gate.
- Untrusted input is validated in depth: agent observations pass Zod at the edge and SQLite CHECK constraints at rest; the agent's threat endpoint hands over data rather than accepting a destination to look up.
- SSRF protection resolves outbound endpoint hostnames, rejects link-local/metadata/multicast/broadcast results, and pins the checked address to prevent DNS rebinding.
- Release integrity uses KMS-managed keys anchored outside the repository in a DNS TXT record; releasing and signing are now one command that verifies assets as downloaded.
- Dependency install scripts are disabled; the native-dependency audit blind spot is documented with manual verification steps.

Points are withheld for no default hardware integration CI, no supported process-manager/OCI artifact, and no OpenAPI contract.

---

## 5. SonarQube-Equivalent Gate

| Metric | Result | Rating |
|---|---:|---|
| Reliability | No known critical/high defect; the agent's silent-stop failure mode is detected and announced, and failed relaunches now leave a trace | A |
| Security | No open high-signal secret or dependency finding; full RBAC with a separate agent class, audit, SSRF protection, KMS Hub signing, a unified signed-release pipeline, and an independently verified agent update chain | A |
| Maintainability | The cycle's growth is in the client agents; two oversized Hub modules were split | A |
| Coverage | 84.59% lines / 80.11% branches / 81.96% functions, the scope the CI gate checks | A |
| Duplication | No material new duplication identified in manual/static review | A (estimated) |

**Quality gate: passed.**

### Primary Maintainability Hotspots (Hub)

| File | Lines | Review note |
|---|---:|---|
| `src/db-migrate.js` | 1,202 (885) | Schema migrations v1--v24 |
| `public/js/log.js` | 1,050 (824) | Pagination, filtering, and rendering share one view module |
| `src/devices.js` | 891 (665) | Device identity, persistence, and merge lifecycle |
| `server.js` | 842 (823) | Bootstrap and dependency wiring |
| `src/history.js` | 803 (773) | Store orchestration, after `history-queries.js` was extracted |
| `src/routes/agents.js` | 731 (707) | Agent enrollment, approval, ingest, capabilities, geo-cache, and threat-intel routes |
| `public/js/graph.js` | 679 | Orchestrates extracted graph helpers/panels/renderer |
| `src/pollers/cisco.js` | 661 | Stateful SSH lifecycle around extracted parser/handshake modules |
| `src/mcp-publication-gate.js` | 639 | Publication decision, client release timing, and diagnostics |
| `src/pollers/yamaha.js` | 627 | Stateful SSH lifecycle around adapter parsers |
| `src/history-queries.js` | 612 | Query layer split out of `history.js` |

Two modules crossed 1,000 lines this cycle. `db-migrate.js` grows by design — five more migrations, each append-only — but `log.js` grew 27% without being split, and `devices.js` grew 34%. Neither is unmanageable; both are now the obvious candidates if this list is worked again.

---

## 6. Mac Application Quality (Apple Platform)

This section evaluates the macOS agent *as a Mac application*, against the expectations Apple sets for a distributed, non-App-Store Mac app: sandboxing and hardened runtime, entitlement minimalism, Developer ID signing and notarization, correct and privacy-respecting use of Network/System Extensions, a trustworthy software-update chain, privacy-by-design and a declared privacy manifest, Human Interface Guidelines and accessibility, reliability/observability, and testability. Scores are a repository-based estimate; the agent's macOS-only build and signing pipeline were verified from source and CI, not executed.

**Estimated score: 9.2/10.**

| Dimension | Score | Evidence | Gap |
|---|---:|---|---|
| App Sandbox & hardened runtime | 10 | Both the menu-bar host app and the content-filter extension declare `app-sandbox = true`; release builds are signed `--options runtime`. A shared app group (`group.com.egressview.agent`) is the only IPC surface | -- |
| Entitlement minimalism | 9 | Host holds only `network.client`, `system-extension.install`, `files.user-selected.read-write` (for CSV export) and the content-filter NE key; the release build **rejects** forbidden entitlements (`network.server`, any `temporary-exception.*`, a top-level Mach service name) at build time and again after a ZIP round-trip | A user-selected-file entitlement is unavoidable for export |
| Signing & notarization | 10 | `build-release.sh` archives, **re-signs inside-out**, asserts final entitlements, submits to `notarytool --wait`, staples, runs `spctl --assess`, then re-verifies the round-tripped bytes; the Hub-side release-and-sign is unified so a release cannot ship unsigned, and is re-checked on publish/edit/weekly | macOS-only; not executed in this review |
| Network/System Extension | 10 | A **pass-only** `NEFilterDataProvider`: every verdict is `.allow()` with reporting, so it never blocks or holds traffic. The opt-in is read per-flow, statistics reports are ignored as ambiguous, and the CI identity gate asserts the bundle id, `NEMachServiceName`, `startSystemExtensionMode()`, and in-process code validity | -- |
| Software-update integrity | 9 | Embedded Ed25519 key with a DNS-anchored fingerprint; manifest signature verified *before* JSON decode; strictly-greater version only; size + SHA-256 package check; Team-ID cross-check via `SecStaticCodeCheckValidity`; the coordinator stops at a verified package; distributed as a `.pkg` because a sandboxed app cannot launch what it writes but `installd` can install it; failed relaunches are logged | Not distributed via the Mac App Store, so it carries its own chain |
| Privacy by design & privacy manifest | 10 | No decryption and, by default, nothing read inside a connection; opt-in SNI capped at 4 KB and kept on-device; QUIC counted, not decoded; threat questions matched locally; update checks send no device identifier. As of 0.5.29 both the app and its extension ship a `PrivacyInfo.xcprivacy` declaring no tracking and an empty collected-data list, backed by a repository test and a public `docs/agent-privacy.md` listing every host contacted | -- |
| HIG & accessibility | 8 | `LSUIElement` menu-bar app; template icons that differ by **shape not color**, full wording in the first menu row and set as the VoiceOver accessibility label; localized (en/ja); a text fallback if an icon asset is missing | A menu-bar-only surface is inherently spare; deeper accessibility auditing is future work |
| Reliability & observability | 9 | Detects and announces silent "stopped recording" (counting only awake time), a self-clearing rehearsal switch, notification kinds with cooldown and a daily budget from which monitoring alerts are exempt, App Nap, keychain reads off the main thread, and a staggered install log to diagnose a failed relaunch | Full behavioural verification is macOS-only |
| Testability | 9 | **80 Swift test files (12,379 lines), 730 tests executed for this review** on macOS, covering the update chain, packaging identity, credentials/enrollment, threat matching and confidence, flow mapping, TLS/QUIC classification, storage/migration, charts/coverage, notifications, and launch-at-login; a CI System-Extension identity gate | Signing/notarization and on-device behaviours cannot be unit-tested |

**What stands out.** The agent is a careful platform citizen: it does the least the sandbox allows, reads the least it can from the network, refuses to convert convenience into risk, and now declares that restraint in a machine-readable manifest that a build test keeps honest. The signing story tightened further this cycle when the Hub made releasing-and-signing a single, self-verifying act after unsigned releases slipped out.

**Where it could go further.** App Store distribution (which would inherit the store's update and privacy scaffolding) is a deliberate non-goal today; deeper accessibility and localization auditing beyond the menu-bar surface is future work; and the whole macOS pipeline can only be exercised on macOS, so this review leans on CI evidence for the parts a Linux environment cannot run.

---

## 7. Windows Application Quality (Microsoft Platform)

This section evaluates the Windows agent *as a Windows application*, against what the platform expects of a distributed desktop agent that installs a service: least-privilege service identity, a defended IPC boundary, correct credential storage, a per-machine MSI that installs and removes cleanly, Authenticode signing and a trustworthy update chain, privacy-by-design, Windows UX and accessibility conventions, reliability under service supervision, and testability.

It is deliberately a *separate* framework from §6 rather than a re-score of the same questions. The two platforms defend different boundaries: the Mac agent's hard problems are the sandbox, entitlements and notarization, while the Windows agent's are a service running under its own account, a named pipe that other local users must not reach, and an installer that is the whole distribution chain. Judging Windows against Apple's checklist — or against "does it have a sandbox" — would score the wrong things and miss what it actually gets right.

**Estimated score: 8.3/10.** Lower than the Mac agent, and mostly for one reason: the code is sound, the distribution chain is not finished.

| Dimension | Score | Evidence | Gap |
|---|---:|---|---|
| Service identity & least privilege | 10 | The service installs as **`NT AUTHORITY\LocalService`**, not `LocalSystem` — the weaker of the two built-in accounts, with no machine-wide rights and null network credentials. Collection does not need administrator, so it does not ask for it | -- |
| IPC boundary | 10 | The named pipe is ACL'd rather than left at defaults: `BuildSecurity` **denies the Network SID outright** (a pipe is reachable over SMB unless refused), allows `LocalSystem`, and grants only read/write/synchronize to one explicitly passed SID. The deny rule is the part most implementations omit | -- |
| Credential storage | 9 | The Hub bearer goes to **Windows Credential Manager** with `CRED_PERSIST_LOCAL_MACHINE`, not to a file the service writes and not into the registry in the clear. There are two vault implementations (UI and Core) reaching the same store | Two implementations of one concern is a seam worth collapsing |
| Installer correctness | 9 | WiX, **`Scope="perMachine"`**, an explicit `ServiceInstall` with `Start="auto"` and `ErrorControl="normal"`, `ServiceControl` that starts on install and stops on both install and uninstall, `util:PermissionEx` granting the data directory to `LocalService` only, and a **dev-to-MSI migration script** so a hand-installed service is removed rather than left shadowing the packaged one. CI builds the MSI on every PR, so a broken installer fails before merge | Built unsigned in CI |
| Service resilience | 9 | `util:ServiceConfig` sets Windows' own failure recovery — restart, with a 60-second delay — so supervision is the platform's job rather than a watchdog of our own. The dev script sets the same three-stage recovery and enables the failure flag | Recovery behaviour is asserted from the manifest, not exercised |
| Authenticode & update chain | **5** | The MSI is **built unsigned**: CI's step is named "Build unsigned Windows MSI", and no signing, timestamping or `Get-AuthenticodeSignature` verification exists for it. There is no published Windows update manifest, so the macOS agent's signed-manifest chain has no Windows counterpart yet | **The largest gap in this section.** A user running an unsigned MSI gets a SmartScreen warning and no way to verify origin — the opposite of the guarantee the Mac build gives |
| Privacy by design | 10 | Same restraint as the Mac agent and the same boundary in the Hub: packet contents are never collected, diagnostics are asserted **privacy-safe by test**, and the Hub's `agent` access class is reused rather than a second one being opened. Non-public addresses are never sent to a location service (fixed platform-wide in 0.5.70) | -- |
| Windows UX & accessibility | 8 | WPF tray application with a Fluent theme, localized en/ja, and **shared wording pinned by test** against the Mac English strings so the two products cannot drift apart in the terms a reader sees. A render check and a **render-cost budget** run in CI, which is unusual rigour for a desktop chart | No automated UI Automation / screen-reader assertions; high-contrast and DPI behaviour unverified here |
| Testability | 7 | 2,906 lines of tests against 14,447 lines of source, covering persistence, bounded drops, privacy-safe diagnostics and cross-platform wording. The runner is a **plain `Program.cs` with ~450 assertions**, not a test framework, so there is no per-test isolation, no reporting, and one failure ends the run | A framework (xUnit/NUnit) would give isolation and a failure list; the ratio is well below the Hub's and the Mac agent's |

**What stands out.** The security-relevant choices are the ones a rushed Windows port usually gets wrong, and this one gets them right: `LocalService` instead of `LocalSystem`, an explicit Deny for the Network SID on the pipe, Credential Manager instead of a config file, `perMachine` with a real `ServiceInstall` and platform failure recovery, and a migration path that cleans up a previously hand-installed service. The shared-wording test is a genuinely good idea — it makes "the two agents say the same thing" a build-time property instead of a translation review.

**Where it could go further.** Signing is the gap that matters: an unsigned MSI is a worse first impression than the Mac `.pkg` gives, and it leaves the update chain without the verification the macOS side treats as non-negotiable. After that, the test runner should become a real framework, and the two `WindowsCredentialVault` implementations should become one.

---

## Conclusion

The current main line remains suitable for its documented self-hosted deployment model with strong multi-user security controls. The macOS agent is a well-behaved Mac application, and the Windows agent has grown from a vertical slice into a real one — 14,447 lines, three projects, a per-machine MSI and six CI checks of its own — while reusing the Hub's existing `agent` boundary rather than opening a second. Automated quality gates are broad, data-changing operations fail closed, full RBAC with deny-by-default permissions is enforced, MCP access is OAuth-protected with rate limiting and audit, and no critical or high issue remains.

The defining work this cycle lived in the client agents, and the notable thing is how consistently the macOS agent chose restraint: a pass-only filter that never blocks, opt-in reading that is bounded and stays on-device, QUIC counted rather than decoded, threat questions answered locally, a self-update that verifies four ways and still stops for the user to click, and now a privacy manifest a build test keeps truthful. The hardest problems — updating a sandboxed app, and never shipping an unsigned release again — were both solved by discovering the real failure on a real run and fixing the process, not just the code. The new Windows agent reuses the established `agent` boundary rather than opening a second one, which is the right way to add a platform.

Adding a Windows framework (§7) rather than extending the Mac one changed what the review could see. Scored on its own platform's terms, the Windows agent's security design reads well — `LocalService` over `LocalSystem`, an explicit Deny for the Network SID on its named pipe, Credential Manager over a config file, `perMachine` with platform failure recovery — and one gap stands out that a generic checklist would have buried: **the MSI is built unsigned, and there is no Windows update manifest.** On macOS, "a release cannot ship unsigned" was learned the hard way and then enforced in one command. The Windows side has not reached that point, and until it does, a Windows user gets a SmartScreen warning where a Mac user gets a verifiable package. That is the single most valuable thing to fix next.

Two corrections to the previous report belong here. Its coverage figure (92.40/88.45/89.55) could not be reproduced by running the command it cites; the measured values are **84.59/80.11/81.96**, which clear the gate by 1.6/1.1/2.0 points. And its "2,417 of 2,429, the rest environment-only" now reads as **2,654 of 2,654** — the Hub suite passes completely in this environment, and the macOS suite (730 tests) was executed on macOS for this review rather than inferred from CI.

Maintainability moved in the expected direction: the growth is in the agents. The clearest remaining improvements are Authenticode signing and an update manifest for Windows, a real test framework for the Windows runner, SLSA provenance for the last point of Signed-Releases, coverage-guided fuzzing beyond the in-repo campaign, an OpenAPI contract, and a supported OCI/service artifact. Only the first is close to a release concern; the rest are requirement-driven enhancements. The standing caveat is still a verification one: the Windows suite, MSI build and signing run only on Windows, so §7 is evaluated from source and CI rather than by execution here.
