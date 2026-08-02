# EgressView Code Quality Report

- **Assessment date**: 2026-08-02
- **Baseline**: `fd54a9e` (v1.7.0 release preparation, after PR #157)
- **Version**: 1.7.0
- **Node.js**: >=22 (CI: 22 and 24)
- **Method**: automated tests, V8 coverage, static analysis, dependency/secret scans, browser smoke tests, and manual review

> This report evaluates the current main line. SonarQube and OpenSSF scores are repository-based estimates; neither official scanner was run. No penetration test or fuzzing campaign was performed.

---

## Executive Summary

**Overall grade: A**

No critical or high-severity defect was found. Since the previous report (v1.6.0, PR #140 baseline), seventeen PRs (#141--#157) landed. This cycle shifted from building the security model to operating it: the remote MCP endpoint gained a publication gate, a Cognito compatibility profile, and audit hardening; offline mode, a portability gate, and a signed offline-runtime distribution completed P2-65; and a series of production fixes corrected HSTS, cookie paths, and root/subpath access behind reverse proxies. The database schema stayed at v12 -- no migration was required. The unit test suite grew from 1,670 to 1,775 tests and Playwright smoke tests from 69 to 70 (1 skipped).

The security model established in v1.6.0 is unchanged and now carries operational evidence: 84 of 90 API endpoints require authentication and permission gating, a permission matrix classifies all HTTP routes and MCP tools, deny-by-default middleware rejects unclassified routes, API identities use hash-only storage with independent revocation, and MCP access is protected by RS256 JWT validation via JWKS with per-subject rate limiting and a dedicated append-only audit store.

| Framework | Result | Verdict |
|---|---:|---|
| OWASP ASVS Level 1 | 14/14 areas satisfied or mitigated | Fully compliant |
| OpenSSF Scorecard | ~8.7/10 estimated | Strong repository hygiene |
| ISO/IEC 25010 | 9.1/10 average | High quality |
| Node.js Best Practices | 46/50 | Excellent |
| SonarQube-equivalent gate | Passed; coverage rating B | No high-severity blocker |

## Review Findings

### Changes since previous report (PR #140 baseline)

| PR | Title | Category |
|---:|---|---|
| #141 | P2-60 PR 5: remote MCP publication gate | Security |
| #142 | Quality report refresh for v1.6.0 | Documentation |
| #143 | Dual-era MCP and portable deployment profiles | Portability |
| #144 | Harden private MCP deployment | Security |
| #145 | P2-65 Phase 2: offline mode and self-hosted map assets | Portability |
| #146 | P2-65 Phase 3: offline portability gate | Portability |
| #147 | P2-65 Phase 4: signed offline-runtime distribution | Supply chain |
| #148 | P2-62: consolidate notification settings, prepare release signing | UX / Supply chain |
| #149 | Cognito MCP compatibility profile | Interoperability |
| #150 | Fix MCP publication gate client release policy | Bug fix |
| #151 | Fix HSTS behind trusted reverse proxies | Security |
| #152 | Fix root and subpath web access behind proxies | Bug fix |
| #153 | Fix browser cookie paths for root and subpath access | Bug fix |
| #154 | Fix authenticated browser startup ordering | Bug fix |
| #155 | Harden public MCP audit diagnostics | Security |
| #156 | Audit MCP tools at handler completion | Security |
| #157 | Record a keyed client address in the public MCP audit | Security |

### Key improvements

- **Offline mode**: `EGRESSVIEW_OFFLINE_MODE` resolves an explicit feature policy before startup, so internet-dependent features are refused with a stated reason instead of attempting a call and timing out. Cloud provider SDK clients are never constructed. D3, TopoJSON, and world-atlas are self-hosted at pinned versions, and the CSP admits no external origin.
- **Portability**: offline portability gates cover a Linux host and a generic container, and the release path can now produce a signed portable source distribution with a CycloneDX SBOM. The signing mechanism is in place, but no project key is enrolled yet and v1.7.0 itself ships unsigned; see the Signed-releases row in section 2.
- **MCP audit completeness**: tool calls are audited at handler completion rather than at dispatch, so streaming responses and request-deadline timeouts each produce exactly one accurate outcome row. The audit store records a keyed pseudonym of the client address (`clientIpHash`), which removed the need to enable ALB, WAF, or Cognito-side logging for the same evidence.
- **MCP publication gate**: remote publication is gated on an explicit operator decision, with client release timing decoupled from the gate so a revoked publication does not strand active clients.
- **Reverse proxy correctness**: HSTS is emitted correctly behind a trusted proxy, and browser cookies are scoped to the request base path so the same process can serve a dedicated public host at `/` and a private subpath simultaneously.
- **Interoperability**: a Cognito compatibility profile covers authorization servers that publish no `registration_endpoint`, allowing a pre-registered `client_id` instead of dynamic client registration.

### Open risks

- **Medium, operational**: the four hardware/external-service integration files are not part of the default CI workflow. Unit and browser smoke tests use fixtures and demo mode; Yamaha, ASUS, Slack, and conntrack integration still require an explicit environment.
- **Medium, maintainability**: `mcp-server.js` reached 1,076 lines (from 891) and `src/mcp-publication-gate.js` entered the hotspot list at 868 lines. The MCP surface is now the single largest change surface in the repository, and the OAuth, rate-limit, gate, and audit responsibilities inside it warrant extraction before further growth.
- **Low, ecosystem**: no OpenAPI contract, continuous fuzzing, or OCI image is provided. These remain demand-driven tasks rather than release blockers.

---

## Measured Evidence

| Check | Result |
|---|---|
| Unit tests with coverage | 1,775 passed, 0 failed (422 suites) |
| V8 coverage | 82.74% lines, 78.53% branches, 79.77% functions |
| CI coverage minimums | 70% lines, 75% branches, 65% functions -- passed |
| Playwright browser smoke | 70 passed, 1 skipped |
| ESLint | Passed |
| Frontend HTML insertion audit | 0 `innerHTML` / `insertAdjacentHTML` assignments |
| Production dependency audit | 0 vulnerabilities |
| Secret scan | Passed; no high-signal secrets or environment-specific LAN IPs |
| ASH (Automated Security Helper) | 0 actionable findings |
| GitHub Actions SHA pinning | 19/19 pinned, 0 unpinned |
| GitHub CI on PR #157 | Node 22/24, release safety, ASH, browser smoke, and Pages build passed |

### Codebase Metrics

Values in parentheses are the v1.6.0 figures where they changed.

| Metric | Value |
|---|---:|
| Source lines (`server`, `mcp`, `src`, `public/js`) | 30,984 (29,165) |
| Test lines (unit, integration, smoke) | 29,347 (26,929) |
| Test-to-source ratio | 94.7% (92.3%) |
| Unit test files | 128 (122) |
| Integration test files | 4 |
| Browser smoke file | 1 (1,740 lines) |
| Source modules under `src/` | 107 (104) |
| Poller modules | 15 |
| Route modules | 17 |
| HTTP endpoints | 92 (90 API + 2 health) |
| Authenticated/permission-gated API endpoints | 84/90 |
| Public API endpoints | login, admin-verify, auth-status, auth-methods, oidc-start, oidc-callback |
| Public operational endpoints | `/healthz` and `/readyz`, fixed minimal responses |
| Endpoint-bearing route modules using strict Zod | 16/17 (auth.js has 0 endpoints) |
| Permission matrix entries | 93 (HTTP routes + MCP tools fully classified) |
| Defined permissions | 7 |
| Roles | 3 (viewer, operator, admin) |
| Production dependencies | 13 |
| Documentation files under `docs/` | 36 (34) |
| Parameterized SQL preparation sites | 152 (150) |
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
| Access control | Pass | 84/90 API endpoints gated by `enforceApiPermissions`; deny-by-default permission boundary; WebSocket handshake shares the same boundary; 93-entry permission matrix |
| Input validation | Pass | 64 KB JSON limit, strict Zod on 16/17 endpoint modules, unknown-key rejection, bounded strings/ranges |
| Cryptography | Pass | `randomBytes`/UUID for secrets and correlation, SHA-256 for session/TOFU/principalHash, timing-safe equality, RS256 JWT verification for MCP |
| Error handling | Pass | Generic 500 responses, no stack exposure, request-correlated server logs |
| Data protection | Pass | Config, backup, and TLS key mode 0600; secrets excluded from public config and logs; API identity hash-only storage |
| Communications | Pass | HTTPS/HSTS supported; OIDC callback enforces secure redirect; MCP OAuth via HTTPS JWKS |
| Malicious code | Pass | No eval; frontend HTML insertion audit is enforced in CI |
| File handling | Pass | Bounded uploads, validated backup names, traversal checks, fail-closed restore/migration |
| API security | Pass | Method-specific routes, strict schemas, response-size/time bounds, authenticated exports, MCP rate limiting |
| Configuration | Pass | No hard-coded credentials, example configuration, secret scan, production demo-mode refusal |
| Business logic | Pass | HttpOnly cookies with CSRF protection; explicit permission tokens for API identities; deny-by-default enforcement |
| Audit and logging | Pass | Append-only audit_events with pseudonymous actorHash/principalHash, 180-day retention, MCP-separate audit store |

The health endpoints are intentionally unauthenticated but return only fixed liveness/readiness state with `no-store`; they expose no router addresses, credentials, or counts.

---

## 2. OpenSSF Scorecard (Estimated)

**Estimated score: 8.7/10.**

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
| CI tests | 9 | Unit/coverage and browser smoke on PRs; hardware integration is explicit, not default |
| Maintained | 10 | Active release and PR history through PR #157 (153 merged PRs) |
| Code review | 8 | PR workflow with required checks; RBAC and permission matrix enforce review standards |
| Fuzzing | 0 | No continuous fuzzing |
| Signed releases | 2 | The tooling and a written key procedure exist, and the release path can produce a signed portable source distribution with a CycloneDX SBOM. **No release is actually signed.** `release-signing/trusted-fingerprints.json` holds no enrolled key and v1.7.0 ships unsigned by decision, so no GitHub release carries a signature asset. Credit here is for the mechanism only, not for a signed artifact. The check inspects release assets for `*.sig`, `*.asc`, `*.minisig`, `*.sign`, `*.sigstore`, or `*.intoto.jsonl` -- not git tag signatures -- and the build already emits `<artifact>.sig`, so enrolling any key and attaching that asset reaches the signature band (8). The remaining 2 points require a SLSA provenance file (`*.intoto.jsonl`) on each release, which depends on a provenance-generating build workflow rather than on key custody. |

---

## 3. ISO/IEC 25010

| Characteristic | Score | Strengths | Remaining gap |
|---|---:|---|---|
| Functional suitability | 9 | Multi-router collection, AI insights with notifications, threat investigation, exports, MCP with OAuth | No OpenAPI contract |
| Performance efficiency | 9 | WAL, batching, bounded summaries, caches, worker-isolated backup, MCP concurrency cap | Heavy backup checks can still create short host-level latency spikes |
| Compatibility | 9 | Node 22/24, JA/EN, Yamaha/Cisco/ASUS/conntrack paths, Cognito compatibility profile for authorization servers without dynamic client registration, correct operation at `/` and at a subpath behind a proxy | Hardware-specific verification remains fixture-dependent in CI |
| Usability | 9 | Responsive UI, setup guides, auto-detection, health diagnostics, role display, notification settings confirmation | No one-click deployment |
| Reliability | 9 | Fail-closed migration/restore/config/notes, health/readiness, cancellation, request IDs, ASUS auto-reconnect, rate limiting | No built-in service supervisor |
| Security | 10 | OIDC/PKCE, RBAC, deny-by-default permissions, CSRF, HttpOnly cookies, API identity hash-only storage, MCP OAuth/JWKS, audit trail, rate limits | -- |
| Maintainability | 9 | 107 modules, strong tests (94.7% test-to-source ratio), split route/poller/query boundaries, permission matrix | The MCP surface grew faster than it was decomposed; `mcp-server.js` is now 1,076 lines |
| Portability | 9 | Cloud-neutral profiles, signed portable source bundle, offline mode with a pre-startup feature policy, offline portability gates for host and container, versioned rollback | No supported OCI image/systemd unit |

**Average: 9.1/10.**

---

## 4. Node.js Best Practices

**Adherence: 46/50 (92%).**

- Domain modules, route modules, poller adapters, DB bootstrap, auth middleware, and browser rendering responsibilities are separated.
- Async external calls have timeouts/AbortSignal bounds; backup pruning uses a worker and single-flight job state; ASUS polling coalesces overlapping cycles; MCP requests are concurrency-capped.
- The logger adds a bounded `X-Request-Id` context through `AsyncLocalStorage` without logging query strings.
- Graceful shutdown, readiness, schema migration, config rollback, persistence failure, and permission enforcement tests cover lifecycle boundaries.
- ESLint, V8 coverage, Node 22/24, Playwright, ASH, secret scanning, and dependency audit run as PR gates.
- Authentication logic is separated into dedicated modules (auth-middleware, auth-cookies, auth-audit, oidc-google) following single-responsibility.

Points are withheld for no default hardware integration CI, no supported process-manager/OCI artifact, no OpenAPI contract, and no continuous fuzzing.

---

## 5. SonarQube-Equivalent Gate

| Metric | Result | Rating |
|---|---:|---|
| Reliability | No known critical/high defect | A |
| Security | No open high-signal secret or dependency finding; full RBAC and audit | A |
| Maintainability | Large modules are known but bounded by tests and extracted helpers | A |
| Coverage | 82.74% lines / 78.53% branches / 79.77% functions | B |
| Duplication | No material new duplication identified in manual/static review | A (estimated) |

**Quality gate: passed.**

### Primary Maintainability Hotspots

| File | Lines | Review note |
|---|---:|---|
| `mcp-server.js` | 1,076 | Largest file in the repository. OAuth, rate limiting, deadlines, and audit now share one module; extraction is overdue |
| `public/js/ai-insights.js` | 872 | Notification and insight rendering share one view module |
| `src/mcp-publication-gate.js` | 868 | New in this cycle; publication decision, client release timing, and diagnostics in one module |
| `src/history.js` | 789 | Store orchestration remains large after query/cache/bootstrap extraction |
| `server.js` | 725 | Bootstrap and dependency wiring |
| `public/js/log.js` | 715 | Pagination, filtering, and rendering share one view module |
| `public/js/graph.js` | 675 | Orchestrates extracted graph helpers/panels/renderer |
| `src/devices.js` | 665 | Device identity, persistence, and merge lifecycle |
| `src/pollers/cisco.js` | 645 | Stateful SSH lifecycle around extracted parser/handshake modules |
| `src/pollers/yamaha.js` | 614 | Stateful SSH lifecycle around adapter parsers |
| `public/js/devices.js` | 593 | Device UI orchestration |
| `src/db-migrate.js` | 557 | Schema migrations v1-v12 |

These are refactoring candidates, not current release blockers. Changes should remain incremental and behavior-preserving.

---

## Conclusion

The current main line is suitable for its documented self-hosted deployment model with strong multi-user security controls. Automated quality gates are broad, data-changing operations fail closed, AI provider calls are time-bounded and context-capped, full RBAC with deny-by-default permissions is enforced, MCP access is OAuth-protected with rate limiting and audit, and no critical or high issue remains.

Where v1.6.0 introduced the security model, v1.7.0 exercised it against a real internet-exposed MCP deployment and closed the gaps that only operation reveals: audit rows that were written twice or not at all, cookie paths that broke when the same process served both a public host and a private subpath, HSTS suppressed behind a trusted proxy, and an authorization server that publishes no `registration_endpoint`. Offline mode and the signed portable distribution completed the portability track. Coverage rose from 81.23% to 82.74% lines while the source grew by 1,819 lines, so testing kept pace with the code.

The clearest remaining debt is structural rather than behavioural: the MCP surface (`mcp-server.js` at 1,076 lines plus an 868-line publication gate) is now the largest concentration of logic in the repository and should be decomposed before the next feature lands on it. OpenAPI, continuous fuzzing, GPG-signed tags, and OCI distribution remain requirement-driven enhancements.
