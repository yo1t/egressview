# EgressView Code Quality Report

- **Assessment date**: 2026-08-22
- **Baseline**: `e5835a4` (previous report); this cycle evaluates through `5468afb`
- **Version**: Hub 1.10.0, product release 2.0.2, Agent for Mac 0.5.29 (build 91)
- **Node.js**: >=22 (CI: 22, 24, and 26)
- **Method**: automated tests, V8 coverage, static analysis, dependency/secret scans, browser smoke tests, parser fuzzing, Swift unit tests, live inspection of the signed and notarised agent installed on a real Mac, verification of the published release from its downloaded assets, and manual review

> This report evaluates the current main line. SonarQube and OpenSSF scores are repository-based estimates; neither official scanner was run. No penetration test was performed. Figures for the macOS agent's runtime cost come from one machine and are labelled as such.

---

## Executive Summary

**Overall grade: A** (previous cycle: A)

No critical or high-severity defect was found in the code.

**This report was first published grading the cycle A−, for a process regression: v2.0.0, v2.0.1 and v2.0.2 had all been published with no signed assets at all.** The signing pipeline existed, was documented, and had been independently re-verified one cycle earlier; it simply had not been run, in a project whose previous two reports both called signed releases its strongest supply-chain property.

**That has been corrected.** v2.0.2 now carries the full four-asset set — archive, checksum, detached signature, public key — built from the `v2.0.2` tag with the same KMS key and the same procedure, and verified from the *downloaded* assets rather than the local ones. The grade returns to A. The gap is recorded here rather than edited out: **anyone who downloaded 2.0.x before 2026-08-22 had nothing to verify**, and that is a fact about what shipped, not about what the pipeline is capable of. v2.0.0 and v2.0.1 remain without assets; they are superseded by 2.0.2.

Everything else moved forward. This was the largest cycle yet: 58 PRs (#213--#270) landed, the product went to 2.0.0 and on to 2.0.2, and the macOS agent went from 0.2.x to **0.5.29 across eight public releases**. The agent grew from a working prototype into something that can be left running: threat intelligence checked against local feeds, a globe and sankey and timeline drawn from an hourly aggregate, an in-app update path that verifies the package before installing it, self-monitoring that says so when collection stops, and — after two rounds of profiling — a resting cost small enough that leaving it on is not a decision the user has to think about.

**The reliability work on the agent is the story of this cycle.** An agent whose whole purpose is to run unattended was, in the field, consuming 41% of a CPU core and 325 MB after a day. The causes were separately diagnosable and separately fixed: a run-loop `Timer` that macOS App Nap throttles in a windowless accessory app, a `SwiftUI TimelineView` re-laying out its whole subtree every frame, an `OSSystemExtensionRequest` that was never retained and so never answered, and windows that were never released after closing. Measured on this machine at the time of writing, the host process rests at **0.0% CPU and 126 MB after two hours**, and the system extension at **1.7% and 18 MB after three and a half hours**.

**A new section has been added to this report: §6, the macOS agent evaluated as a Mac application** rather than as Swift source. A privacy tool that a user installs a kernel-adjacent system extension for has to earn that on Apple's own terms — notarisation, sandbox, least-privilege entitlements, an honest privacy story, accessibility, localisation, energy, and a way out. It scores well; the one clear gap is that it ships **no privacy manifest**.

| Framework | Result | Verdict |
|---|---:|---|
| OWASP ASVS Level 1 | 14/14 areas satisfied or mitigated | Fully compliant |
| OpenSSF Scorecard | ~9.4/10 estimated | Signed-Releases restored: v2.0.2 carries a signature asset, verified from the download |
| ISO/IEC 25010 | 9.1/10 average | High quality |
| Node.js Best Practices | 47/50 | Excellent |
| SonarQube-equivalent gate | Passed; coverage rating A | No high-severity blocker |
| **macOS application quality (§6, new)** | **46/50** | **Strong; no crash diagnostics** |

---

## Review Findings

### Changes since previous report (`e5835a4` baseline)

Fifty-eight PRs merged (#213--#270), plus #271 after the measurement commit. One commit reached main without a pull request. The work clusters into themes:

| Theme | What landed | PRs |
|---|---|---|
| Agent visualisation | Per-app sankey, per-app timeline over a shared period, a globe with location lookup and traffic arcs, the connection log restored alongside them | #227--#233 |
| Agent history and cost | SQLite history with a raw window and an hourly fold; the charts served from that aggregate instead of raw rows | #219, #253, #251 |
| Agent threat intelligence | Feeds matched locally, the whole match shown when a row is selected, both fallback modes verified and documented | #234, #236, #237, #257, #258 |
| Agent updates | Signed release checking, a scheduled check that stops at a verified package, and four fixes to make an update installable at all from a sandboxed app | #216, #217, #239--#248 |
| Agent self-monitoring | Notices and reports when it stops recording; the stop detection then made to actually fire, and proved on a real Mac | #255, #256 |
| **Agent runtime cost** | **Stops being the heaviest thing on the Mac it watches; cheap to leave running and cheap to look at; keychain reads off the main thread** | #259--#262 |
| Destination naming | The name the application asked for, kept locally; TLS SNI read on request; agent-observed destinations enriched | #226, #254, #215 |
| Data fidelity | Real byte counts for closed flows; observations with unknown local ports preserved; the pending-delivery queue readable after a restart | #225, #223, #218 |
| Distribution | Built and published as an installer package; a front door at `dl.egressview.com`; a product site at `www.egressview.com` | #247, #263--#265, #268--#270 |

### Key improvements

- **The agent became cheap to leave running, and the diagnosis is worth recording.** Four independent causes, each with a different fix. macOS App Nap throttles a run-loop `Timer` in a windowless accessory app, so periodic work now uses a `DispatchSourceTimer` on a background queue inside a `ProcessInfo.beginActivity` scope. `TimelineView` re-lays out its entire subtree on every frame, so the globe became an `NSView` with its own clock and a selectable 3/5/15 fps rate. `OSSystemExtensionRequest.propertiesRequest` can simply never call back and the framework does not retain the request, so the health probe now retains it and gives up after 20 seconds. Windows were created once and kept, so they are now created on demand and released on close. **The last one is why memory returns rather than merely stops growing.**
- **The agent tells you when it has stopped collecting.** Silence is the failure mode a passive observer cannot distinguish from quiet, and a 13-hour gap in the field had gone unnoticed. The gate now separates "no traffic" from "not recording": it treats silence as unexplained past a threshold, probes the system extension once per silence stretch rather than on every tick, and surfaces the state in the menu bar and in a notification. It was verified on a real Mac rather than assumed from unit tests.
- **Updates are verified before they are installed, from inside a sandbox.** Checking with `spctl --assess` does not work from a sandboxed app — `spctl` inherits the sandbox and fails, which is why in-app updates could not be installed at all for several versions. The verifier now reads the signing team identifier out of `codesign` output and refuses a package that does not match the running app's team; notarisation is still enforced independently by the installer at install time. The path from "an update exists" to "it is installed" took four corrective releases to get right, and each failure is recorded rather than smoothed over.
- **Threat intelligence with both fallback modes actually measured.** Four conditions were exercised on a real machine: normal operation, a short feed outage, a cache older than 24 hours, and a manual refresh. An earlier claim that "the observation record shows zero third-party connections" was withdrawn: the agent had contacted the feed host, and the query that appeared to show otherwise was simply the wrong query. **That correction is in this report because a verification claim that turns out to be false is worse than no claim.**
- **A distribution and product site that state the conditions up front.** `dl.egressview.com` and `www.egressview.com` are both served from private S3 buckets behind CloudFront with origin access control, security headers, and no third-party assets. The product site names what is required — a supported router or a Mac — early rather than in a README appendix.

### Open risks

- **Low, supply chain**: v2.0.0 and v2.0.1 remain without assets and always will; they are recorded as such in `release-signing/unsigned-releases.json` and superseded by the signed 2.0.2. **The cause has been addressed**: releasing is now one command that uploads to a draft, verifies what the release page serves, and only then publishes, with a workflow gate behind it on publish, on edit, and weekly. The agent `.pkg` releases are notarised and stapled by Apple, which is a real and independently checkable signature, but they carry no checksum or detached signature of the project's own.
- **Low, new attack surface**: the agent ingest API remains a new authenticated write path — permission-gated, doubly validated, idempotent, rate-limited — and should stay behind the same transport protections as the rest of the API.
- **Low, agent diagnostics**: there is no crash reporting and no structured diagnostic bundle. When the agent misbehaves on a user's machine, the recovery procedure is a person reading logs over the user's shoulder.
- **Low, operational**: the four hardware/external-service integration files are still not part of the default CI workflow.
- **Low, reliability supervision**: the event-loop watchdog force-kills a wedged Hub process and still depends on an external service manager to bring it back, but the repository now carries a supported systemd unit and production image that supply it, along with the two systemd directives the watchdog quietly requires. **Whether a given host actually restarts is still only provable on that host**, and the procedure for checking says so.
- **Low, ecosystem**: the production image is built and started by CI on every change, but has not been run anywhere in anger. The HTTP contract describes **43 request bodies** captured from the schema the server actually validated, and **87 operations' response shapes observed under test**. The two are not the same kind of statement and the document does not pretend they are: requests are read off a schema the server enforces, responses are watched coming back, because **nothing validates a response on the way out**. Every observed shape is marked `x-observed` and says it is not a guarantee.
- **Low, maintainability**: `public/js/ai-insights.js` (892) and `src/history.js` (847) remain the largest modules; `src/db-migrate.js` grew to 818 lines and `src/routes/agents.js` to 707.
- **Low, supply chain**: `npm audit` cannot see SQLite CVEs inside the `better-sqlite3` amalgamation; the blind spot is documented with manual verification steps.
- **Low, demo exposure**: the public demo authenticates every visitor as an anonymous `viewer`, which is the point of a demo; no credential is published and writes are refused twice over.

---

## Measured Evidence

| Check | Result |
|---|---|
| Hub unit tests with coverage | 2,188 passed, 0 failed (497 suites) |
| V8 coverage (`npm run test:coverage`, instrumented server-side tree) | **84.62% lines, 80.00% branches, 81.47% functions** |
| CI coverage minimums | 83% lines, 79% branches, 80% functions -- passed |
| macOS agent Swift tests | **409 XCTest (2 skipped) + 10 swift-testing, 0 failed** |
| Parser fuzz tests | 30 passed (3 suites) |
| Playwright browser smoke | Passing CI gate (single spec, 1,901 lines) |
| ESLint | Passed |
| Frontend HTML insertion audit | 0 `innerHTML` / `insertAdjacentHTML` assignments |
| Production dependency audit | 0 vulnerabilities (175 production dependencies) |
| Secret scan | Passed; no high-signal secrets or environment-specific LAN IPs |
| ASH (Automated Security Helper) | **0 actionable findings across 5 scanners** (bandit, checkov, detect-secrets, npm-audit, semgrep); 37 suppressed; tool 3.5.7 |
| GitHub Actions SHA pinning | **23/23 pinned, 0 unpinned** |
| Installed agent, Gatekeeper | `spctl` **accepted, source = Notarized Developer ID** |
| Installed agent, hardened runtime | `CodeDirectory flags=0x10000(runtime)`, secure timestamp present |
| Installed agent, notarisation ticket | `stapler validate` succeeded |
| **Published release verification** | **v2.0.2 carries archive + checksum + detached signature + public key.** Signed from the `v2.0.2` tag with KMS `egressview-release-2026`; **the four assets were downloaded from the release page and verified there**: `shasum -c` OK, `openssl pkeyutl -verify` Signature Verified Successfully, and the downloaded public key's fingerprint matches the DNS TXT trust anchor served under separate credentials. Three tamper cases (archive, checksum, signature) each exit non-zero. v2.0.0 and v2.0.1 remain without assets. Agent `.pkg` releases carry the notarised package only |

### Codebase Metrics

| Metric | Value |
|---|---:|
| Hub source lines (`src`, `public/js`, `server.js`, `mcp-server.js`) | 33,787 (34,890) |
| Hub test lines (unit, integration, smoke, fuzz, portability) | 36,411 (35,011) |
| Test-to-source ratio | **107.8%** (100.3%) |
| **macOS agent Swift source lines** | **23,058 across 115 files** |
| **macOS agent Swift test lines** | **7,013 across 44 files** |
| Unit test files | 163 (151) |
| Integration test files | 4 |
| Fuzz test files | 3 (2), 3 suites |
| Browser smoke file | 1 (1,901 lines) |
| Portability test file | 1 (323 lines) |
| Source modules under `src/` | 124 (124) |
| Poller modules | 16 (16) |
| Route modules | 19 (19) |
| HTTP routes in permission matrix | **111** (108) |
| MCP tools | 11 |
| Permission matrix entries | **122** (119) |
| Route access split | 94 permission-gated, 1 authenticated, **6 agent**, 10 public |
| Defined permissions | 8 (7 operator permissions + `agent.ingest`) |
| Roles | 3 (viewer, operator, admin) |
| Production dependencies | 13 direct, 175 resolved |
| Documentation files under `docs/` | 39 (47) |
| Database schema version | 16 (16) |
| Parameterized SQL preparation sites | 198 (196) |
| Server-side `var` | 0 |
| `eval` / `new Function` | 0 |
| TODO/FIXME/HACK markers | 0 |
| `innerHTML` / `insertAdjacentHTML` | 0 |
| CI workflows | 4 (CI, macOS agent, GitHub Pages, Product site) |
| CI Node.js versions | 22, 24, 26 |
| Release signing key | 1 active (KMS Ed25519); last used for **v2.0.2** |

Values in parentheses are the previous report's figures where they changed. The `docs/` count fell because `.ja.md` counterparts were consolidated, not because documentation was removed.

---

## 1. OWASP ASVS Level 1

**Verdict: fully compliant (14/14 areas satisfied or mitigated).**

| Area | Status | Evidence |
|---|---|---|
| Authentication | Pass | scrypt with versioned KDF migration, timing-safe comparisons, 256-bit session tokens, delayed failures, per-IP lockout, Google OIDC with PKCE; agent bearer secrets hashed with HMAC-SHA256 under a pepper |
| Session management | Pass | Hashed tokens, sliding expiry, revocation, password-change handling, periodic pruning, role-bound sessions |
| Access control | Pass | Of 111 HTTP routes, 94 are permission-gated, 1 is authentication-only, 6 are agent-authenticated, and 10 are public. Deny-by-default boundary applied identically to the WebSocket handshake. Permission matrix holds 122 entries. Agent enrollment requires administrator approval |
| Input validation | Pass | 64 KB JSON limit, strict Zod on endpoint modules, unknown-key rejection, bounded strings/ranges, SSRF guard for outbound endpoints; agent observations validated by Zod and again by SQLite CHECK constraints, including decimal-string range checks on 64-bit byte counters |
| Cryptography | Pass | `randomBytes`/UUID for secrets and correlation, SHA-256 for session/TOFU/principalHash, HMAC-SHA256 for agent credentials, timing-safe equality, RS256 JWT verification for MCP, KMS Ed25519 for release signing |
| Error handling | Pass | Generic 500 responses, no stack exposure, request-correlated server logs |
| Data protection | Pass | Config, backup, and TLS key mode 0600; secrets excluded from public config and logs; API identity and agent credentials stored hash-only. On the endpoint, the agent's Hub credential lives in the keychain and is read off the main thread |
| Communications | Pass | HTTPS/HSTS supported; OIDC callback enforces secure redirect; MCP OAuth via HTTPS JWKS; both public web properties are HTTPS-only with HSTS |
| Malicious code | Pass | No eval; frontend HTML insertion audit enforced in CI |
| File handling | Pass | Bounded uploads, validated backup names, traversal checks, fail-closed restore/migration; downloaded update packages are verified against the running app's signing team before installation |
| API security | Pass | Method-specific routes, strict schemas, response-size/time bounds, authenticated exports, MCP rate limiting; idempotent agent ingest |
| Configuration | Pass | No hard-coded credentials, example configuration, secret scan, production demo-mode refusal |
| Business logic | Pass | HttpOnly cookies with CSRF protection; explicit permission tokens for API identities; administrator-approved agent enrollment with attempt limiting; deny-by-default enforcement |
| Audit and logging | Pass | Append-only audit_events with pseudonymous actorHash/principalHash, 180-day retention on a 24-hour schedule, MCP-separate audit store with keyed client address |

---

## 2. OpenSSF Scorecard (Estimated)

**Estimated score: 8.9/10** (previous cycle: ~9.4).

| Check | Score | Evidence |
|---|---:|---|
| Pinned dependencies | 10 | All 23 GitHub Actions references pinned to a full commit SHA across four workflows |
| Token permissions | 10 | Read-only default; Pages and the product-site deploy each widen only what they need (`id-token: write` for OIDC, no `contents: write`) |
| Dangerous workflow | 10 | No `pull_request_target`; the deploy job runs only on `main` through an environment restricted to that branch |
| Binary artifacts | 10 | No committed binaries |
| Security policy | 10 | `SECURITY.md` and private vulnerability reporting |
| License | 10 | AGPL-3.0-only |
| SAST | 10 | ASH (5 scanners), secret scan, ESLint, frontend insertion audit, npm audit |
| Vulnerabilities | 10 | Production `npm audit` in CI; 0 findings in this review |
| Dependency updates | 10 | Weekly Dependabot for npm and Actions with a 7-day cooldown |
| CI tests | 10 | Unit/coverage, parser fuzz, browser smoke, offline portability on PRs; Node 22/24/26 matrix; a separate macOS agent workflow running `swift test` and an unsigned build |
| Maintained | 10 | 58 PRs and eleven releases this cycle |
| Code review | 8 | PR workflow with required checks; one commit this cycle reached main without a PR |
| Fuzzing | 5 | Parser fuzzing covers functions reading untrusted device input, with time-budget and shape assertions; not a continuous-fuzzing service |
| Signed releases | 8 | This check inspects recent releases for a signature asset by extension. **v2.0.2 now carries one**, alongside the checksum and public key, and was verified from the downloaded files. The KMS Ed25519 key is enrolled with multi-channel fingerprint publication and trust-registry tests. **SLSA provenance is now produced and verified by the release command**, as a signed DSSE envelope published as `.intoto.jsonl`; the score stays at 8 until a release actually carries it, which the next one will be the first to do |

**This check was scored 2 when the report was first published, because the three most recent releases carried nothing.** It is scored 8 now because that was fixed, not because the assessment was softened. Signing still happens on a workstation rather than in CI — deliberately, since moving the key into a workflow would widen who can sign — but it is no longer a step that can be forgotten: `npm run release:publish` is the release, and a gate checks the published result on publish, on edit, and weekly.

---

## 3. ISO/IEC 25010

| Characteristic | Score | Strengths | Remaining gap |
|---|---:|---|---|
| Functional suitability | 9 | Multi-router collection, a macOS endpoint agent with per-process attribution and local threat matching, agent/router correlation, AI insights, exports, MCP with OAuth, and an OpenAPI description generated from the permission matrix, with request bodies captured from what the server validates and response shapes observed under test | Responses are observed rather than enforced, and both are covered only for exercised routes |
| Performance efficiency | **9** | WAL, batching, bounded summaries, indexed agent-scoped lookups, an hourly aggregate behind the agent's charts, and an agent runtime cost cut by roughly an order of magnitude | Backup checks can still create short host-level latency spikes |
| Compatibility | 9 | Node 22/24/26, JA/EN throughout, Yamaha/Cisco/ASUS/conntrack paths, macOS 13+ agent, correct operation at `/` and behind a proxy subpath | Hardware-specific verification remains fixture-dependent in CI |
| Usability | 9 | Responsive UI, setup guides, auto-detection, health diagnostics, a public read-only demo, an installable notarised agent that says when it has stopped, and a product site that states the requirements before the download | Router-side setup is still the real onboarding cost |
| Reliability | 9 | Fail-closed migration/restore/config, health/readiness, cancellation, rate limiting, an event-loop watchdog, and agent self-monitoring that distinguishes "no traffic" from "not recording" | The watchdog depends on an external service manager to restart |
| Security | 10 | OIDC/PKCE, RBAC, deny-by-default permissions including a separate agent class, CSRF, hash-only credentials, administrator-approved enrollment, MCP OAuth/JWKS, audit trail, SSRF guard, sandboxed and notarised agent with least-privilege entitlements | -- |
| Maintainability | 9 | 124 Hub modules plus a 23k-line Swift agent with 7k lines of its own tests; 107.8% Hub test-to-source ratio; permission matrix; parser fuzz | Four modules above 700 lines |
| Portability | 9 | Cloud-neutral profiles, a KMS-signed portable source bundle, offline mode, versioned rollback, Node 22/24/26 CI, a supported systemd unit and production image whose supervision requirements are enforced by tests | Neither has been run in a production deployment |

**Average: 9.1/10.**

---

## 4. Node.js Best Practices

**Adherence: 47/50 (94%).** Unchanged in substance from the previous cycle; the new material this time is on the Swift side and is assessed in §6.

- Domain modules, route modules, poller adapters, agent ingest/correlation, DB bootstrap, auth middleware, and rendering responsibilities are separated.
- Async external calls have timeouts/AbortSignal bounds; backup pruning uses a worker and single-flight job state; MCP requests are concurrency-capped.
- A synchronous database call can block the whole process, so an event-loop watchdog on a worker thread force-restarts a wedged process.
- The logger adds a bounded `X-Request-Id` context through `AsyncLocalStorage` without logging query strings.
- Untrusted input is validated in depth: agent observations pass Zod at the edge and SQLite CHECK constraints at rest; parser inputs from untrusted devices are fuzzed with shape and time-budget assertions.
- SSRF protection resolves operator-configured hostnames, rejects link-local/metadata/multicast/broadcast results, and pins the checked address to prevent DNS rebinding.
- Dependency install scripts are disabled; the native-dependency audit blind spot is documented with manual verification steps.

Points are withheld for no default hardware integration CI, an OpenAPI contract whose response shapes are observed rather than enforced, and a supported service artifact that has not yet been run in a real deployment.

---

## 5. SonarQube-Equivalent Gate

| Metric | Result | Rating |
|---|---:|---|
| Reliability | No known critical/high defect; the agent's runtime-cost and stopped-collection faults are fixed and verified on hardware | A |
| Security | No open high-signal secret or dependency finding; full RBAC, audit, SSRF protection, sandboxed notarised agent | A |
| Maintainability | Four modules above 700 lines; all bounded by tests | A |
| Coverage | 84.62% lines / 80.00% branches / 81.47% functions, the scope the CI gate checks | A |
| Duplication | No material new duplication identified in manual/static review | A (estimated) |

**Quality gate: passed.** Note that this gate measures the code; it does not measure whether a release was published correctly, which is where this cycle's regression sits.

### Primary Maintainability Hotspots

| File | Lines | Review note |
|---|---:|---|
| `public/js/ai-insights.js` | 892 | Notification and insight rendering share one view module |
| `src/history.js` | 847 | Store orchestration remains large after query/cache/bootstrap extraction |
| `src/db-migrate.js` | 818 | Schema migrations v1--v16 |
| `server.js` | 812 | Bootstrap and dependency wiring |
| `public/js/log.js` | 734 | Pagination, filtering, and rendering share one view module |
| `src/routes/agents.js` | 707 | Agent enrollment, approval, ingest, and capability routes; **grew 24% this cycle** |
| `public/js/graph.js` | 679 | Orchestrates extracted graph helpers/panels/renderer |
| `src/devices.js` | 665 | Device identity, persistence, and merge lifecycle |
| `src/pollers/cisco.js` | 661 | Stateful SSH lifecycle around extracted parser/handshake modules |
| `src/mcp-publication-gate.js` | 639 | Publication decision, client release timing, and diagnostics |
| `src/pollers/yamaha.js` | 627 | Stateful SSH lifecycle around adapter parsers |
| `public/js/devices.js` | 594 | Device UI orchestration |
| `public/js/auth-socket.js` | 575 | Auth-aware socket bootstrap and reconnection |
| `mcp-server.js` | 570 | Transport bootstrap and OAuth wiring |
| `src/ai-provider.js` | 563 | Multi-provider AI client with SSRF guard |

On the Swift side, `Xcode/Host/ObservationWindowController.swift` is by a wide margin the largest file in the agent and now carries the connection log, the sankey, the timeline, the globe, and their shared period selection. **It is the agent's equivalent of `ai-insights.js` and is the first candidate for extraction.**

---

## 6. macOS Application Quality (new this cycle)

The agent is not only Swift source; it is an application a user installs, grants a system extension to, and leaves running. This section evaluates it as such, against Apple's platform requirements (notarisation, hardened runtime, App Sandbox, entitlements, privacy manifest), the macOS Human Interface Guidelines, accessibility and localisation expectations, and energy behaviour.

**Score: 46/50**, re-measured on 0.5.30 build 95 after a VoiceOver audit and a diagnostics export were run on a real Mac.

| Area | Score | Evidence | Gap |
|---|---:|---|---|
| **Gatekeeper and notarisation** | 5/5 | On the installed 0.5.30 build 95: `spctl -a -t install` returns **accepted, source = Notarized Developer ID**; `stapler validate` succeeds, so it launches without a network round trip. The build script notarises and staples as part of packaging | -- |
| **Hardened runtime and signing** | 5/5 | `CodeDirectory flags=0x10000(runtime)` with a secure timestamp; host and system extension are signed separately with `--options runtime` and verified with `--strict` after signing and again after a packaging round trip | -- |
| **App Sandbox and least privilege** | 5/5 | Both host and extension are sandboxed. The host holds exactly five entitlements — app group, network client, user-selected files read/write, system-extension install, and the network-extension content filter. **There is no `com.apple.security.files.all` and no temporary-exception entitlement anywhere** | -- |
| **Privacy declaration** | **5/5** | **Both the app and the system extension now ship a `PrivacyInfo.xcprivacy`**, verified present in the built bundles rather than only in the repository. Each declares `NSPrivacyTracking: false`, no tracking domains, an **empty `NSPrivacyCollectedDataTypes`** — accurate, because nothing is transmitted where the developer can reach it — and reasons for the two required-reason categories the agent actually uses: user defaults (`CA92.1`, `1C8F.1`) and file timestamp (`C617.1`, reading the size of files it wrote itself). `NSSystemExtensionUsageDescription` remains accurate and specific. [`docs/agent-privacy.md`](agent-privacy.md) lists every host the agent contacts, what is sent, and what comes back — **including that reaching `dl.egressview.com` reveals the client IP to a CDN that keeps access logs**, which a privacy page listing only flattering facts would omit. A repository test fails the build if a call into an undeclared required-reason category appears in the source | -- |
| **Localisation** | 5/5 | `en.lproj` and `ja.lproj` each hold **491 keys with exact parity** — no key exists in one and not the other. UI language follows a user-selectable locale rather than being fixed at launch | -- |
| **Accessibility** | 5/5 | **Audited with VoiceOver on a real Mac (2026-08-23), and the audit found a defect the unit tests could not.** The globe was announced and the sankey and timeline were not: the same SwiftUI accessibility modifiers over a `Canvas` produce nothing VoiceOver lands on, while the globe worked because it is an `NSViewRepresentable`. Both now carry a real `NSView` that declares itself an element with a role and label, verified by hit-testing the accessibility tree directly — 25 sampled points across the timeline all return `AXImage` with its summary, and 19 of 25 across the sankey, the rest being its column labels. All three are reached and read by VoiceOver keyboard navigation | The globe follows the mouse pointer and the two charts do not, a consequence of `AXGroup` versus `AXImage`. Keyboard navigation is VoiceOver's primary model, so this is an inconsistency rather than a barrier |
| **Energy and resource behaviour** | 5/5 | Measured on this machine: host **0.0% CPU / 126 MB RSS after 2h02m**; extension **1.7% / 18 MB after 3h37m**. Periodic work uses a dispatch-source timer inside a `beginActivity` scope rather than a run-loop timer App Nap throttles; the globe redraws at a selectable 3/5/15 fps; windows are released on close so memory returns | Single machine, single sample |
| **HIG conformance** | 4/5 | A menu-bar-only app (`LSUIElement`), which is the right shape for a background observer; windows created on demand; login item managed through `SMAppService` rather than a legacy helper; minimum macOS 13.0 | No documented review against the current HIG; window state restoration is not implemented |
| **Update and uninstall** | 4/5 | In-app update checking against signed release metadata, with the downloaded package's signing **team identifier verified against the running app before install** — notarisation is then enforced independently by the installer. A first-class uninstall path exists and revokes the Hub registration, preserving the credential if the Hub cannot be reached | The `.pkg` releases carry no checksum or detached signature of the project's own (see §2). Four corrective releases were needed to make in-app update work from a sandbox |
| **Diagnostics** | **3/5** | Installation writes a instrumented log recording what the relaunch actually did. Swift tests: 419, 0 failing | **No crash reporting and no user-exportable diagnostic bundle.** When the agent misbehaves on someone else's Mac, there is no artefact to ask for |

**The action that would move this score most:**

1. **Add a diagnostics export** — a single button producing a redacted bundle. Without it, every field report is a conversation instead of an attachment.
2. **Run a VoiceOver pass** and record the result, so the accessibility work already done is verified rather than assumed.

The privacy manifest that this section previously identified as the clearest gap has been shipped, and the declaration is held to the source by a test rather than by intention.

---

## Conclusion

The code is in good shape and the macOS agent matured substantially: it now costs almost nothing to leave running, says so when it stops working, verifies its own updates, and passes Apple's platform requirements — notarised, stapled, hardened, sandboxed, and holding only the entitlements it actually uses. The localisation is complete to the key, and the custom visualisations were given accessibility summaries rather than left as opaque drawings. That is not the usual standard for a side-loaded utility.

The runtime-cost work deserves a sentence of its own, because the failure was of a specific and instructive kind: an agent that costs 41% of a CPU core is not a performance problem, it is a **credibility problem**. A tool that asks for a system extension in order to watch what your machine sends outward cannot also be the heaviest thing running on it. Four unrelated causes were each diagnosed and fixed rather than papered over with a longer polling interval, and the result was verified on hardware rather than inferred.

**The one regression this cycle was in release publication, not in code, and it has been closed.** Three product releases went out with no signed assets, in a project whose previous two reports both singled out signed, independently verifiable releases as its strongest supply-chain property. **A verification promise that is not kept for the version people actually download is not a verification promise.** v2.0.2 is now signed with the same key and the same procedure, and — importantly — was verified from the files as downloaded from the release page, against a fingerprint served by DNS under separate credentials, with three tamper cases each failing closed. That is the property the earlier reports described, restored rather than merely asserted.

**The reason it was missing has been addressed, and that mattered more than the signature itself.** Signing was a step a person had to remember, and three releases in a row are evidence that remembering is not a control. The pipeline had never failed; the discipline around it had. Releasing is now a single command that refuses to start from a checkout that is not the tag, proves three tamper cases fail, uploads to a draft, verifies the assets **as downloaded from the release page**, and only then publishes — so a failure anywhere leaves a draft rather than a public release with nothing to verify. A workflow checks the published result on publish, on edit, and weekly, catching a release made any other way. Signing deliberately stays on a workstation: moving the key into CI would trade a discipline problem for a supply-chain problem.

The rest of the improvement list is unchanged in kind: continuous fuzzing, and OpenAPI response shapes that are enforced rather than observed. None is a release blocker. Provenance is built and tested but has not yet ridden a release.
