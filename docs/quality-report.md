# EgressView Code Quality Report

- **Assessment date**: 2026-08-03
- **Baseline**: `dadc545` (after PR #165, parser fuzz tests)
- **Version**: 1.7.0
- **Node.js**: >=22 (CI: 22 and 24)
- **Method**: automated tests, V8 coverage, static analysis, dependency/secret scans, browser smoke tests, parser fuzzing, and manual review

> This report evaluates the current main line. SonarQube and OpenSSF scores are repository-based estimates; neither official scanner was run. No penetration test was performed.

---

## Executive Summary

**Overall grade: A**

No critical or high-severity defect was found. Since the previous report (v1.7.0 release preparation, PR #157 baseline), eight PRs (#158--#165) landed. This cycle addressed the two medium maintainability risks identified in the release report: the MCP surface was decomposed into focused modules (PR #163) reducing `mcp-server.js` from 1,076 to 570 lines, and parser fuzzing was added to CI (PR #165) closing the last OpenSSF Scorecard check that scored zero for a reason other than signing. Alongside these, SSRF protection was extended to block link-local and metadata IPs, per-detection notification switches gave operators granular control, the MCP audit retention schedule was fixed, and the coverage gate was raised from 70/75/65 to 83/79/80 with targeted security-path tests lifting coverage from 82.74% to 92.83% lines.

The security model is unchanged and carries the same operational evidence as the release report. The permission matrix grew from 93 to 106 entries (95 HTTP routes + 11 MCP tools) as per-detection notification routes were added. All new endpoints are permission-gated.

| Framework | Result | Verdict |
|---|---:|---|
| OWASP ASVS Level 1 | 14/14 areas satisfied or mitigated | Fully compliant |
| OpenSSF Scorecard | ~9.0/10 estimated | Strong repository hygiene |
| ISO/IEC 25010 | 9.1/10 average | High quality |
| Node.js Best Practices | 47/50 | Excellent |
| SonarQube-equivalent gate | Passed; coverage rating A | No high-severity blocker |

## Review Findings

### Changes since previous report (PR #157 baseline)

| PR | Title | Category |
|---:|---|---|
| #158 | v1.7.0 release preparation | Documentation |
| #159 | Set the v1.7.0 changelog date | Documentation |
| #160 | Block link-local/metadata IPs for operator-configured endpoints | Security |
| #161 | Per-detection notification switches (P2-76) | UX |
| #162 | Enforce MCP audit retention on a schedule (P2-73) | Bug fix |
| #163 | Split the MCP surface into focused modules (P2-68) | Refactoring |
| #164 | Raise the coverage gate to match reality (P2-69) | Testing |
| #165 | Fuzz the parsers that read untrusted device output (P2-71) | Testing |

### Key improvements

- **MCP decomposition (P2-68)**: the previous report's top maintainability risk is resolved. `mcp-server.js` was split into `src/mcp-tools.js` (tool definitions and server factory), `src/mcp-http-middleware.js` (auth, scope, context, rate limits, audit), `src/mcp-publication-constants.js`, and `src/mcp-publication-evidence.js`. The file dropped from 1,076 to 570 lines; `src/mcp-publication-gate.js` from 868 to 639. A new test assertion fails if tool definitions ever split back across files, weakening the permission-matrix scan.
- **Parser fuzzing (P2-71)**: 19 exported parse functions across conntrack, Cisco, Yamaha, ASUS, and three syslog readers are fuzzed with dependency-free generated inputs. Three properties are asserted per input: no throw, returns within a time budget (catastrophic backtracking), and declared shape. A short campaign (300 iterations) runs in CI; a 50,000-iteration run is available on demand. The fuzz harness has self-tests proving it detects throwing, wrong shape, and timeout. This closes the last zero-scoring OpenSSF check apart from release signing.
- **SSRF guard (PR #160)**: operator-configured outbound endpoints (Ollama, internal DNS/PTR) are now blocked from targeting link-local (169.254/16), metadata (fd00:ec2::254), multicast, and broadcast addresses in any mode. IPv4-mapped IPv6 forms are decoded and re-checked. Loopback and RFC 1918 remain allowed for self-hosted services.
- **Coverage gate (P2-69)**: CI thresholds raised from 70/75/65 to 83/79/80. The gap was closed by targeting branch-heavy security paths: OIDC token forgery, per-IP lockout, KDF migration rollback, AI notification refusals, and role derivation.
- **MCP audit retention (P2-73)**: `mcpAudit.prune()` now runs on a 24-hour unref'd schedule matching the application-side audit, so the documented 180-day window is enforced in long-running processes.
- **Per-detection notification switches (P2-76)**: threat detection and new-node detection each have independent Slack and history toggles, persisted in a `detectionNotifications` config section.

### Open risks

- **Low, operational**: the four hardware/external-service integration files are not part of the default CI workflow. Unit and browser smoke tests use fixtures and demo mode; Yamaha, ASUS, Slack, and conntrack integration still require an explicit environment.
- **Low, ecosystem**: no OpenAPI contract, OCI image, or GPG-signed release tag is provided. These remain demand-driven tasks rather than release blockers.
- **Low, maintainability**: `public/js/ai-insights.js` (872 lines) and `src/history.js` (789 lines) remain the largest non-poller modules. Neither grew in this cycle and both are bounded by tests.

---

## Measured Evidence

| Check | Result |
|---|---|
| Unit tests with coverage | 1,938 passed, 0 failed (456 suites) |
| V8 coverage | 92.83% lines, 88.56% branches, 89.17% functions |
| CI coverage minimums | 83% lines, 79% branches, 80% functions -- passed |
| Parser fuzz tests | 30 passed (3 suites, 300 iterations default) |
| Playwright browser smoke | 70 passed, 1 skipped |
| ESLint | Passed |
| Frontend HTML insertion audit | 0 `innerHTML` / `insertAdjacentHTML` assignments |
| Production dependency audit | 0 vulnerabilities |
| Secret scan | Passed; no high-signal secrets or environment-specific LAN IPs |
| ASH (Automated Security Helper) | 0 actionable findings |
| GitHub Actions SHA pinning | 19/19 pinned, 0 unpinned |
| GitHub CI on PR #165 | Node 22/24, release safety, ASH, fuzz, browser smoke, and Pages build passed |

### Codebase Metrics

Values in parentheses are the v1.7.0 release (PR #157) figures where they changed.

| Metric | Value |
|---|---:|
| Source lines (`server`, `mcp`, `src`, `public/js`) | 31,435 (30,984) |
| Test lines (unit, integration, smoke, fuzz, portability) | 31,851 (29,347) |
| Test-to-source ratio | 101.3% (94.7%) |
| Unit test files | 138 (128) |
| Integration test files | 4 |
| Fuzz test files | 3 (new) |
| Browser smoke file | 1 (1,740 lines) |
| Portability test file | 1 |
| Source modules under `src/` | 113 (107) |
| Poller modules | 15 |
| Route modules | 18 (17) |
| HTTP routes in permission matrix | 95 (92) |
| MCP tools | 11 |
| Permission matrix entries | 106 (93) |
| Authenticated/permission-gated API endpoints | 87/93 (84/90) |
| Public API endpoints | login, admin-verify, auth-status, auth-methods, oidc-start, oidc-callback |
| Public operational endpoints | `/healthz` and `/readyz`, fixed minimal responses |
| Endpoint-bearing route modules using strict Zod | 17/18 (16/17) |
| Defined permissions | 7 |
| Roles | 3 (viewer, operator, admin) |
| Production dependencies | 13 |
| Documentation files under `docs/` | 36 |
| Parameterized SQL preparation sites | 152 |
| Server-side `var` | 0 |
| `eval` / `new Function` | 0 |
| TODO/FIXME/HACK markers | 0 |
| `innerHTML` / `insertAdjacentHTML` | 0 |

---

## 1. OWASP ASVS Level 1

**Verdict: fully compliant (14/14 areas satisfied or mitigated).**

| Area | Status | Evidence |
|---|---|---|
| Authentication | Pass | scrypt with versioned KDF migration, timing-safe comparisons, 256-bit session tokens, delayed failures, per-IP lockout, Google OIDC with PKCE |
| Session management | Pass | Hashed tokens, sliding expiry, revocation, password-change handling, periodic pruning, role-bound sessions |
| Access control | Pass | 87/93 API endpoints gated by `enforceApiPermissions`; deny-by-default permission boundary; WebSocket handshake shares the same boundary; 106-entry permission matrix |
| Input validation | Pass | 64 KB JSON limit, strict Zod on 17/18 endpoint modules, unknown-key rejection, bounded strings/ranges, SSRF guard for outbound endpoints |
| Cryptography | Pass | `randomBytes`/UUID for secrets and correlation, SHA-256 for session/TOFU/principalHash, timing-safe equality, RS256 JWT verification for MCP |
| Error handling | Pass | Generic 500 responses, no stack exposure, request-correlated server logs |
| Data protection | Pass | Config, backup, and TLS key mode 0600; secrets excluded from public config and logs; API identity hash-only storage |
| Communications | Pass | HTTPS/HSTS supported; OIDC callback enforces secure redirect; MCP OAuth via HTTPS JWKS |
| Malicious code | Pass | No eval; frontend HTML insertion audit is enforced in CI |
| File handling | Pass | Bounded uploads, validated backup names, traversal checks, fail-closed restore/migration |
| API security | Pass | Method-specific routes, strict schemas, response-size/time bounds, authenticated exports, MCP rate limiting |
| Configuration | Pass | No hard-coded credentials, example configuration, secret scan, production demo-mode refusal |
| Business logic | Pass | HttpOnly cookies with CSRF protection; explicit permission tokens for API identities; deny-by-default enforcement |
| Audit and logging | Pass | Append-only audit_events with pseudonymous actorHash/principalHash, 180-day retention enforced on a 24-hour schedule, MCP-separate audit store with keyed client address |

The health endpoints are intentionally unauthenticated but return only fixed liveness/readiness state with `no-store`; they expose no router addresses, credentials, or counts.

---

## 2. OpenSSF Scorecard (Estimated)

**Estimated score: 9.0/10.**

| Check | Score | Evidence |
|---|---:|---|
| Pinned dependencies | 10 | All 19 GitHub Actions pinned to full commit SHA |
| Token permissions | 10 | Read-only default; Pages widens only the permissions it needs |
| Dangerous workflow | 10 | No `pull_request_target` |
| Binary artifacts | 10 | No committed binaries |
| Security policy | 10 | `SECURITY.md` and private vulnerability reporting |
| License | 10 | AGPL-3.0-only |
| SAST | 10 | ASH, secret scan, ESLint, frontend insertion audit, npm audit |
| Vulnerabilities | 10 | Production `npm audit` in CI; 0 findings in this review |
| Dependency updates | 10 | Weekly Dependabot for npm and Actions with a 7-day cooldown |
| CI tests | 10 | Unit/coverage, parser fuzz, and browser smoke on PRs; hardware integration is explicit, not default |
| Maintained | 10 | Active release and PR history through PR #165 (161 merged PRs) |
| Code review | 8 | PR workflow with required checks; RBAC and permission matrix enforce review standards |
| Fuzzing | 5 | Parser fuzzing covers 19 functions that read untrusted device input, with time-budget and shape assertions; dependency-free, runs in CI. Not yet a continuous-fuzzing service (OSS-Fuzz or similar) |
| Signed releases | 2 | The tooling and a written key procedure exist, and the release path can produce a signed portable source distribution with a CycloneDX SBOM. **No release is actually signed.** `release-signing/trusted-fingerprints.json` holds no enrolled key and v1.7.0 ships unsigned by decision. Credit is for the mechanism only. The build emits `<artifact>.sig`, so enrolling a key and attaching that asset reaches the signature band (8). The remaining 2 points require a SLSA provenance file (`*.intoto.jsonl`) per release. |

---

## 3. ISO/IEC 25010

| Characteristic | Score | Strengths | Remaining gap |
|---|---:|---|---|
| Functional suitability | 9 | Multi-router collection, AI insights with notifications, threat investigation, exports, MCP with OAuth, per-detection notification granularity | No OpenAPI contract |
| Performance efficiency | 9 | WAL, batching, bounded summaries, caches, worker-isolated backup, MCP concurrency cap | Heavy backup checks can still create short host-level latency spikes |
| Compatibility | 9 | Node 22/24, JA/EN, Yamaha/Cisco/ASUS/conntrack paths, Cognito compatibility profile, correct operation at `/` and at a subpath behind a proxy | Hardware-specific verification remains fixture-dependent in CI |
| Usability | 9 | Responsive UI, setup guides, auto-detection, health diagnostics, role display, per-detection notification switches | No one-click deployment |
| Reliability | 9 | Fail-closed migration/restore/config/notes, health/readiness, cancellation, request IDs, ASUS auto-reconnect, rate limiting, scheduled audit retention | No built-in service supervisor |
| Security | 10 | OIDC/PKCE, RBAC, deny-by-default permissions, CSRF, HttpOnly cookies, API identity hash-only storage, MCP OAuth/JWKS, audit trail, rate limits, SSRF guard for outbound endpoints | -- |
| Maintainability | 9 | 113 modules, strong tests (101.3% test-to-source ratio), split route/poller/query boundaries, permission matrix, MCP decomposed into focused modules, parser fuzz coverage | `public/js/ai-insights.js` (872 lines) and `src/history.js` (789 lines) remain large |
| Portability | 9 | Cloud-neutral profiles, signed portable source bundle, offline mode with a pre-startup feature policy, offline portability gates for host and container, versioned rollback | No supported OCI image/systemd unit |

**Average: 9.1/10.**

---

## 4. Node.js Best Practices

**Adherence: 47/50 (94%).**

- Domain modules, route modules, poller adapters, DB bootstrap, auth middleware, and browser rendering responsibilities are separated.
- Async external calls have timeouts/AbortSignal bounds; backup pruning uses a worker and single-flight job state; ASUS polling coalesces overlapping cycles; MCP requests are concurrency-capped.
- The logger adds a bounded `X-Request-Id` context through `AsyncLocalStorage` without logging query strings.
- Graceful shutdown, readiness, schema migration, config rollback, persistence failure, and permission enforcement tests cover lifecycle boundaries.
- ESLint, V8 coverage, Node 22/24, Playwright, parser fuzz, ASH, secret scanning, and dependency audit run as PR gates.
- Authentication logic is separated into dedicated modules (auth-middleware, auth-cookies, auth-audit, oidc-google) following single-responsibility.
- Parser inputs from untrusted devices are fuzzed with shape and time-budget assertions.
- SSRF protection covers operator-configured outbound endpoints against link-local, metadata, multicast, and broadcast addresses.

Points are withheld for no default hardware integration CI, no supported process-manager/OCI artifact, and no OpenAPI contract.

---

## 5. SonarQube-Equivalent Gate

| Metric | Result | Rating |
|---|---:|---|
| Reliability | No known critical/high defect | A |
| Security | No open high-signal secret or dependency finding; full RBAC, audit, and SSRF protection | A |
| Maintainability | MCP decomposition resolved the top risk; remaining large modules are bounded by tests | A |
| Coverage | 92.83% lines / 88.56% branches / 89.17% functions | A |
| Duplication | No material new duplication identified in manual/static review | A (estimated) |

**Quality gate: passed.**

### Primary Maintainability Hotspots

| File | Lines | Review note |
|---|---:|---|
| `public/js/ai-insights.js` | 872 | Notification and insight rendering share one view module |
| `src/history.js` | 789 | Store orchestration remains large after query/cache/bootstrap extraction |
| `server.js` | 730 | Bootstrap and dependency wiring |
| `public/js/log.js` | 715 | Pagination, filtering, and rendering share one view module |
| `public/js/graph.js` | 675 | Orchestrates extracted graph helpers/panels/renderer |
| `src/devices.js` | 665 | Device identity, persistence, and merge lifecycle |
| `src/pollers/cisco.js` | 645 | Stateful SSH lifecycle around extracted parser/handshake modules |
| `src/mcp-publication-gate.js` | 639 | Publication decision, client release timing, and diagnostics (reduced from 868) |
| `src/pollers/yamaha.js` | 614 | Stateful SSH lifecycle around adapter parsers |
| `public/js/devices.js` | 593 | Device UI orchestration |
| `mcp-server.js` | 570 | Transport bootstrap and OAuth wiring (reduced from 1,076) |
| `src/device-identify.js` | 559 | Device fingerprinting heuristics |
| `src/ai-provider.js` | 559 | Multi-provider AI client with SSRF guard |
| `src/db-migrate.js` | 557 | Schema migrations v1-v12 |

The MCP surface, previously the top hotspot, has been decomposed. Remaining items are refactoring candidates, not current release blockers.

---

## Conclusion

The current main line is suitable for its documented self-hosted deployment model with strong multi-user security controls. Automated quality gates are broad, data-changing operations fail closed, AI provider calls are time-bounded and context-capped, full RBAC with deny-by-default permissions is enforced, MCP access is OAuth-protected with rate limiting and audit, and no critical or high issue remains.

This assessment cycle resolved the two medium risks flagged in the v1.7.0 release report. The MCP surface was decomposed from two overloaded modules (1,076 + 868 lines) into focused single-responsibility units (570 + 639 + 4 extracted modules), and parser fuzzing was introduced to CI -- covering the 19 functions that parse untrusted device output with throw, shape, and time-budget assertions. The coverage gate was tightened from 70/75/65 to 83/79/80, and measured coverage rose from 82.74% to 92.83% lines (88.56% branches, 89.17% functions) through targeted tests on branch-heavy security paths. The test-to-source ratio crossed 100% for the first time.

New SSRF protection blocks operator-configured endpoints from reaching link-local and cloud metadata IPs, per-detection notification switches give operators granular control, and the MCP audit retention schedule now enforces the documented 180-day window continuously rather than only at startup.

The clearest remaining debt is structural cosmetics rather than risk: frontend view modules (`ai-insights.js` at 872, `log.js` at 715) and `src/history.js` at 789 lines are large but stable, bounded by tests, and have not grown in this cycle. OpenAPI, continuous fuzzing via OSS-Fuzz, GPG-signed tags, and OCI distribution remain requirement-driven enhancements.
