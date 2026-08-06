# EgressView Code Quality Report

- **Assessment date**: 2026-08-06
- **Baseline**: `30e7bce` (after PR #182, v1.8.0 released and signed)
- **Version**: 1.8.0
- **Node.js**: >=22 (CI: 22, 24, and 26)
- **Method**: automated tests, V8 coverage, static analysis, dependency/secret scans, browser smoke tests, parser fuzzing, and manual review

> This report evaluates the current main line. SonarQube and OpenSSF scores are repository-based estimates; neither official scanner was run. No penetration test was performed.

---

## Executive Summary

**Overall grade: A**

No critical or high-severity defect was found. Since the previous report (PR #177 baseline), five PRs (#178--#182) landed and **v1.8.0 shipped as the project's first signed release** — the portable distribution now carries a KMS Ed25519 signature as a release asset, which is what the OpenSSF Signed-Releases check actually inspects. Alongside it, `better-sqlite3` moved to 13.0.3 (SQLite 3.53.4) with dependency install scripts disabled, a Node 26.7.0 regression in the route test harness was fixed, and a read-only public demo was added.

**Two figures in the previous report were wrong and are corrected here.** Coverage was given as 92.59% lines, which is a `src/`-only measurement, while the CI gate it was printed beside (83/79/80) measures the whole tree — so the number a reader would check against the gate was not the number the gate checks. Both scopes are now stated separately. The permission matrix was given as 107 entries (96 HTTP routes) when the matrix held 105 (94 HTTP routes); it still holds 105. Neither error changes a verdict, but a quality report whose numbers cannot be reproduced from the repository is not doing its job.

Measured coverage is 84.08% lines, 80.12% branches, and 80.80% functions across the whole tree, against the CI gate of 83/79/80 — a deliberately narrow margin, set by P2-69 to track reality rather than flatter it. Restricted to `src/`, the same run reports 93.26/88.78/89.38. The test-to-source ratio is 103.1%. The security model is unchanged; the permission matrix holds at 105 entries (94 HTTP routes + 11 MCP tools).

| Framework | Result | Verdict |
|---|---:|---|
| OWASP ASVS Level 1 | 14/14 areas satisfied or mitigated | Fully compliant |
| OpenSSF Scorecard | ~9.4/10 estimated | Signed-Releases now satisfied by a published signed asset |
| ISO/IEC 25010 | 9.1/10 average | High quality |
| Node.js Best Practices | 47/50 | Excellent |
| SonarQube-equivalent gate | Passed; coverage rating A | No high-severity blocker |

## Review Findings

### Changes since previous report (PR #177 baseline)

| PR | Title | Category |
|---:|---|---|
| #178 | Refresh quality report after PR #177 | Documentation |
| #179 | Upgrade better-sqlite3 to 13.0.3 and disable install scripts | Dependencies |
| #180 | Dependabot: bump the minor-and-patch group (4 updates) | Dependencies |
| #181 | Prepare v1.8.0 | Release |
| #182 | Add Fly.io demo deployment with read-only protection | Feature |

### Key improvements

- **First signed release (v1.8.0)**: the release was built and signed with the enrolled KMS key and published with four assets — archive, checksum, detached signature, and public key. Verification was re-run against the *downloaded* assets rather than the local build: checksum matched, `openssl pkeyutl -verify` succeeded, and the public key's fingerprint matched the trust registry. Tamper detection was exercised three ways (modified archive, modified checksum file, wrong key) and each exited non-zero. This matters because the verifier reports failure by exit code; a check that only reads the message would pass a tampered artifact.
- **better-sqlite3 13.0.3 (PR #179)**: the 1.7.0 pin is lifted. The original blocker was resolved upstream — the arm64 prebuild now links against `GLIBC_2.34` rather than 2.38, which the aarch64 deployment host provides. A second, unrelated blocker surfaced during the upgrade: 13.x ships a `binding.gyp` with no install script, and npm reads a bare `binding.gyp` as an implicit `node-gyp rebuild`, so it compiled SQLite from source on every install and failed outright without Python and a C++ toolchain. Upstream closed that report by adding `"gypfile": false`, a field npm 8+ ignores, so it is still present. Disabling install scripts resolves it and stops every dependency from running code at install time. `min-release-age=7` was added so a freshly published version is not resolved, matching the Dependabot cooldown at install time.
- **Node 26.7.0 test harness fix (PR #181)**: twelve route test files stand a plain `Readable` in for an HTTP request. Express grafts `http.IncomingMessage.prototype` onto it, and Node 26.7.0 made `_destroy` detach an abort listener whose internal fields are undefined on such an object, killing about twenty tests per file. CI resolves `node-version: 26` to whatever is current, so this appeared without any change on our side. Product code is unaffected — it runs behind a real `http.Server`.
- **Read-only public demo (PR #182)**: the demo enforces write protection through a separate `DEMO_READ_ONLY` flag. All 53 state-changing routes live under `/api`, which is where the middleware mounts; the only two public write routes are the two on its allowlist; and Socket.IO registers no inbound event handlers, so there is no WebSocket bypass. The middleware fails closed — anything not matching the allowlist exactly is rejected.

### Open risks

- **Low, operational**: the four hardware/external-service integration files are not part of the default CI workflow.
- **Low, ecosystem**: no OpenAPI contract or OCI image is provided.
- **Low, maintainability**: `public/js/ai-insights.js` (872 lines) and `src/history.js` (789 lines) remain the largest non-poller modules. Neither grew in this cycle.
- **Low, supply chain**: `npm audit` cannot see SQLite CVEs inside the `better-sqlite3` amalgamation. The blind spot is documented with manual verification steps. The bundled SQLite is 3.53.4, which is upstream's current release.
- **Low, install surface**: with install scripts disabled, installation now depends on a bundled prebuilt binary existing for the host. better-sqlite3 covers darwin, linux, linuxmusl, and win32 on arm64 and x64; anything outside that needs a toolchain and `--ignore-scripts=false`. Documented in `CONTRIBUTING.md` and both distribution guides.
- **Low, demo exposure**: the public demo's admin token is committed in `fly.toml` by design, and the instance is safe only while `DEMO_READ_ONLY` is set. Removing that one flag would turn a public instance into a writable one with a published token.

---

## Measured Evidence

| Check | Result |
|---|---|
| Unit tests with coverage | 1,966 passed, 0 failed (464 suites) |
| V8 coverage, whole tree | 84.08% lines, 80.12% branches, 80.80% functions |
| V8 coverage, `src/` only | 93.26% lines, 88.78% branches, 89.38% functions |
| CI coverage minimums | 83% lines, 79% branches, 80% functions -- passed |
| Parser fuzz tests | 30 passed (3 suites) |
| Playwright browser smoke | 70 passed, 1 skipped |
| ESLint | Passed |
| Frontend HTML insertion audit | 0 `innerHTML` / `insertAdjacentHTML` assignments |
| Production dependency audit | 0 vulnerabilities |
| Secret scan | Passed; no high-signal secrets or environment-specific LAN IPs |
| ASH (Automated Security Helper) | 0 actionable findings |
| GitHub Actions SHA pinning | 19/19 pinned, 0 unpinned |
| Published release verification | Downloaded assets verified: checksum OK, signature OK, fingerprint matches the registry; three tamper cases each exit non-zero |

### Codebase Metrics

| Metric | Value |
|---|---:|
| Source lines (`server`, `mcp`, `src`, `public/js`) | 31,482 (31,435) |
| Test lines (unit, integration, smoke, fuzz, portability) | 32,450 (32,214) |
| Test-to-source ratio | 103.1% (102.5%) |
| Unit test files | 141 (140) |
| Integration test files | 4 |
| Fuzz test files | 3 |
| Browser smoke file | 1 (1,740 lines) |
| Portability test file | 1 |
| Source modules under `src/` | 114 (113) |
| Poller modules | 15 |
| Route modules | 18 |
| HTTP routes in permission matrix | 94 |
| MCP tools | 11 |
| Permission matrix entries | 105 |
| Route access split | 85 permission-gated, 1 authenticated, 8 public |
| Public API endpoints | login, admin-verify, auth-status, auth-methods, oidc-start, oidc-callback |
| Public operational endpoints | `/healthz` and `/readyz`, fixed minimal responses |
| State-changing routes | 53, all under `/api` |
| Defined permissions | 7 |
| Roles | 3 (viewer, operator, admin) |
| Production dependencies | 13 |
| Documentation files under `docs/` | 37 (36) |
| Parameterized SQL preparation sites | 152 |
| Server-side `var` | 0 |
| `eval` / `new Function` | 0 |
| TODO/FIXME/HACK markers | 0 |
| `innerHTML` / `insertAdjacentHTML` | 0 |
| CI Node.js versions | 22, 24, 26 |
| Release signing key | 1 active (KMS Ed25519), used to sign v1.8.0 |

Values in parentheses are the previous report's figures where they changed. The permission matrix line is not a change: the previous report's 107 was a miscount of the same 105 entries.

---

## 1. OWASP ASVS Level 1

**Verdict: fully compliant (14/14 areas satisfied or mitigated).**

| Area | Status | Evidence |
|---|---|---|
| Authentication | Pass | scrypt with versioned KDF migration, timing-safe comparisons, 256-bit session tokens, delayed failures, per-IP lockout, Google OIDC with PKCE |
| Session management | Pass | Hashed tokens, sliding expiry, revocation, password-change handling, periodic pruning, role-bound sessions |
| Access control | Pass | Of 94 HTTP routes, 85 are permission-gated, 1 is authentication-only, and 8 are public (2 of them `/healthz` and `/readyz`). Deny-by-default boundary, applied identically to the WebSocket handshake. Permission matrix holds 105 entries |
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

**Estimated score: 9.4/10.**

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
| Maintained | 10 | Active release and PR history through PR #182 (177 merged PRs) |
| Code review | 8 | PR workflow with required checks; RBAC and permission matrix enforce review standards |
| Fuzzing | 5 | Parser fuzzing covers 19 functions that read untrusted device input, with time-budget and shape assertions; dependency-free, runs in CI. Not yet a continuous-fuzzing service |
| Signed releases | 8 | **v1.8.0 is published with a detached signature asset**, which is what this check inspects — it reads release assets by extension (`.sig`, `.asc`, `.minisig`, `.sigstore`, `.intoto.jsonl`), not git tag signatures. The KMS Ed25519 key is enrolled with multi-channel fingerprint publication and trust-registry tests. The remaining 2 points require SLSA provenance. |

---

## 3. ISO/IEC 25010

| Characteristic | Score | Strengths | Remaining gap |
|---|---:|---|---|
| Functional suitability | 9 | Multi-router collection, AI insights with notifications, threat investigation, exports, MCP with OAuth, per-detection notification granularity | No OpenAPI contract |
| Performance efficiency | 9 | WAL, batching, bounded summaries, caches, worker-isolated backup, MCP concurrency cap | Heavy backup checks can still create short host-level latency spikes |
| Compatibility | 9 | Node 22/24/26, JA/EN, Yamaha/Cisco/ASUS/conntrack paths, Cognito compatibility profile, correct operation at `/` and at a subpath behind a proxy | Hardware-specific verification remains fixture-dependent in CI |
| Usability | 9 | Responsive UI, setup guides, auto-detection, health diagnostics, role display, per-detection notification switches, public read-only demo | Router-side setup (SSH user, syslog forwarding) is still the real onboarding cost |
| Reliability | 9 | Fail-closed migration/restore/config/notes, health/readiness, cancellation, request IDs, ASUS auto-reconnect, rate limiting, scheduled audit retention | No built-in service supervisor |
| Security | 10 | OIDC/PKCE, RBAC, deny-by-default permissions, CSRF, HttpOnly cookies, API identity hash-only storage, MCP OAuth/JWKS, audit trail, rate limits, SSRF guard, a signed and independently re-verified release, install scripts disabled | -- |
| Maintainability | 9 | 114 modules, strong tests (103.1% test-to-source ratio), split route/poller/query boundaries, permission matrix, MCP decomposed, parser fuzz, native-dep blind spot documented | `public/js/ai-insights.js` (872 lines) and `src/history.js` (789 lines) remain large |
| Portability | 9 | Cloud-neutral profiles, a published KMS-signed portable source bundle, offline mode with pre-startup feature policy, offline portability gates, versioned rollback, Node 22/24/26 CI | No supported OCI image/systemd unit |

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
- Release integrity uses KMS-managed keys with an enrolled trust registry and multi-channel fingerprint publication, and v1.8.0 was verified from its published assets rather than the local build.
- Dependency install scripts are disabled, so no dependency runs code during installation and native modules come from bundled prebuilt binaries.
- Native dependency audit blind spots are documented with manual verification steps.

Points are withheld for no default hardware integration CI, no supported process-manager/OCI artifact, and no OpenAPI contract.

---

## 5. SonarQube-Equivalent Gate

| Metric | Result | Rating |
|---|---:|---|
| Reliability | No known critical/high defect | A |
| Security | No open high-signal secret or dependency finding; full RBAC, audit, SSRF protection, and KMS release signing | A |
| Maintainability | No new hotspots; remaining large modules are bounded by tests | A |
| Coverage | 84.08% lines / 80.12% branches / 80.80% functions whole tree; 93.26 / 88.78 / 89.38 for `src/` | A |
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

This cycle closed the release-signing story in the only way that counts: v1.8.0 was signed and published, and then verified from the downloaded assets rather than the local build. The failure paths were exercised as well — a modified archive, a modified checksum file, and a wrong key each exit non-zero, which is the property the verifier actually depends on, since it reports failure by exit status rather than by message.

Two supply-chain positions improved in ways that are easy to understate. Disabling install scripts removes arbitrary code execution during installation for every dependency, not just the one that forced the change; `min-release-age=7` extends the existing Dependabot cooldown to install-time resolution. Both were adopted because a native-module upgrade could not otherwise be deployed, which is a reminder that the useful review question for a dependency major is not whether CI is green but whether the artifact can run on the host and install without a toolchain.

The Node 26.7.0 breakage is worth recording as a process observation rather than a defect. Nothing in the repository changed; CI resolves `node-version: 26` to whatever is current, and a patch release altered internal HTTP teardown in a way that a fabricated request object could not survive. Reproducing it required matching the exact patch version in a container, because the locally installed 26.5.0 passed.

Coverage holds at the A rating with the whole-tree figures now stated against the gate they are compared to. No new maintainability hotspot appeared. The clearest remaining improvements are SLSA provenance (the last 2 points of Signed-Releases), continuous fuzzing via OSS-Fuzz, an OpenAPI contract, and OCI distribution — all requirement-driven enhancements rather than release blockers.
