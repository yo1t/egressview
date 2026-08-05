# EgressView Code Quality Report

- **Assessment date**: 2026-08-05
- **Baseline**: `f8c9116` (after PR #177, KMS release signing key enrolled)
- **Version**: 1.7.0
- **Node.js**: >=22 (CI: 22, 24, and 26)
- **Method**: automated tests, V8 coverage, static analysis, dependency/secret scans, browser smoke tests, parser fuzzing, and manual review

> This report evaluates the current main line. SonarQube and OpenSSF scores are repository-based estimates; neither official scanner was run. No penetration test was performed.

---

## Executive Summary

**Overall grade: A**

No critical or high-severity defect was found. Since the previous report (PR #165 baseline), twelve PRs (#166--#177) landed. This cycle completed the release signing story: an AWS KMS asymmetric Ed25519 key was enrolled, its public verification key and fingerprint were published across four independent channels (repository, SECURITY.md, project site, DNS TXT), and the offline bundle tooling can now sign with KMS without changing the verifier. Alongside this, production dependency vulnerabilities were resolved via overrides (socket.io-parser memory exhaustion, hono ReDoS), better-sqlite3 was deliberately pinned to 12 with the glibc reason documented, a rate-limit window-boundary test flake was eliminated, CI was extended to Node 26, and the native-dependency audit blind spot was documented.

Coverage remains at the A rating (92.59% lines, 88.61% branches, 89.12% functions) with the CI gate at 83/79/80. The test-to-source ratio rose to 102.5%. The security model is unchanged. The permission matrix grew from 106 to 107 entries (96 HTTP routes + 11 MCP tools) as the KMS signing test added one fixture route.

| Framework | Result | Verdict |
|---|---:|---|
| OWASP ASVS Level 1 | 14/14 areas satisfied or mitigated | Fully compliant |
| OpenSSF Scorecard | ~9.2/10 estimated | Strong repository hygiene |
| ISO/IEC 25010 | 9.1/10 average | High quality |
| Node.js Best Practices | 47/50 | Excellent |
| SonarQube-equivalent gate | Passed; coverage rating A | No high-severity blocker |

## Review Findings

### Changes since previous report (PR #165 baseline)

| PR | Title | Category |
|---:|---|---|
| #166 | Refresh quality report after PR #165 | Documentation |
| #167 | Dependabot: bump minor-and-patch group (5 updates) | Dependencies |
| #168 | Dependabot: bump better-sqlite3 12→13 | Dependencies |
| #169 | Pin patched hono and socket.io-parser to clear audit gate | Security |
| #170 | Stop rate-limit tests straddling a fixed-window boundary | Testing |
| #171 | Pin better-sqlite3 to 12 — arm64 prebuild needs glibc the host lacks | Fix |
| #172 | Dependabot: bump AWS SDK minor | Dependencies |
| #173 | Correct why better-sqlite3 must stay on 12 | Documentation |
| #174 | Note that npm audit cannot see bundled C libraries | Documentation |
| #175 | Also run unit tests on Node 26 | CI |
| #176 | Sign the offline distribution with AWS KMS (P2-70) | Security |
| #177 | Enrol the release signing key and publish its fingerprint (P2-70) | Security |

### Key improvements

- **KMS release signing (P2-70)**: the release key is now an asymmetric KMS key (`ECC_NIST_EDWARDS25519`) whose private half cannot be exported. The verifier is unchanged — still raw Ed25519 over the checksum file, verifiable with only `openssl` and the committed `.pub.pem`. The fingerprint is published in `SECURITY.md`, both site pages, both distribution guides, and a DNS TXT record. The trust registry has tests that recompute every enrolled fingerprint from the committed key, reject private key material, and enforce the single-active-key rule.
- **Vulnerability overrides (PR #169)**: `socket.io-parser` ≤4.2.6 (high, memory exhaustion) and `hono` <4.12.34 (moderate, ReDoS) were patched via `overrides` since no parent version carried the fix. The Socket.IO and MCP transports were exercised after the override.
- **better-sqlite3 pin (PR #171, #173)**: pinned to `^12.11.1`. The real blocker is not compilation but the arm64 prebuild requiring glibc 2.38, which Amazon Linux 2023 (2.34) lacks. CI runs x64 so it passes — production breaks. The Dependabot ignore and the reasoning are documented in the config.
- **Native dependency audit blind spot (PR #174)**: documented that `npm audit` cannot see bundled C libraries (SQLite), with instructions to check the version, compile options, and the ABI trap.
- **Node 26 CI (PR #175)**: the matrix now covers 22, 24, and 26. Node 26 becomes LTS on 2026-10-28. The `engines` field stays `>=22`.
- **Rate-limit flake fix (PR #170)**: window-boundary straddling was pinned deterministically using the limiter's injectable clock, and HTTP-boundary tests wait when close to a minute edge.

### Open risks

- **Low, operational**: the four hardware/external-service integration files are not part of the default CI workflow. Unit and browser smoke tests use fixtures and demo mode.
- **Low, ecosystem**: no OpenAPI contract, OCI image, or GPG-signed git tag is provided.
- **Low, maintainability**: `public/js/ai-insights.js` (872 lines) and `src/history.js` (789 lines) remain the largest non-poller modules. Neither grew in this cycle.
- **Low, supply chain**: `npm audit` cannot see SQLite CVEs inside the `better-sqlite3` amalgamation. The blind spot is documented with manual verification steps.

---

## Measured Evidence

| Check | Result |
|---|---|
| Unit tests with coverage | 1,961 passed, 0 failed (463 suites) |
| V8 coverage | 92.59% lines, 88.61% branches, 89.12% functions |
| CI coverage minimums | 83% lines, 79% branches, 80% functions -- passed |
| Parser fuzz tests | 30 passed (3 suites, 300 iterations default) |
| Playwright browser smoke | 70 passed, 1 skipped |
| ESLint | Passed |
| Frontend HTML insertion audit | 0 `innerHTML` / `insertAdjacentHTML` assignments |
| Production dependency audit | 0 vulnerabilities |
| Secret scan | Passed; no high-signal secrets or environment-specific LAN IPs |
| ASH (Automated Security Helper) | 0 actionable findings |
| GitHub Actions SHA pinning | 19/19 pinned, 0 unpinned |

### Codebase Metrics

Values in parentheses are the PR #165 figures where they changed.

| Metric | Value |
|---|---:|
| Source lines (`server`, `mcp`, `src`, `public/js`) | 31,435 |
| Test lines (unit, integration, smoke, fuzz, portability) | 32,214 (31,851) |
| Test-to-source ratio | 102.5% (101.3%) |
| Unit test files | 140 (138) |
| Integration test files | 4 |
| Fuzz test files | 3 |
| Browser smoke file | 1 (1,740 lines) |
| Portability test file | 1 |
| Source modules under `src/` | 113 |
| Poller modules | 15 |
| Route modules | 18 |
| HTTP routes in permission matrix | 96 (95) |
| MCP tools | 11 |
| Permission matrix entries | 107 (106) |
| Authenticated/permission-gated API endpoints | 88/94 (87/93) |
| Public API endpoints | login, admin-verify, auth-status, auth-methods, oidc-start, oidc-callback |
| Public operational endpoints | `/healthz` and `/readyz`, fixed minimal responses |
| Endpoint-bearing route modules using strict Zod | 17/18 |
| Defined permissions | 7 |
| Roles | 3 (viewer, operator, admin) |
| Production dependencies | 13 |
| Documentation files under `docs/` | 36 |
| Parameterized SQL preparation sites | 152 |
| Server-side `var` | 0 |
| `eval` / `new Function` | 0 |
| TODO/FIXME/HACK markers | 0 |
| `innerHTML` / `insertAdjacentHTML` | 0 |
| CI Node.js versions | 22, 24, 26 |
| Release signing key | 1 active (KMS Ed25519, enrolled in trusted-fingerprints.json) |

---

## 1. OWASP ASVS Level 1

**Verdict: fully compliant (14/14 areas satisfied or mitigated).**

| Area | Status | Evidence |
|---|---|---|
| Authentication | Pass | scrypt with versioned KDF migration, timing-safe comparisons, 256-bit session tokens, delayed failures, per-IP lockout, Google OIDC with PKCE |
| Session management | Pass | Hashed tokens, sliding expiry, revocation, password-change handling, periodic pruning, role-bound sessions |
| Access control | Pass | 88/94 API endpoints gated by `enforceApiPermissions`; deny-by-default permission boundary; WebSocket handshake shares the same boundary; 107-entry permission matrix |
| Input validation | Pass | 64 KB JSON limit, strict Zod on 17/18 endpoint modules, unknown-key rejection, bounded strings/ranges, SSRF guard for outbound endpoints |
| Cryptography | Pass | `randomBytes`/UUID for secrets and correlation, SHA-256 for session/TOFU/principalHash, timing-safe equality, RS256 JWT verification for MCP, KMS Ed25519 for release signing |
| Error handling | Pass | Generic 500 responses, no stack exposure, request-correlated server logs |
| Data protection | Pass | Config, backup, and TLS key mode 0600; secrets excluded from public config and logs; API identity hash-only storage |
| Communications | Pass | HTTPS/HSTS supported; OIDC callback enforces secure redirect; MCP OAuth via HTTPS JWKS |
| Malicious code | Pass | No eval; frontend HTML insertion audit is enforced in CI |
| File handling | Pass | Bounded uploads, validated backup names, traversal checks, fail-closed restore/migration |
| API security | Pass | Method-specific routes, strict schemas, response-size/time bounds, authenticated exports, MCP rate limiting |
| Configuration | Pass | No hard-coded credentials, example configuration, secret scan, production demo-mode refusal |
| Business logic | Pass | HttpOnly cookies with CSRF protection; explicit permission tokens for API identities; deny-by-default enforcement |
| Audit and logging | Pass | Append-only audit_events with pseudonymous actorHash/principalHash, 180-day retention enforced on a 24-hour schedule, MCP-separate audit store with keyed client address |

---

## 2. OpenSSF Scorecard (Estimated)

**Estimated score: 9.2/10.**

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
| CI tests | 10 | Unit/coverage, parser fuzz, and browser smoke on PRs; Node 22/24/26 matrix |
| Maintained | 10 | Active release and PR history through PR #177 (173 merged PRs) |
| Code review | 8 | PR workflow with required checks; RBAC and permission matrix enforce review standards |
| Fuzzing | 5 | Parser fuzzing covers 19 functions that read untrusted device input, with time-budget and shape assertions; dependency-free, runs in CI. Not yet a continuous-fuzzing service |
| Signed releases | 6 | KMS Ed25519 signing key enrolled with multi-channel fingerprint publication. The tooling produces a signed portable source distribution. **v1.7.0 itself ships unsigned** — the key was enrolled after the release. Credit is for the enrolled key, the mechanism, and the trust registry tests. Reaching 8 requires attaching the `.sig` asset to a GitHub release; the remaining 2 require SLSA provenance. |

---

## 3. ISO/IEC 25010

| Characteristic | Score | Strengths | Remaining gap |
|---|---:|---|---|
| Functional suitability | 9 | Multi-router collection, AI insights with notifications, threat investigation, exports, MCP with OAuth, per-detection notification granularity | No OpenAPI contract |
| Performance efficiency | 9 | WAL, batching, bounded summaries, caches, worker-isolated backup, MCP concurrency cap | Heavy backup checks can still create short host-level latency spikes |
| Compatibility | 9 | Node 22/24/26, JA/EN, Yamaha/Cisco/ASUS/conntrack paths, Cognito compatibility profile, correct operation at `/` and at a subpath behind a proxy | Hardware-specific verification remains fixture-dependent in CI |
| Usability | 9 | Responsive UI, setup guides, auto-detection, health diagnostics, role display, per-detection notification switches | No one-click deployment |
| Reliability | 9 | Fail-closed migration/restore/config/notes, health/readiness, cancellation, request IDs, ASUS auto-reconnect, rate limiting, scheduled audit retention | No built-in service supervisor |
| Security | 10 | OIDC/PKCE, RBAC, deny-by-default permissions, CSRF, HttpOnly cookies, API identity hash-only storage, MCP OAuth/JWKS, audit trail, rate limits, SSRF guard, KMS release signing with enrolled trust registry | -- |
| Maintainability | 9 | 113 modules, strong tests (102.5% test-to-source ratio), split route/poller/query boundaries, permission matrix, MCP decomposed, parser fuzz, native-dep blind spot documented | `public/js/ai-insights.js` (872 lines) and `src/history.js` (789 lines) remain large |
| Portability | 9 | Cloud-neutral profiles, KMS-signed portable source bundle, offline mode with pre-startup feature policy, offline portability gates, versioned rollback, Node 22/24/26 CI | No supported OCI image/systemd unit |

**Average: 9.1/10.**

---

## 4. Node.js Best Practices

**Adherence: 47/50 (94%).**

- Domain modules, route modules, poller adapters, DB bootstrap, auth middleware, and browser rendering responsibilities are separated.
- Async external calls have timeouts/AbortSignal bounds; backup pruning uses a worker and single-flight job state; ASUS polling coalesces overlapping cycles; MCP requests are concurrency-capped.
- The logger adds a bounded `X-Request-Id` context through `AsyncLocalStorage` without logging query strings.
- Graceful shutdown, readiness, schema migration, config rollback, persistence failure, and permission enforcement tests cover lifecycle boundaries.
- ESLint, V8 coverage, Node 22/24/26, Playwright, parser fuzz, ASH, secret scanning, and dependency audit run as PR gates.
- Authentication logic is separated into dedicated modules following single-responsibility.
- Parser inputs from untrusted devices are fuzzed with shape and time-budget assertions.
- SSRF protection covers operator-configured outbound endpoints against link-local, metadata, multicast, and broadcast addresses.
- Release integrity uses KMS-managed keys with an enrolled trust registry and multi-channel fingerprint publication.
- Native dependency audit blind spots are documented with manual verification steps.

Points are withheld for no default hardware integration CI, no supported process-manager/OCI artifact, and no OpenAPI contract.

---

## 5. SonarQube-Equivalent Gate

| Metric | Result | Rating |
|---|---:|---|
| Reliability | No known critical/high defect | A |
| Security | No open high-signal secret or dependency finding; full RBAC, audit, SSRF protection, and KMS release signing | A |
| Maintainability | No new hotspots; remaining large modules are bounded by tests | A |
| Coverage | 92.59% lines / 88.61% branches / 89.12% functions | A |
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
| `src/mcp-publication-gate.js` | 639 | Publication decision, client release timing, and diagnostics |
| `src/pollers/yamaha.js` | 614 | Stateful SSH lifecycle around adapter parsers |
| `public/js/devices.js` | 593 | Device UI orchestration |
| `mcp-server.js` | 570 | Transport bootstrap and OAuth wiring |
| `src/device-identify.js` | 559 | Device fingerprinting heuristics |
| `src/ai-provider.js` | 559 | Multi-provider AI client with SSRF guard |
| `src/db-migrate.js` | 557 | Schema migrations v1-v12 |

No hotspot grew in this cycle.

---

## Conclusion

The current main line is suitable for its documented self-hosted deployment model with strong multi-user security controls. Automated quality gates are broad, data-changing operations fail closed, AI provider calls are time-bounded and context-capped, full RBAC with deny-by-default permissions is enforced, MCP access is OAuth-protected with rate limiting and audit, and no critical or high issue remains.

This assessment cycle completed the release signing story. The signing key lives in KMS where the private half cannot be exported — eliminating the single-maintainer key-custody risk identified in the v1.7.0 release preparation. The trust registry has tests that recompute every enrolled fingerprint, reject private key material, and hold the single-active-key rule. The fingerprint is published across four independent channels so agreement across sources establishes the trust anchor. The verifier remains unchanged: `openssl` and the committed public key are sufficient.

Production dependency vulnerabilities were resolved promptly (socket.io-parser memory exhaustion within hours of publication), the better-sqlite3 pin was documented with the real glibc blocker rather than the misleading "compiles from source" explanation, and the native-dependency audit blind spot was documented so the gap is managed rather than unknown.

Coverage holds at the A rating with the test-to-source ratio at 102.5%. The CI matrix now covers three Node.js versions including the upcoming LTS 26. No new maintainability hotspot appeared.

The clearest remaining improvements are attaching the `.sig` asset to a GitHub release (reaching OpenSSF band 8), continuous fuzzing via OSS-Fuzz, OpenAPI, and OCI distribution — all requirement-driven enhancements rather than release blockers.
