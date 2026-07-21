# EgressView Code Quality Report

- **Assessment date**: 2026-07-21
- **Baseline**: `cee5f5f` (main after PR #121)
- **Version**: 1.5.1
- **Node.js**: >=22 (CI: 22 and 24)
- **Method**: automated tests, V8 coverage, static analysis, dependency/secret scans, browser smoke tests, and manual review

> This report evaluates the current main line. SonarQube and OpenSSF scores are repository-based estimates; neither official scanner was run. No penetration test or fuzzing campaign was performed.

---

## Executive Summary

**Overall grade: A**

No critical or high-severity defect was found. The medium note-persistence defect identified in the previous review (PR #112) remains fixed. Since that fix, ten additional PRs (#112–#121) landed: three AI chat reliability fixes, ASUS bootstrap reconnection, bounded device context for AI insights, pricing coverage diagnostics, demo database isolation, and dependency maintenance. All changes include regression tests, and the test suite grew from 1,465 to 1,477 unit tests.

The current codebase maintains strong automated controls for a self-hosted SOHO network monitor: all endpoint-bearing route modules use strict Zod validation, 71 of 73 API endpoints require authentication, database migrations and restores are fail-closed, request IDs correlate HTTP logs, AI provider requests are time-bounded with AbortSignal, ASUS polling overlap is coalesced, and backup verification runs outside the main event loop.

| Framework | Result | Verdict |
|---|---:|---|
| OWASP ASVS Level 1 | 13/14 areas satisfied or mitigated | Compliant for the documented private-network deployment model |
| OpenSSF Scorecard | ~8.4/10 estimated | Strong repository hygiene |
| ISO/IEC 25010 | 8.6/10 average | High quality |
| Node.js Best Practices | 45/50 | Excellent |
| SonarQube-equivalent gate | Passed; coverage rating B | No high-severity blocker |

## Review Findings

### Changes since previous report (PR #111 baseline)

| PR | Title | Category |
|---:|---|---|
| #112 | Make note persistence fail-closed | Reliability fix |
| #113 | Preserve failed AI chat questions | AI reliability |
| #114 | Start new AI chat after provider switch | AI reliability |
| #115 | Restore ASUS polling after restart | Bootstrap fix |
| #116 | Add bounded device context to AI insights | Feature |
| #117 | Add GPT-5.5 usage pricing | Feature |
| #118 | Improve AI pricing coverage diagnostics | Feature |
| #119 | Isolate demo database runtime artifacts | Hygiene |
| #120 | Bump actions group (setup-node 7, configure-pages 6, upload-pages-artifact 5, deploy-pages 5) | Dependency |
| #121 | Bump bonjour-service 1.4.3, eslint 10.7.0 | Dependency |

### Key improvements

- **AI chat resilience**: conversation ID is now preserved across inference failures; unsent questions are restored to the input field on pre-persistence network failures; a new conversation starts automatically when the configured provider or model changes rather than returning HTTP 409.
- **ASUS bootstrap**: saved ASUS credentials are now restored at server startup, with overlap-coalesced poll cycles preventing duplicate token renewals.
- **AI context boundary**: device inventory (capped at 30 devices, 48 KiB total context) is included for AI analysis while excluding credentials, notes, raw logs, archived devices, and management addresses.
- **Pricing diagnostics**: monthly AI cost is marked partial when pricing data is unavailable; coverage metrics are shown for both discovered and manually entered models.
- **Demo isolation**: runtime database and backups are now confined under a single ignored directory with schema-v7 snapshot health checks.

### Open risks

- **Medium, operational**: the four hardware/external-service integration files are not part of the default CI workflow. Unit and browser smoke tests use fixtures and demo mode; Yamaha, ASUS, Slack, and conntrack integration still require an explicit environment.
- **Low, maintainability**: `history.js` (763 lines), `public/js/log.js` (715), `public/js/graph.js` (675), `devices.js` (665), and the Cisco/Yamaha pollers remain the largest change surfaces. Their critical parsers and data paths are tested, but future feature growth should preserve the existing extraction pattern.
- **Low, conditional security**: the current design assumes VPN/private-network access and header-token/session authentication. Direct Internet or multi-user exposure should first add a trusted TLS reverse proxy, IP allowlisting, proxy-aware global rate limiting, and audited client-IP handling (P2-41).
- **Low, ecosystem**: no OpenAPI contract, signed release artifacts, fuzzing, or OCI image is provided. These remain demand-driven tasks rather than release blockers.

---

## Measured Evidence

| Check | Result |
|---|---|
| Unit tests with coverage | 1,477 passed, 0 failed |
| V8 coverage | 79.36% lines, 79.40% branches, 75.94% functions |
| CI coverage minimums | 70% lines, 75% branches, 65% functions — passed |
| Playwright browser smoke | 66 passed, 1 conditional skip |
| ESLint | Passed |
| Frontend HTML insertion audit | 0 `innerHTML` / `insertAdjacentHTML` assignments |
| Production dependency audit | 0 vulnerabilities |
| Secret scan | Passed; no high-signal secrets or environment-specific LAN IPs |
| Package dry-run | Passed |
| GitHub CI on PR #121 | Node 22/24, release safety, ASH, browser smoke, and Pages build passed |

### Codebase Metrics

| Metric | Value |
|---|---:|
| Source lines (`server`, `mcp`, `src`, `public/js`) | 24,739 |
| Test lines (unit, integration, smoke) | 22,999 |
| Test-to-source ratio | 93.0% |
| Unit test files | 104 |
| Integration test files | 4 |
| Browser smoke file | 1 (1,558 lines) |
| Source modules under `src/` | 85 |
| Poller modules | 15 |
| Route modules | 14 |
| HTTP endpoints | 75 (73 API + 2 health) |
| Authenticated API endpoints | 71/73 |
| Public API endpoints | Login and admin-token verification |
| Public operational endpoints | `/healthz` and `/readyz`, fixed minimal responses |
| Endpoint-bearing route modules using strict Zod | 13/13 |
| Production dependencies | 12 |
| Parameterized SQL preparation sites | 119 |
| Server-side `var` | 0 |
| `eval` / `new Function` | 0 |
| TODO/FIXME/HACK markers | 0 |

---

## 1. OWASP ASVS Level 1

**Verdict: compliant for the documented deployment model (13/14 areas satisfied or mitigated).**

| Area | Status | Evidence |
|---|---|---|
| Authentication | Pass | scrypt password hashing, timing-safe comparisons, 256-bit session tokens, delayed failures, per-IP lockout |
| Session management | Pass | Hashed tokens, sliding expiry, revocation, password-change handling, periodic pruning |
| Access control | Pass | 71/73 API endpoints use `requireAdmin`; WebSocket handshake uses the same authentication boundary |
| Input validation | Pass | 64 KB JSON limit, strict Zod on 13/13 endpoint modules, unknown-key rejection, bounded strings/ranges |
| Cryptography | Pass | `randomBytes`/UUID for secrets and correlation, SHA-256 for session/TOFU identity, timing-safe equality |
| Error handling | Pass | Generic 500 responses, no stack exposure, request-correlated server logs |
| Data protection | Pass | Config, backup, and TLS key mode 0600; secrets excluded from public config and logs |
| Communications | Pass with deployment condition | Optional HTTPS and HSTS; private-network/VPN deployment remains the default |
| Malicious code | Pass | No eval; frontend HTML insertion audit is enforced in CI |
| File handling | Pass | Bounded uploads, validated backup names, traversal checks, fail-closed restore/migration |
| API security | Pass | Method-specific routes, strict schemas, response-size/time bounds, authenticated exports |
| Configuration | Pass | No hard-coded credentials, example configuration, secret scan, production demo-mode refusal |
| Business logic | Mitigated | No cookie-based authentication; classic CSRF is reduced by explicit header tokens. Reassess if cookie auth or direct Internet exposure is introduced |

The health endpoints are intentionally unauthenticated but return only fixed liveness/readiness state with `no-store`; they expose no router addresses, credentials, or counts.

---

## 2. OpenSSF Scorecard (Estimated)

**Estimated score: 8.4/10.**

| Check | Score | Evidence |
|---|---:|---|
| Pinned dependencies | 10 | Every GitHub Action is pinned to a full commit SHA |
| Token permissions | 10 | Read-only default; Pages widens only the permissions it needs |
| Dangerous workflow | 10 | No `pull_request_target` |
| Binary artifacts | 10 | No committed binaries |
| Security policy | 10 | `SECURITY.md` and private vulnerability reporting |
| License | 10 | AGPL-3.0-only |
| SAST | 10 | ASH, secret scan, ESLint, and frontend insertion audit |
| Vulnerabilities | 10 | Production `npm audit` in CI; 0 findings in this review |
| Dependency updates | 10 | Weekly Dependabot for npm and Actions with a 7-day cooldown |
| CI tests | 9 | Unit/coverage and browser smoke on PRs; hardware integration is explicit, not default |
| Maintained | 10 | Active release and PR history through PR #121 |
| Code review | 7 | PR workflow and required checks are used; branch-protection policy was not independently verified |
| Fuzzing | 0 | No continuous fuzzing |
| Signed releases | 0 | No GPG/Sigstore release signing |

---

## 3. ISO/IEC 25010

| Characteristic | Score | Strengths | Remaining gap |
|---|---:|---|---|
| Functional suitability | 9 | Multi-router collection, AI insights with device context, threat investigation, exports, MCP | No OpenAPI contract |
| Performance efficiency | 9 | WAL, batching, bounded summaries, caches, worker-isolated backup verification | Heavy backup checks can still create short host-level latency spikes |
| Compatibility | 8 | Node 22/24, JA/EN, Yamaha/Cisco/ASUS/conntrack paths | Hardware-specific verification remains fixture-dependent in CI |
| Usability | 9 | Responsive UI, setup guides, auto-detection, health diagnostics, AI pricing coverage display | No one-click deployment |
| Reliability | 9 | Fail-closed migration/restore/config/notes, health/readiness, cancellation, request IDs, ASUS auto-reconnect | No built-in service supervisor |
| Security | 9 | Strict schemas, CSP, secret controls, ASH, bounded AI context (48 KiB cap, credential exclusion) | Internet-edge controls are conditional |
| Maintainability | 9 | 85 modules, strong tests, split route/poller/query boundaries | Several 600-763-line orchestration modules remain |
| Portability | 7 | Pure Node runtime and environment configuration | No supported OCI image/systemd unit |

**Average: 8.6/10.**

---

## 4. Node.js Best Practices

**Adherence: 45/50 (90%).**

- Domain modules, route modules, poller adapters, DB bootstrap, and browser rendering responsibilities are separated.
- Async external calls have timeouts/AbortSignal bounds; backup pruning uses a worker and single-flight job state; ASUS polling coalesces overlapping cycles.
- The logger adds a bounded `X-Request-Id` context through `AsyncLocalStorage` without logging query strings.
- Graceful shutdown, readiness, schema migration, config rollback, and persistence failure tests cover important lifecycle boundaries.
- ESLint, V8 coverage, Node 22/24, Playwright, ASH, secret scanning, and dependency audit run as PR gates.

Points are withheld for no default hardware integration CI, no process manager/container artifact, no OpenAPI contract, and no global edge rate limit for Internet-facing operation.

---

## 5. SonarQube-Equivalent Gate

| Metric | Result | Rating |
|---|---:|---|
| Reliability | No known critical/high defect; previous medium note-write defect remains fixed | A |
| Security | No open high-signal secret or dependency finding | A |
| Maintainability | Large modules are known but bounded by tests and extracted helpers | A |
| Coverage | 79.36% lines / 79.40% branches / 75.94% functions | B |
| Duplication | No material new duplication identified in manual/static review | A (estimated) |

**Quality gate: passed.**

### Primary Maintainability Hotspots

| File | Lines | Review note |
|---|---:|---|
| `src/history.js` | 763 | Store orchestration remains large after query/cache/bootstrap extraction |
| `public/js/log.js` | 715 | Pagination, filtering, and rendering share one view module |
| `public/js/graph.js` | 675 | Orchestrates extracted graph helpers/panels/renderer |
| `src/devices.js` | 665 | Device identity, persistence, and merge lifecycle |
| `src/pollers/cisco.js` | 645 | Stateful SSH lifecycle around extracted parser/handshake modules |
| `server.js` | 638 | Bootstrap and dependency wiring |
| `src/pollers/yamaha.js` | 614 | Stateful SSH lifecycle around adapter parsers |

These are refactoring candidates, not current release blockers. Changes should remain incremental and behavior-preserving.

---

## Conclusion

The current main line is suitable for its documented self-hosted, private-network deployment model. Automated quality gates are broad, data-changing operations fail closed, AI provider calls are time-bounded and context-capped, and no critical/high issue remains. Since the previous report, AI chat resilience, ASUS bootstrap reliability, and pricing observability have improved without introducing new defects or regressions. OpenAPI, Internet-edge hardening, conntrack hardware expansion, and OCI distribution should remain requirement-driven.
