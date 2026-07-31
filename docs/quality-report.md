# EgressView Code Quality Report

- **Assessment date**: 2026-07-28
- **Baseline**: `fea7843` (main after PR #140)
- **Version**: 1.6.0
- **Node.js**: >=22 (CI: 22 and 24)
- **Method**: automated tests, V8 coverage, static analysis, dependency/secret scans, browser smoke tests, and manual review

> This report evaluates the current main line. SonarQube and OpenSSF scores are repository-based estimates; neither official scanner was run. No penetration test or fuzzing campaign was performed.

---

## Executive Summary

**Overall grade: A**

No critical or high-severity defect was found. Since the previous report (PR #121 baseline), seventeen PRs (#124--#140) landed, delivering AI event notifications, full authentication hardening (Google OIDC with PKCE, HttpOnly cookies, CSRF protection), a deny-by-default permission boundary with three roles and seven permissions, scoped API identities, browser session RBAC, MCP OAuth protection with RFC 9728 metadata, rate limiting, and audit trails. The database schema advanced from v7 to v12. The unit test suite grew from 1,477 to 1,670 tests, and Playwright smoke tests grew from 66 to 69.

The codebase now enforces a strict security posture suitable for both private-network and authenticated multi-user deployments: 84 of 90 API endpoints require authentication and permission gating, a permission matrix classifies all HTTP routes and MCP tools, deny-by-default middleware rejects unclassified routes, API identities use hash-only storage with independent revocation, and MCP access is protected by RS256 JWT validation via JWKS with per-subject rate limiting.

| Framework | Result | Verdict |
|---|---:|---|
| OWASP ASVS Level 1 | 14/14 areas satisfied or mitigated | Fully compliant |
| OpenSSF Scorecard | ~8.6/10 estimated | Strong repository hygiene |
| ISO/IEC 25010 | 8.8/10 average | High quality |
| Node.js Best Practices | 46/50 | Excellent |
| SonarQube-equivalent gate | Passed; coverage rating B | No high-severity blocker |

## Review Findings

### Changes since previous report (PR #121 baseline)

| PR | Title | Category |
|---:|---|---|
| #125 | AI event notifications | Feature |
| #126 | Move Slack settings to General tab | UX |
| #127 | Confirm AI notification settings before saving | UX |
| #128 | Authentication hardening + audit logging (OIDC, PKCE, HttpOnly cookies, CSRF, rate limits, schema v9) | Security |
| #129 | Fix default database path for auth audit | Bug fix |
| #130 | OIDC domain allowlist warning + v1.6.0 release (schema stays v9) | Security |
| #131 | Deny-by-default permission boundary (7 permissions, permission-matrix) | Security |
| #132 | OAuth authorization server evaluation docs | Documentation |
| #133 | Scoped API identities (schema v10) | Security |
| #134 | Browser session RBAC (viewer/operator/admin, schema v11) | Security |
| #135 | Stable audit principalHash (schema v12) | Security |
| #136 | Session role display in settings | UX |
| #137 | OAuth protection for remote MCP (JWKS, RFC 9728) | Security |
| #138 | Dependabot actions (checkout 7.0.1, setup-python 7.0.0) | Dependency |
| #139 | MCP scope-to-service-identity mapping | Security |
| #140 | MCP audit + rate limiting (rate limits, audit trail, concurrency cap) | Security |

### Key improvements

- **Authentication**: Google OIDC with PKCE flow, HttpOnly session cookies, CSRF token protection, per-IP lockout, and a local recovery login (TTY CLI) for account recovery. Versioned KDF migration ensures password hash upgrades without downtime.
- **Authorization**: deny-by-default permission boundary with 7 defined permissions (network.read, notes.write, ai.run, settings.write, backup.restore, auth.admin, audit.read) and 3 nested roles (viewer, operator, admin). The permission matrix covers 93 entries across HTTP routes and MCP tools; unclassified routes are rejected at startup.
- **API identities**: scoped, expiring tokens with hash-only storage and independent revocation. Each identity is bound to a specific permission set.
- **Audit**: append-only audit_events table with pseudonymous actorHash and principalHash, 180-day retention, and a dedicated audit.read permission.
- **MCP OAuth**: RFC 9728 protected-resource metadata discovery, RS256 JWT validation via JWKS endpoint, scope-to-service-identity mapping, rate limiting (60/min global, 30/min per subject/client, 4 concurrent), and a separate MCP audit store.
- **Session RBAC**: browser sessions carry a role (viewer/operator/admin) with the role displayed in settings. Permission enforcement applies uniformly to both session and API-identity access.

### Open risks

- **Medium, operational**: the four hardware/external-service integration files are not part of the default CI workflow. Unit and browser smoke tests use fixtures and demo mode; Yamaha, ASUS, Slack, and conntrack integration still require an explicit environment.
- **Low, maintainability**: `mcp-server.js` (891 lines), `src/history.js` (789 lines), `public/js/ai-insights.js` (783 lines), `public/js/log.js` (715 lines), and `server.js` (690 lines) are the largest change surfaces. Critical paths are well-tested, but continued extraction of helpers is recommended as these modules grow.
- **Low, ecosystem**: no OpenAPI contract, signed release artifacts, continuous fuzzing, or OCI image is provided. These remain demand-driven tasks rather than release blockers.

---

## Measured Evidence

| Check | Result |
|---|---|
| Unit tests with coverage | 1,670 passed, 0 failed |
| V8 coverage | 81.23% lines, 78.27% branches, 77.74% functions |
| CI coverage minimums | 70% lines, 75% branches, 65% functions -- passed |
| Playwright browser smoke | 69 passed |
| ESLint | Passed |
| Frontend HTML insertion audit | 0 `innerHTML` / `insertAdjacentHTML` assignments |
| Production dependency audit | 0 vulnerabilities |
| Secret scan | Passed; no high-signal secrets or environment-specific LAN IPs |
| ASH (Automated Security Helper) | 0 actionable findings |
| GitHub Actions SHA pinning | 15/15 pinned, 0 unpinned |
| GitHub CI on PR #140 | Node 22/24, release safety, ASH, browser smoke, and Pages build passed |

### Codebase Metrics

| Metric | Value |
|---|---:|
| Source lines (`server`, `mcp`, `src`, `public/js`) | 29,165 |
| Test lines (unit, integration, smoke) | 26,929 |
| Test-to-source ratio | 92.3% |
| Unit test files | 122 |
| Integration test files | 4 |
| Browser smoke file | 1 (1,681 lines) |
| Source modules under `src/` | 104 |
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
| Parameterized SQL preparation sites | 150 |
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

**Estimated score: 8.6/10.**

| Check | Score | Evidence |
|---|---:|---|
| Pinned dependencies | 10 | All 15 GitHub Actions pinned to full commit SHA |
| Token permissions | 10 | Read-only default; Pages widens only the permissions it needs |
| Dangerous workflow | 10 | No `pull_request_target` |
| Binary artifacts | 10 | No committed binaries |
| Security policy | 10 | `SECURITY.md` and private vulnerability reporting |
| License | 10 | AGPL-3.0-only |
| SAST | 10 | ASH, secret scan, ESLint, frontend insertion audit, npm audit |
| Vulnerabilities | 10 | Production `npm audit` in CI; 0 findings in this review |
| Dependency updates | 10 | Weekly Dependabot for npm and Actions with a 7-day cooldown |
| CI tests | 9 | Unit/coverage and browser smoke on PRs; hardware integration is explicit, not default |
| Maintained | 10 | Active release and PR history through PR #140 |
| Code review | 8 | PR workflow with required checks; RBAC and permission matrix enforce review standards |
| Fuzzing | 0 | No continuous fuzzing |
| Signed releases | 0 | No GPG/Sigstore release signing |

---

## 3. ISO/IEC 25010

| Characteristic | Score | Strengths | Remaining gap |
|---|---:|---|---|
| Functional suitability | 9 | Multi-router collection, AI insights with notifications, threat investigation, exports, MCP with OAuth | No OpenAPI contract |
| Performance efficiency | 9 | WAL, batching, bounded summaries, caches, worker-isolated backup, MCP concurrency cap | Heavy backup checks can still create short host-level latency spikes |
| Compatibility | 8 | Node 22/24, JA/EN, Yamaha/Cisco/ASUS/conntrack paths | Hardware-specific verification remains fixture-dependent in CI |
| Usability | 9 | Responsive UI, setup guides, auto-detection, health diagnostics, role display, notification settings confirmation | No one-click deployment |
| Reliability | 9 | Fail-closed migration/restore/config/notes, health/readiness, cancellation, request IDs, ASUS auto-reconnect, rate limiting | No built-in service supervisor |
| Security | 10 | OIDC/PKCE, RBAC, deny-by-default permissions, CSRF, HttpOnly cookies, API identity hash-only storage, MCP OAuth/JWKS, audit trail, rate limits | -- |
| Maintainability | 9 | 104 modules, strong tests, split route/poller/query boundaries, permission matrix | Several 690-891-line orchestration modules remain |
| Portability | 9 | Cloud-neutral profiles, signed portable source bundle, offline runtime gate, versioned rollback | No supported OCI image/systemd unit |

**Average: 9.0/10.**

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
| Coverage | 81.23% lines / 78.27% branches / 77.74% functions | B |
| Duplication | No material new duplication identified in manual/static review | A (estimated) |

**Quality gate: passed.**

### Primary Maintainability Hotspots

| File | Lines | Review note |
|---|---:|---|
| `mcp-server.js` | 891 | Grew significantly with OAuth, rate-limit, and audit responsibilities |
| `src/history.js` | 789 | Store orchestration remains large after query/cache/bootstrap extraction |
| `public/js/ai-insights.js` | 783 | Notification and insight rendering share one view module |
| `public/js/log.js` | 715 | Pagination, filtering, and rendering share one view module |
| `server.js` | 690 | Bootstrap and dependency wiring |
| `public/js/graph.js` | 675 | Orchestrates extracted graph helpers/panels/renderer |
| `src/devices.js` | 665 | Device identity, persistence, and merge lifecycle |
| `src/pollers/cisco.js` | 645 | Stateful SSH lifecycle around extracted parser/handshake modules |
| `src/pollers/yamaha.js` | 614 | Stateful SSH lifecycle around adapter parsers |
| `public/js/devices.js` | 593 | Device UI orchestration |
| `src/db-migrate.js` | 557 | Schema migrations v1-v12 |

These are refactoring candidates, not current release blockers. Changes should remain incremental and behavior-preserving.

---

## Conclusion

The current main line is suitable for its documented self-hosted deployment model with strong multi-user security controls. Automated quality gates are broad, data-changing operations fail closed, AI provider calls are time-bounded and context-capped, full RBAC with deny-by-default permissions is enforced, MCP access is OAuth-protected with rate limiting and audit, and no critical or high issue remains. Since the previous report, the security posture has advanced substantially with OIDC authentication, session RBAC, scoped API identities, and comprehensive audit logging, while test coverage and count have grown proportionally. OpenAPI, continuous fuzzing, and OCI distribution remain requirement-driven enhancements.
