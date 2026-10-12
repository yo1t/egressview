# EgressView Code Quality Report

- **Assessment date**: 2026-10-12
- **Baseline**: previous report at `95e4ef0`; this cycle evaluates through `fa8b93e6` (301 commits)
- **Version**: Hub 1.11.1 · Agent for Mac 0.5.128 · Agent for Windows 0.1.155 (**now publicly distributed**) · EgressView pack 2.1.1 + `[Unreleased]`
- **Node.js**: >=22 (CI: 22, 24, and 26 on Linux, plus 22 on Windows); **macOS agent**: Swift 6 toolchain, minimum macOS 13; **Windows agent**: .NET 10 (C#), WPF tray UI, Windows service
- **Method**: automated tests, V8 coverage, static analysis, dependency/secret scans, browser smoke tests, parser fuzzing, and manual review. Each client is judged against the expectations of *its own* platform: the macOS agent against a Mac-application framework (§6), the Windows agent against a Windows-application framework (§7)

> SonarQube and OpenSSF scores are repository-based estimates; neither official scanner was run. No penetration test was performed. The Windows build, MSI and service behaviour run only on `windows-latest`, so §7 is evaluated from source and CI evidence rather than by execution. The Hub suite and the macOS agent's Swift suite were both executed on macOS for this review.

---

## Executive Summary

**Overall grade: A**

No critical or high-severity defect was found. The previous cycle was about *building* the two client agents; this one was about **what happens when they meet real machines and real data**. Three things define it.

The first is that the **Windows agent left the building**. It is no longer a CI artifact: 0.1.155 is published on `dl.egressview.com` with a signed update manifest, and roughly fifty versions shipped in three weeks. With publication came the failures that only real installations produce — and the project's response to them is the most informative evidence in this report. A **withdrawn-releases registry** now records every version that must never be installed or published again, each entry naming what supersedes it "because a withdrawal with nothing to move to is an instruction nobody can follow," and the MSI builder, the publisher and a unit test all refuse to work with a version listed there. Its three Windows entries are honest incident records: 0.1.117 shipped a migration that scanned 31,647,027 observations once per flow and ran twenty-five minutes without writing a byte, so a machine that installed it **stopped recording and would not start again**; 0.1.118 was abandoned because two different builds carried one version number and `msiexec` returned 0 while replacing no files; 0.1.125 granted its own service only `CreateNewInstance` on the named pipe, so three of four IPC listeners failed every 100 ms and wrote a failure counter **1,947,715 times** before replacement — and its test could not see the bug because it gave the client and the server the same SID.

The second is that the **Hub stopped doing its database work on the thread that answers requests**. A dedicated database thread (`db-worker.js` with `db-worker-host.js` on the main side) holds its own connection, and the main thread sends a request and gets a promise. The comment that opens it names the failure it ends: a slow statement used to freeze "the dashboard, the agents' uploads and `/healthz` together." Fourteen `perf(hub)` changes sit alongside it — covering indexes, daily roll-ups, reads moved off the request path, caches shared between requests asked together, threat-feed parsing moved to its own worker.

The third is quieter and the most characteristic: **the Hub's own charts were measured and found to be lying, and it took five successive schema migrations to make them honest.** v25 established that the timeline had been bucketing flows by `lastSeen`, which made it a histogram of *last sightings* — every still-active flow piles into the newest bucket and the curve can only slope upward; one Hub's six-hour view read 1,115 where the truth was 156. v26 deleted buckets the first fix had filled in for windows nobody was watching. v27 split the window into the half that records its own time and the half that does not. v28 stopped counting the agent half from an hourly roll-up, because spreading hour-cut intervals over five-minute windows drew a triangle wave from 1,069 to 2,007 and back. v29 made the cost of counting a window independent of its age, after a backfill that got slower as it went held the event loop 46 times in one minute. Then v31 gave "the router never answered" a different bar from "nothing was sent," because those mean opposite things.

**Coverage improved and is still reported in the single scope the command emits.** `npm run test:coverage` reports **87.17% lines, 81.23% branches, 83.65% functions**, against the CI gate of 83/79/80 — a margin of 4.2 / 2.2 / 3.7 points, where last cycle it was 1.6 / 1.1 / 2.0. The Hub suite now holds **3,115 tests** (3,113 pass, 0 fail, 2 skipped because they inspect open file handles in a way macOS does not permit); the macOS agent's suite holds **892** (882 XCTest with 3 skipped, plus 10 under swift-testing, 0 failures).

Against that, two things moved the wrong way. The published Windows MSI is **still unsigned** — the asset is literally named `EgressView-Agent-Windows-0.1.155-x64-unsigned.msi` — so the warning in the previous report ("sign before the first publication, or signed and unsigned copies of one version end up in the world") was overtaken by events. And **five Hub modules now exceed 1,000 lines** where two did last cycle, with `server.js` growing 35% to 1,135.

| Framework | Result | Verdict |
|---|---:|---|
| OWASP ASVS Level 1 | 14/14 areas satisfied or mitigated | Fully compliant |
| OpenSSF Scorecard | ~9.6/10 estimated | Unchanged; the remaining points need OSS-Fuzz and SLSA |
| ISO/IEC 25010 | 9.1/10 average | High quality; portability up, maintainability down |
| Node.js Best Practices | 48/50 | Excellent |
| Mac Application Quality (Apple platform) | 9.2/10 estimated | Strong platform citizen |
| Windows Application Quality (Microsoft platform) | 8.7/10 estimated | Update chain now built; the artifact it protects is unsigned |
| SonarQube-equivalent gate | Passed; coverage rating A | No high-severity blocker |

## Review Findings

### Changes since previous report (`95e4ef0` baseline)

301 commits. By area: 52 fixes and 17 features in the Windows agent, 52 fixes and 14 performance changes in the Hub, 30 fixes and 22 releases in the macOS agent.

| Theme | What landed | Evidence |
|---|---|---|
| Windows agent published | 0.1.155 on `dl.egressview.com` with an Ed25519-signed update manifest; ~50 versions in three weeks; C# grew 14,447 → **20,052 lines** | `dl.egressview.com/windows/manifest.json` |
| Windows update client | Fingerprint checked before any request, manifest signature verified **before JSON decode**, schema and platform pinned, downgrade refused, URL pinned to the publishing origin, size checked three ways, SHA-256 checked, and **Authenticode required** for any package it would install | `WindowsAgentUpdate.cs` |
| Withdrawn-releases registry | Every withdrawn version recorded with its reason and its successor; the builder, the publisher and a test each refuse to touch one | `release-signing/withdrawn-agent-releases.json` |
| Hub: database thread | Heavy statements moved to a thread with its own connection, so one slow query no longer freezes the dashboard, agent uploads and `/healthz` together | `db-worker-host.js` |
| Hub: honest charts | Five migrations (v25--v29) to count a time window from evidence that records its time, a daily roll-up for long views (v30), and a separate state for "the router never answered" (v31) | schema v24 → **v31** |
| Hub: read-path performance | Covering indexes for the new-nodes list, scoped reads by flow, AI facts shared between co-requested calls, unmatched flows built once a minute, threat-feed parsing on a worker | 14 `perf(hub)` commits |
| CI: gates that test themselves | A NuGet vulnerability audit that is run against its own vulnerable fixture and must reject it; a gate that refuses a second build under one version and a withdrawn one | `ci.yml` |
| CI: artifacts that are claimed are now exercised | The production image is built, started, polled until `/readyz`, and checked to keep its database on the volume and ship none in the image; the Hub's own suite runs on Windows with Node 22; the conntrack path is collected from a real conntrack table over SSH with a per-run masked password | `production-image`, `test-windows`, `conntrack-integration` |

### Key improvements

- **A database thread, which is the fix the watchdog was standing in for.** The Hub's heavy statements now run on their own thread with their own connection. The previous report described an event-loop watchdog that force-restarts a wedged process and a pathological query fixed at the index level; this cycle addressed the cause rather than the symptom, and the thread's connection is correctly closed wherever the others are — before a restore replaces the file, and before shutdown records a clean stop.
- **Charts that say "not known" instead of guessing.** The timeline had been drawing an upward slope out of an artefact of its own grouping, and the correction is recorded as five append-only migrations, each one documenting the distortion the previous attempt produced with the numbers measured on a real Hub. The final step (v31) distinguishes a window in which the router never answered from one in which nothing was sent — the project's existing habit of refusing to let an absence of evidence read as evidence of absence, applied to its own output.
- **A Windows update chain that refuses to lower its own bar.** The client checks its embedded key against the published fingerprint before it makes a request, verifies the manifest's Ed25519 signature *before* parsing the JSON, refuses anything not strictly newer, pins the package URL to the publishing origin, bounds the download three separate ways, checks SHA-256, and then requires a valid Authenticode signature with a declared publisher. It will not degrade a malformed or unsigned package into "go and fetch it yourself" — a comment in the source gives the reason: that "would turn a manifest fault into silence." The practical consequence is in the risks below.
- **A withdrawal mechanism that records rather than deletes.** Three Windows versions have been withdrawn, with measured reasons and a named successor for each, and three independent places refuse to build, publish or accept one. The entries are unflattering by design; a registry that only contained comfortable entries would not be load-bearing.
- **Gates that are tested against their own failure.** The Windows NuGet audit exists because `dotnet package list --vulnerable` exits 0 even when it reports a vulnerable package; CI therefore runs the audit against a clean fixture, then against a deliberately vulnerable one, and **fails if the audit accepts it**. The build-refusal gate is run rather than read, for the same reason. This is the same discipline the release pipeline already used by proving three tamper cases fail.
- **Claimed artifacts are now exercised.** A comment in CI puts it plainly: "An untested Dockerfile in the repository is the claim of a supported artifact without the support." The production image is now built, started, waited on until it reports ready, and checked to hold its database on the mounted volume and none inside the image. The Hub's unit suite also runs on Windows, and the conntrack collection path — "the one hardware integration that does not need hardware" — is exercised against a real conntrack table in a privileged container reached over SSH with a password generated per run, masked, and never committed.

### Open risks

- **Medium, the published Windows MSI is unsigned.** This is no longer a build-pipeline detail. The artifact users download is named `EgressView-Agent-Windows-0.1.155-x64-unsigned.msi`, CI's step is still called "Build unsigned Windows MSI", and there is no Authenticode signing, timestamping or verification for it. Two consequences follow. A Windows user gets a SmartScreen warning and no way to verify origin, where a Mac user gets a notarized, stapled package. And because the agent's own update client **requires** a valid Authenticode signature for any package it would install, the published releases are marked `install: "manual"` — so the signed manifest, the fingerprint pinning, the downgrade refusal and the three-way size check all work correctly on an update path that never runs. **The whole Windows self-update chain is built and inert, waiting on one signature.** The previous report rated this Medium while the MSI was only a CI artifact and said signing had to land before the first publication; publication came first.
- **Medium, Windows release verification trails Windows release cadence.** Roughly fifty versions in three weeks, three withdrawn, one of them published in a state that stopped an agent recording permanently on any database of real size. The mitigations added are strong but mostly *post hoc*: the registry records and supersedes, and the one preventive gate (refuse a second build under one version) fixes the bookkeeping failure of 0.1.118 rather than the defect class of 0.1.117 or 0.1.125. Both of those were found by installing on a machine, not by a test — and in the 0.1.125 case a test existed and could not see the bug because it gave the client and the server the same SID.
- **Low, Windows test rigour still trails the rest.** 5,214 test lines against 20,052 of source — a ratio that improved from 20% to 26% — but still run by a plain `Program.cs` with 781 assertions rather than a framework, so there is no per-test isolation, no failure list, and the first failure ends the run.
- **Low, platform-only verification.** The Windows build, MSI and service behaviour run only on `windows-latest`, so §7 is evaluated from source and CI rather than by execution. Service failure recovery now has a committed measurement script (`measure-dev-recovery.ps1`, which kills the service and times its return) but it runs by hand, not in CI.
- **Low, maintainability is moving the wrong way.** Five Hub modules now exceed 1,000 lines where two did last cycle: `src/db-migrate.js` (1,416), `server.js` (1,135), `src/devices.js` (1,068), `public/js/log.js` (1,065) and `src/history-queries.js` (1,017). `db-migrate.js` grows by design. `server.js` grew 35% and `history-queries.js` was itself an extraction that has now outgrown the split that created it.
- **Low, one concern in two implementations.** There are still two `WindowsCredentialVault.cs` files, in `EgressView.Agent.Core` and `EgressView.Agent.Ui`, reaching the same store.
- **Low, no App Store distribution.** The macOS agent ships as a Developer ID-signed, notarized DMG/PKG and self-updates from `dl.egressview.com`, so it carries its own update-integrity chain instead of inheriting a store's.
- **Low, router-specific collection remains fixture-dependent.** The conntrack path is now collected from a real table in CI, but the Yamaha, Cisco and ASUS paths are still exercised against recorded output rather than hardware.
- **Low, supply chain.** `npm audit` cannot see SQLite CVEs inside the `better-sqlite3` amalgamation; the blind spot is documented with manual verification steps. Install scripts remain disabled.

**Three risks from the previous report are removed, and they should not have been in it.** It listed "no OpenAPI contract", "no supported production OCI image" and "no in-repo supported service unit" as open. `docs/openapi.json` (generated from the permission matrix and guarded by a test that fails if it drifts), the production `Dockerfile`, and `deploy/egressview.service` all landed on **2026-08-23** — four weeks before that report's own baseline. The same three absences were the stated reason for withholding three points in §4, so that score was understated too.

---

## Measured Evidence

| Check | Result |
|---|---|
| Hub unit tests | **3,113 passed, 0 failed, 2 skipped** of 3,115 (673 suites), executed for this review. The two skips inspect open file handles, which macOS does not permit; they run on Linux in CI |
| macOS agent tests | **892 tests, 0 failures** (882 XCTest with 3 skipped, plus 10 under swift-testing), `swift test` executed on macOS for this review |
| Windows agent tests | **781 assertions** in one console runner (`Program.cs` plus one fixture); executed only on `windows-latest` in CI, covering persistence, bounded drops, privacy-safe diagnostics, IPC, the sign-in task, and shared wording against the Mac strings |
| V8 coverage (`npm run test:coverage`, instrumented server-side tree) | **87.17% lines, 81.23% branches, 83.65% functions** |
| CI coverage minimums | 83% lines, 79% branches, 80% functions -- passed, by 4.2 / 2.2 / 3.7 points |
| Parser fuzz tests | **32 passed, 0 failed** (short campaign; a continuous 20-minute campaign runs every 6 hours and commits findings to a corpus) |
| Playwright browser smoke | Passing CI gate |
| ESLint + frontend HTML insertion audit | Passed; 0 `innerHTML` / `insertAdjacentHTML` assignments |
| Production dependency audit | **0 vulnerabilities** |
| Windows NuGet audit | A CI gate that parses `dotnet package list --vulnerable` (which exits 0 even when it finds something) and is itself **run against a vulnerable fixture it must reject** |
| Secret scan | Passed; no high-signal secrets or environment-specific LAN IPs. Tracked-database and tracked-symlink scans also pass |
| ASH (Automated Security Helper) | **0 actionable findings** (134 suppressed). The first pass of this review reported three, all for one `brace-expansion` advisory reached through `aws-cdk-lib` in the gitignored local `infra/` tooling — outside the repository but inside the scanned working tree. It was fixed by moving that tooling to `aws-cdk-lib` 2.273.0, which bundles the patched version, rather than suppressed |
| GitHub Actions SHA pinning | **42/42 pinned** to full commit SHA, 0 unpinned |
| Hub portability | The unit suite runs on Linux (Node 22/24/26) **and on Windows** (Node 22); offline-runtime distribution and offline portability are separate CI lanes |
| Production image | Built, started, polled until `/readyz`, and checked to put its database on the volume and ship none in the image |
| Hardware-path integration | The conntrack collection path is exercised over SSH against a real conntrack table in a privileged container, with a per-run generated, masked password |
| macOS agent CI | `macos-agent.yml` on macOS: `swift test`, unsigned `xcodebuild` of app + System Extension, and a System-Extension identity gate |
| Windows agent CI | `windows-latest`: `dotnet build`, NuGet audit, **unsigned MSI build**, a gate refusing a rebuild of one version and a withdrawn one, PowerShell parse check of every script, the core test runner, a chart render check and a **render-cost budget** |
| Release verification | `release-gate.yml` checks published releases on publish, on edit, and weekly; `release:publish` verifies assets as downloaded and leaves a draft on any failure; `publish-agent-release.js` refuses any version in the withdrawn registry. macOS agent releases are Developer ID-signed, notarized, and stapled |

### Codebase Metrics

| Metric | Value |
|---|---:|
| Hub source lines (`server.js`, `src`, `public/js`) | 45,506 (39,497) |
| Hub test lines (unit, integration, smoke, fuzz, portability) | 52,142 (44,116) |
| macOS agent source lines (Swift, `Sources` + `Xcode`) | 29,529 (25,587) |
| macOS agent test lines / files | 15,401 / 97 (12,379 / 80) |
| **Windows agent source lines (C#)** | **20,052 across 92 files** (14,447 / 72) |
| **Windows agent test lines (C#) / assertions** | **5,214 / 781** (2,906 / ~450) |
| Windows agent XAML / PowerShell lines | 652 / 617 (572 / 375) |
| Windows agent projects | 3 (`Core`, `Service`, `Ui`) + 2 render tools + 1 test project |
| Unit test files (Hub) | 267 (218) |
| Source modules under `src/` | 159 (134) |
| Hub modules over 1,000 lines | **5** (2) |
| HTTP routes in permission matrix | 111 (111) |
| MCP tools | 11 |
| Permission matrix entries | 122 |
| Route access split | 94 permission-gated, 1 authenticated, 6 agent, 10 public |
| Agent-authenticated routes | ingest, token rotation, registration revoke, capabilities, geo-cache, threat-intel |
| Defined permissions | 8 (7 user + 1 agent) |
| Roles | 3 (viewer, operator, admin) |
| Production dependencies | 13 |
| Markdown documents under `docs/` | 45 (42) |
| Database schema version | **31** (24) |
| CI workflows / jobs in `ci.yml` | 7 / 11 |
| `eval` / `new Function` · `innerHTML` / `insertAdjacentHTML` | 0 · 0 |
| CI Node.js versions | 22, 24, 26 (Linux); 22 (Windows) |
| macOS agent version | **0.5.128**, minimum macOS 13 |
| Windows agent version | **0.1.155**, .NET 10 |

Values in parentheses are the previous report's figures where they changed. One row is not comparable: the previous report's "53" documentation files counted every file in `docs/`, not Markdown documents; the equivalent figure at its own baseline was 42.

---

## 1. OWASP ASVS Level 1

**Verdict: fully compliant (14/14 areas satisfied or mitigated).**

| Area | Status | Evidence |
|---|---|---|
| Authentication | Pass | scrypt with versioned KDF migration, timing-safe comparisons, 256-bit session tokens, delayed failures, per-IP lockout, Google OIDC with PKCE; agent bearer secrets hashed with HMAC-SHA256 under a pepper; macOS keychain uses `AfterFirstUnlockThisDeviceOnly`; the Windows agent stores its bearer in Credential Manager |
| Session management | Pass | Hashed tokens, sliding expiry, revocation, password-change handling, periodic pruning, role-bound sessions |
| Access control | Pass | Of 111 HTTP routes, 94 are permission-gated, 1 authentication-only, 6 agent-authenticated, and 10 public. Deny-by-default boundary applied identically to the WebSocket handshake. 122 matrix entries. Agent enrollment requires administrator approval; both client platforms reuse this single boundary |
| Input validation | Pass | 64 KB JSON limit, strict Zod on endpoint modules, unknown-key rejection, bounded strings/ranges, SSRF guard; agent observations validated by Zod and again by SQLite CHECK constraints, including decimal-string range checks on 64-bit byte counters. The macOS TLS ClientHello parser bounds every attacker-controlled length and caps its read at 4 KB |
| Cryptography | Pass | `randomBytes`/UUID for secrets and correlation, SHA-256 for session/TOFU/principalHash, HMAC-SHA256 for agent credentials, timing-safe equality, RS256 JWT for MCP, KMS Ed25519 for Hub release signing, and an embedded Ed25519 key for agent update manifests on **both** client platforms, each checked against a published fingerprint before use |
| Error handling | Pass | Generic 500 responses, no stack exposure, request-correlated server logs |
| Data protection | Pass | Config, backup, and TLS key mode 0600; secrets excluded from public config and logs; credentials stored hash-only; agent threat questions never sent off-device; a declared, test-enforced privacy manifest |
| Communications | Pass | HTTPS/HSTS supported; OIDC callback enforces secure redirect; MCP OAuth via HTTPS JWKS; agent update checks use an ephemeral, cookie-less session with a minimal User-Agent and no device identifier, and the Windows client pins the package URL to the manifest's own origin |
| Malicious code | Pass | No eval; frontend HTML insertion audit enforced in CI |
| File handling | Pass | Bounded uploads, validated backup names, traversal checks, fail-closed restore/migration; update downloads bounded by declared size, by a running total, and by an absolute cap |
| API security | Pass | Method-specific routes, strict schemas, response-size/time bounds, authenticated exports, MCP rate limiting; idempotent agent ingest; agent read endpoints use `ETag`/`304`; the HTTP surface is described by a generated OpenAPI document that a test keeps in step with the permission matrix |
| Configuration | Pass | No hard-coded credentials, example configuration, secret scan, production demo-mode refusal; agent release builds reject forbidden entitlements at build time |
| Business logic | Pass | HttpOnly cookies with CSRF protection; explicit permission tokens for API identities; administrator-approved agent enrollment with attempt limiting; deny-by-default enforcement |
| Audit and logging | Pass | Append-only audit_events with pseudonymous actorHash/principalHash, 180-day retention on a 24-hour schedule, MCP-separate audit store with keyed client address |

---

## 2. OpenSSF Scorecard (Estimated)

**Estimated score: 9.6/10.**

| Check | Score | Evidence |
|---|---:|---|
| Pinned dependencies | 10 | All 42 GitHub Actions references pinned to full commit SHA |
| Token permissions | 10 | Read-only default; deploy workflows widen only what they need |
| Dangerous workflow | 10 | No `pull_request_target` |
| Binary artifacts | 10 | No committed binaries |
| Security policy | 10 | `SECURITY.md` and private vulnerability reporting |
| License | 10 | AGPL-3.0-only |
| SAST | 10 | ASH, secret scan, ESLint, frontend insertion audit, npm audit, and a NuGet audit for the Windows agent |
| Vulnerabilities | 10 | Production `npm audit` and `dotnet package list --vulnerable` in CI; 0 findings in this review |
| Dependency updates | 10 | Weekly Dependabot for npm and Actions with a 7-day cooldown, matched by an `npm` `min-release-age` install-time floor |
| CI tests | 10 | Unit/coverage, parser fuzz, and browser smoke on PRs; Node 22/24/26 on Linux and 22 on Windows; a production-image lane, a real conntrack integration, and a separate macOS-agent workflow with a System-Extension identity gate |
| Maintained | 10 | Active release and PR history through the assessed commit |
| Code review | 8 | PR workflow with required checks; RBAC and permission matrix enforce review standards |
| Fuzzing | 7 | Parser fuzzing runs on every PR and, via `fuzz-continuous.yml`, in 20-minute campaigns every 6 hours that persist found inputs into `test/fuzz/corpus/`. It is deliberately not OSS-Fuzz (no coverage-guided feedback), which caps the remaining points |
| Signed releases | 9 | Hub releases are published with detached signature assets through a unified release-and-sign command that verifies assets as downloaded and is re-checked on publish/edit/weekly; macOS agent releases are Developer ID-signed and notarized; agent update manifests for both platforms are Ed25519-signed. The remaining point requires SLSA provenance -- and note that the Windows **package** inside that signed manifest is unsigned (§7) |

Unchanged from the previous estimate. The Windows NuGet audit and the extra CI lanes strengthen checks already at 10; the three points still outstanding need coverage-guided fuzzing, SLSA provenance, and a second reviewer.

---

## 3. ISO/IEC 25010

| Characteristic | Score | Strengths | Remaining gap |
|---|---:|---|---|
| Functional suitability | 9 | Multi-router collection, a mature macOS endpoint agent with per-process attribution and its own visualisation, a published Windows agent, agent/router correlation, local threat matching, AI insights, exports, MCP with OAuth, and a generated OpenAPI description of the HTTP surface | No Linux agent, though the publisher already accepts the platform |
| Performance efficiency | 9 | A dedicated database thread so a slow statement no longer freezes requests; WAL, batching, bounded summaries, caches shared between co-requested reads, worker-isolated backup and threat-feed parsing, MCP concurrency cap, covering indexes, daily roll-ups for long views; the agent serves charts from an aggregate and uses App Nap to stay cheap | One writer is still the capacity ceiling: this cycle moved reads off the request thread, not writes, and the production incident that prompted the work was ultimately bound by host I/O |
| Compatibility | 9 | Node 22/24/26 on Linux and 22 on Windows, JA/EN, Yamaha/Cisco/ASUS/conntrack paths, a macOS 13+ agent and a published Windows agent, Cognito compatibility profile, correct operation behind a subpath proxy; the conntrack path is now collected from a real table in CI | Yamaha, Cisco and ASUS collection is still exercised against recorded output rather than hardware |
| Usability | 9 | Responsive UI, setup guides, auto-detection, health diagnostics, per-detection notification switches, a shared collection source selector, an installable menu-bar macOS agent with a self-clearing "stopped recording" alarm, a Windows tray application, public read-only demo; the timeline now shows "not known" rather than implying nothing was sent | Router-side setup remains the real onboarding cost |
| Reliability | 9 | Fail-closed migration/restore/config/notes, health/readiness, cancellation, request IDs, rate limiting, scheduled audit retention, an event-loop watchdog *and* the database thread that reduces what it has to catch, a shipped service unit and a CI-verified container restart policy; the macOS agent detects and announces silent stalls; the Windows agent fails closed on database errors | The Windows withdrawals are reliability events that reached users: one published version could not finish its migration and left an agent permanently not recording |
| Security | 10 | OIDC/PKCE, RBAC, deny-by-default permissions including a separate agent class shared across platforms, CSRF, HttpOnly cookies, hash-only credentials, administrator-approved enrollment, MCP OAuth/JWKS, audit trail, rate limits, SSRF guard, a unified signed-release pipeline, an independently verified update chain on both client platforms, agent App Sandbox + hardened runtime, on-device threat matching | -- |
| Maintainability | 8 | 159 Hub modules, a cleanly split Swift agent (Core / Network Extension / host app) and a three-project Windows solution, strong tests on all three sides, permission matrix, parser fuzz, native-dep blind spot documented | **Down one.** Five modules now exceed 1,000 lines where two did; `server.js` grew 35%, and `history-queries.js` has outgrown the split that created it |
| Portability | 10 | Cloud-neutral profiles, a KMS-signed portable source bundle, offline mode with pre-startup feature policy, versioned rollback, Node 22/24/26 CI; a production container image that CI builds, boots and checks for state leakage, a committed systemd unit, and the Hub's own suite running on Windows as well as Linux; the agent bundles offline map outlines rather than calling a tile service | -- |

**Average: 9.1/10.** Unchanged, but not static: portability rose a point as the container image and service unit stopped being claims and became tested artifacts, and maintainability lost one as module growth outpaced splitting.

---

## 4. Node.js Best Practices

**Adherence: 48/50 (96%).**

- Domain modules, route modules, poller adapters, the agent ingest/correlation/threat-intel modules, DB bootstrap, auth middleware, and browser rendering responsibilities are separated.
- **Database work runs on its own thread.** `db-worker-host.js` sends a request and returns a promise; the worker holds its own connection, and that connection is closed in the two places it must be — before a restore replaces the file, and before shutdown records a clean stop, which refuses while any handle is open. The event-loop watchdog remains as a backstop rather than the primary defence.
- Async external calls have timeouts/AbortSignal bounds; backup pruning and threat-feed parsing use workers with single-flight job state; ASUS polling coalesces overlapping cycles; MCP requests are concurrency-capped.
- The logger adds a bounded `X-Request-Id` context through `AsyncLocalStorage` without logging query strings.
- Graceful shutdown, readiness, schema migration, config rollback, persistence failure, and permission enforcement tests cover lifecycle boundaries; a startup check reports when the database is missing something, and startup progress is reported while the database initialises.
- The HTTP surface is described by `docs/openapi.json`, generated from the permission matrix, with a test that fails if a route is added without regenerating it.
- A production `Dockerfile` and a `deploy/egressview.service` unit are supplied, and CI builds the image, boots it, waits for `/readyz`, and verifies the database lives on the volume rather than in the image.
- ESLint, V8 coverage, Node 22/24/26 on Linux and 22 on Windows, Playwright, parser fuzz (on PRs and continuously every 6 hours), ASH, secret scanning, and dependency audit run as gates; the conntrack collection path is integration-tested against a real table; the macOS agent has its own workflow with a System-Extension identity gate.
- Untrusted input is validated in depth: agent observations pass Zod at the edge and SQLite CHECK constraints at rest; the agent's threat endpoint hands over data rather than accepting a destination to look up.
- SSRF protection resolves outbound endpoint hostnames, rejects link-local/metadata/multicast/broadcast results, and pins the checked address to prevent DNS rebinding.
- Release integrity uses KMS-managed keys anchored outside the repository in a DNS TXT record; releasing and signing are one command that verifies assets as downloaded; a withdrawn-release registry stops a bad version being rebuilt or republished.
- Dependency install scripts are disabled; the native-dependency audit blind spot is documented with manual verification steps.

Points are withheld for module size (five files over 1,000 lines) and for router-specific collection paths that still depend on recorded fixtures rather than hardware. The previous report withheld three points for a missing OpenAPI contract, OCI image and service unit; all three were already in the repository when it was written.

---

## 5. SonarQube-Equivalent Gate

| Metric | Result | Rating |
|---|---:|---|
| Reliability | No known critical/high defect in the Hub; the database thread removes the main stall class, and withdrawn releases are recorded with successors. Against that, three Windows versions were withdrawn this cycle and one of them had been published | A |
| Security | No open high-signal secret or dependency finding; full RBAC with a separate agent class, audit, SSRF protection, KMS Hub signing, a unified signed-release pipeline, and a verified update chain on both client platforms | A |
| Maintainability | Growth outpaced splitting: five modules now exceed 1,000 lines against two last cycle | A (trending down) |
| Coverage | 87.17% lines / 81.23% branches / 83.65% functions, the scope the CI gate checks | A |
| Duplication | No material new duplication identified in manual/static review, except the two `WindowsCredentialVault` implementations | A (estimated) |

**Quality gate: passed.**

### Primary Maintainability Hotspots (Hub)

| File | Lines | Review note |
|---|---:|---|
| `src/db-migrate.js` | 1,416 (1,202) | Schema migrations v1--v31; grows by design, append-only |
| `server.js` | 1,135 (842) | Bootstrap and dependency wiring; **grew 35%** and crossed 1,000 |
| `src/devices.js` | 1,068 (891) | Device identity, persistence, and merge lifecycle |
| `public/js/log.js` | 1,065 (1,050) | Pagination, filtering, and rendering share one view module |
| `src/history-queries.js` | 1,017 (612) | **Grew 66%** -- the extraction from `history.js` has outgrown its own split |
| `src/history.js` | 894 (803) | Store orchestration |
| `src/routes/connections.js` | 791 | Connection log, summary, and threat-count routes |
| `src/routes/agents.js` | 789 (731) | Agent enrollment, approval, ingest, capabilities, geo-cache, and threat-intel routes |
| `src/agent-ingest-store.js` | 763 | Agent observation persistence and roll-up maintenance |
| `src/threat-intel.js` | 723 | Feed fetch, parse scheduling, persistence, and verdicts |
| `src/pollers/yamaha.js` | 710 (627) | Stateful SSH lifecycle around adapter parsers |
| `public/js/graph.js` | 679 | Orchestrates extracted graph helpers/panels/renderer |

Five modules now exceed 1,000 lines where two did last cycle. The previous report named `log.js` and `devices.js` as "the obvious candidates if this list is worked again"; `log.js` grew 1% and `devices.js` 20%, so neither was worked. The notable entries are `server.js`, which grew 35% to become the second-largest file, and `src/history-queries.js`, which grew 66% — it was created last cycle by splitting `history.js`, and it has now outgrown the split.

---

## 6. Mac Application Quality (Apple Platform)

This section evaluates the macOS agent *as a Mac application*, against the expectations Apple sets for a distributed, non-App-Store Mac app: sandboxing and hardened runtime, entitlement minimalism, Developer ID signing and notarization, correct and privacy-respecting use of Network/System Extensions, a trustworthy software-update chain, privacy-by-design and a declared privacy manifest, Human Interface Guidelines and accessibility, reliability/observability, and testability. Scores are a repository-based estimate; the agent's macOS-only build and signing pipeline were verified from source and CI, not executed. The Swift test suite *was* executed on macOS for this review.

**Estimated score: 9.2/10.**

| Dimension | Score | Evidence | Gap |
|---|---:|---|---|
| App Sandbox & hardened runtime | 10 | Both the menu-bar host app and the content-filter extension declare `app-sandbox = true`; release builds are signed `--options runtime`. A shared app group (`group.com.egressview.agent`) is the only IPC surface | -- |
| Entitlement minimalism | 9 | Host holds only `network.client`, `system-extension.install`, `files.user-selected.read-write` (for CSV export) and the content-filter NE key; the release build **rejects** forbidden entitlements (`network.server`, any `temporary-exception.*`, a top-level Mach service name) at build time and again after a ZIP round-trip | A user-selected-file entitlement is unavoidable for export |
| Signing & notarization | 10 | `build-release.sh` archives, **re-signs inside-out**, asserts final entitlements, submits to `notarytool --wait`, staples, runs `spctl --assess`, then re-verifies the round-tripped bytes; the Hub-side release-and-sign is unified so a release cannot ship unsigned, and is re-checked on publish/edit/weekly | macOS-only; not executed in this review |
| Network/System Extension | 10 | A **pass-only** `NEFilterDataProvider`: every verdict is `.allow()` with reporting, so it never blocks or holds traffic. The opt-in is read per-flow, statistics reports are ignored as ambiguous, and the CI identity gate asserts the bundle id, `NEMachServiceName`, `startSystemExtensionMode()`, and in-process code validity | -- |
| Software-update integrity | 9 | Embedded Ed25519 key with a DNS-anchored fingerprint; manifest signature verified *before* JSON decode; strictly-greater version only; size + SHA-256 package check against the signed manifest; the package's own signature and notarisation are checked by macOS (Installer and Gatekeeper) when it is opened — the agent does not check the package signature itself (the unused `AgentPackageVerifier` was removed in 0.5.126; `SecStaticCodeCheckValidity` cannot read an installer signature); the coordinator stops at a checksum-verified package; distributed as a `.pkg` because a sandboxed app cannot launch what it writes but `installd` can install it; failed relaunches are logged, and upgrade copies no longer accumulate (0.5.125) | Not distributed via the Mac App Store, so it carries its own chain |
| Privacy by design & privacy manifest | 10 | No decryption and, by default, nothing read inside a connection; opt-in SNI capped at 4 KB and kept on-device; QUIC counted, not decoded; threat questions matched locally; update checks send no device identifier. Both the app and its extension ship a `PrivacyInfo.xcprivacy`, backed by a repository test that fails the build on an undeclared privacy-relevant API. Since 2026-09-27 the host app's declaration has been *widened* to disclose data that the distribution CDN and optional external providers may retain — a correction toward accuracy, not a new collection; the extension's list remains empty, and `docs/agent-privacy.md` lists every host contacted | -- |
| HIG & accessibility | 8 | `LSUIElement` menu-bar app; template icons that differ by **shape not color**, full wording in the first menu row and set as the VoiceOver accessibility label; localized (en/ja); a text fallback if an icon asset is missing. VoiceOver regressions are treated as defects and fixed (0.5.128 restored reading of the application chart) | A menu-bar-only surface is inherently spare; deeper accessibility auditing is future work |
| Reliability & observability | 9 | Detects and announces silent "stopped recording" (counting only awake time), a self-clearing rehearsal switch, notification kinds with cooldown and a daily budget from which monitoring alerts are exempt, App Nap, keychain reads off the main thread, a staggered install log to diagnose a failed relaunch, correct counts when macOS reports a flow's close twice (0.5.127), and fewer duplicate Hub records (0.5.126) | Full behavioural verification is macOS-only |
| Testability | 9 | **97 Swift test files (15,401 lines), 892 tests executed for this review** on macOS (882 XCTest with 3 skipped, plus 10 under swift-testing), covering the update chain, packaging identity, credentials/enrollment, threat matching and confidence, flow mapping, TLS/QUIC classification, storage/migration, charts/coverage, notifications, and launch-at-login; a CI System-Extension identity gate | Signing/notarization and on-device behaviours cannot be unit-tested |

**What stands out.** The agent remains a careful platform citizen, and this cycle it was mostly refined rather than extended: 47 releases of accumulated correctness — duplicate close reports no longer double-count a flow's bytes, upgrade copies no longer pile up, VoiceOver reads the application chart again. The privacy manifest was *widened* rather than defended, which is the right direction for a declaration whose value depends on being true.

**Where it could go further.** App Store distribution (which would inherit the store's update and privacy scaffolding) is a deliberate non-goal today; deeper accessibility and localization auditing beyond the menu-bar surface is future work; and the whole macOS pipeline can only be exercised on macOS, so this review leans on CI evidence for the signing and notarization steps.

---

## 7. Windows Application Quality (Microsoft Platform)

This section evaluates the Windows agent *as a Windows application*, against what the platform expects of a distributed desktop agent that installs a service: least-privilege service identity, a defended IPC boundary, correct credential storage, a per-machine MSI that installs and removes cleanly, Authenticode signing and a trustworthy update chain, privacy-by-design, Windows UX and accessibility conventions, reliability under service supervision, and testability.

It is deliberately a *separate* framework from §6 rather than a re-score of the same questions. The two platforms defend different boundaries: the Mac agent's hard problems are the sandbox, entitlements and notarization, while the Windows agent's are a service running under its own account, a named pipe that other local users must not reach, and an installer that is the whole distribution chain.

**Estimated score: 8.7/10.** The agent is published now, so this section is no longer judging a plan. Two rows moved up, one moved down, and the gap that defines the section is unchanged.

| Dimension | Score | Evidence | Gap |
|---|---:|---|---|
| Service identity & least privilege | 10 | The service installs as **`NT AUTHORITY\LocalService`**, not `LocalSystem` — the weaker of the two built-in accounts, with no machine-wide rights and null network credentials. Collection does not need administrator, so it does not ask for it | -- |
| IPC boundary | **9** | The named pipe is ACL'd rather than left at defaults: `BuildSecurity` **denies the Network SID outright** (a pipe is reachable over SMB unless refused), allows `LocalSystem`, and grants only read/write/synchronize to one explicitly passed SID | **Down one.** 0.1.125 granted the service's own account only `CreateNewInstance`, so three of four listeners failed on every attempt and retried every 100 ms, writing a failure counter 1,947,715 times. Its test gave the client and the server the same SID and so could not see it |
| Credential storage | 9 | The Hub bearer goes to **Windows Credential Manager** with `CRED_PERSIST_LOCAL_MACHINE`, not to a file the service writes and not into the registry in the clear | Still two vault implementations (`Core` and `Ui`) reaching the same store |
| Installer correctness | 9 | WiX, **`Scope="perMachine"`**, an explicit `ServiceInstall` with `Start="auto"` and `ErrorControl="normal"`, `ServiceControl` that starts on install and stops on both install and uninstall, `util:PermissionEx` granting the data directory to `LocalService` only, a dev-to-MSI migration script, and a sign-in task that is removed on uninstall but not on upgrade. CI builds the MSI on every PR and now also **refuses a second build under one version** — directly the lesson of 0.1.118, where two builds shared a number and `msiexec` returned 0 while replacing no files | Built unsigned |
| Service resilience | 9 | `util:ServiceConfig` sets Windows' own failure recovery — restart, with a 60-second delay — so supervision is the platform's job rather than a watchdog of our own. `measure-dev-recovery.ps1` kills the service, waits for its return, and compares the database before and after | The measurement script runs by hand, not in CI |
| Authenticode & update chain | **6** | **Up one, and for the chain only.** The update client is now complete and fail-closed: the embedded key is checked against the published fingerprint before any request, the manifest's Ed25519 signature is verified *before* the JSON is parsed, schema and platform are pinned, a version not strictly newer is refused, the package URL must match the publishing origin, the download is bounded by the declared size, by a running total and by an absolute cap, SHA-256 is checked, and **a valid Authenticode signature with a declared publisher is required** before anything is installed or re-verified. It will not degrade an unsigned package into "fetch it yourself" | **The MSI is still unsigned** — the published asset is named `…-0.1.155-x64-unsigned.msi` and CI's step is still "Build unsigned Windows MSI". Because the client requires a signature, releases are marked `install: "manual"` and **the entire chain above never runs**. A user gets a SmartScreen warning and no way to verify origin |
| Privacy by design | 10 | Same restraint as the Mac agent and the same boundary in the Hub: packet contents are never collected, diagnostics are asserted **privacy-safe by test**, and the Hub's `agent` access class is reused rather than a second one being opened. Non-public addresses are never sent to a location service | -- |
| Windows UX & accessibility | 8 | WPF tray application with a Fluent theme, localized en/ja, and **shared wording pinned by test** against the Mac English strings so the two products cannot drift apart in the terms a reader sees. A render check and a **render-cost budget** run in CI, which is unusual rigour for a desktop chart; layout defects such as a switch label wrapping on a narrow card are fixed as defects | No automated UI Automation / screen-reader assertions; high-contrast and DPI behaviour unverified here |
| Testability | **8** | **Up one.** 5,214 lines of tests and **781 assertions** against 20,052 lines of source — the ratio rose from 20% to 26%, with test lines growing faster (+79%) than source (+39%). CI gained a NuGet vulnerability audit that is **run against a vulnerable fixture it must reject**, plus build-refusal gates that are executed rather than read | The runner is still a plain `Program.cs`, not a framework: no per-test isolation, no failure list, and one failure ends the run. 0.1.125 is the cost — a test existed for the defect and could not see it |

**What stands out.** The update client is the strongest thing in this section and it is worth being precise about why: it refuses to be useful on bad input. Rather than downgrading an unsigned or malformed package to a manual download — which would have let the project ship self-update on day one — it fails, and the source says why: that "would turn a manifest fault into silence." The withdrawn-releases registry has the same character. It would have been easy to delete 0.1.117 and move on; instead the reason is written down with the numbers, the successor is named, and three places in the toolchain refuse to touch it.

**Where it could go further.** Signing, and it now costs more than it did. An unsigned MSI used to be a first-impression problem; now it is the reason a complete, carefully built update chain sits idle, because the client correctly refuses what the publisher produces. After that: the test runner should become a real framework — 0.1.125 is the argument, a defect with a test that could not see it — and the two `WindowsCredentialVault` implementations should become one.

---

## Conclusion

At the assessed commit, the main line remained suitable for its documented self-hosted deployment model with strong multi-user security controls. Automated quality gates are broad and several of them now test themselves, data-changing operations fail closed, full RBAC with deny-by-default permissions is enforced, MCP access is OAuth-protected with rate limiting and audit, and no critical or high issue remains. Coverage rose to 87.17/81.23/83.65 and the Hub suite now holds 3,115 tests.

The character of this cycle was contact with reality. The Windows agent was published and immediately produced the class of failure that no amount of CI finds — a migration that could not finish on a real database, a version number that identified two builds, a pipe ACL that was wrong in a way its own test could not see. What matters is that each one is now written down with its measurements and its successor, and that three parts of the toolchain refuse to build, publish or accept a withdrawn version. The Hub's answer to its own production stalls was architectural rather than defensive: database work moved to its own thread, so the watchdog is a backstop instead of the plan. And the timeline charts were found to be drawing an upward curve out of their own grouping, which took five append-only migrations to correct — each one recording the distortion the previous attempt introduced.

The unsigned Windows MSI has quietly become more expensive. Last cycle it was a Medium risk on an artifact nobody had been given; the advice was to sign before the first publication, and publication came first. The cost is now concrete and slightly ironic: the Windows update client is complete and strict — fingerprint pinned, signature verified before parse, downgrade refused, download bounded three ways, SHA-256 checked, Authenticode required — and because the publisher emits an unsigned MSI, releases are marked `install: "manual"` and none of it runs. The chain is built, correct, and inert, waiting on one signature. That remains the single most valuable thing to fix.

Two corrections to the previous report belong here. It listed "no OpenAPI contract", "no supported production OCI image" and "no in-repo supported service unit" among its open risks, and withheld three Node.js Best Practices points for the same three absences — but `docs/openapi.json`, the production `Dockerfile` and `deploy/egressview.service` had all landed on 2026-08-23, four weeks before that report's own baseline. And its §7 headline of 8.3/10 did not match the mean of its own table, which was 8.6; the 8.7 here is therefore a rise of about a tenth of a point, not four.

Maintainability is the one metric moving the wrong way, and it is worth naming plainly because the project is usually good at this. Five modules now exceed 1,000 lines where two did. The previous report nominated `log.js` and `devices.js` as the obvious next candidates and neither was split; meanwhile `server.js` grew 35% and `history-queries.js` grew 66% — a file created last cycle *by* splitting `history.js`, which has now outgrown the split that made it. The clearest remaining improvements are Authenticode signing for Windows, a real test framework for the Windows runner, splitting the five oversized modules, SLSA provenance for the last point of Signed-Releases, coverage-guided fuzzing beyond the in-repo campaign, and hardware-path coverage for the Yamaha, Cisco and ASUS collectors. Only the first is close to a release concern; the rest are requirement-driven enhancements. The standing caveat is still a verification one: the Windows suite, MSI build and service behaviour run only on Windows, so §7 is evaluated from source and CI rather than by execution here.
