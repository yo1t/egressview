# Authentication and reverse proxy

> [Japanese / 日本語](authentication.ja.md)

EgressView always keeps one emergency local administrator. Google OIDC is an optional additional login method and cannot disable local recovery.

**What you get from this page:** a login you cannot lock yourself out of, and the settings that make it safe to reach EgressView from somewhere other than the machine it runs on.

**You can skip the reverse proxy and HTTPS sections** if you only ever open EgressView on the same machine or across a LAN you trust. The password still applies; nothing is unprotected by default.

## Turning on HTTPS

By default EgressView serves plain HTTP, which is fine on loopback and acceptable on a LAN you trust. It stops being acceptable the moment the login password travels anywhere you do not control — **enable HTTPS before using EgressView from another device, and treat it as required for anything reachable from the internet.**

Add this to `.egressview.json` and restart:

```json
"https": { "enabled": true }
```

A self-signed certificate is generated for you (`.egressview-cert.pem` / `.egressview-key.pem`, ten-year validity) using the `openssl` CLI. Your browser will warn once, because nothing has vouched for that certificate; accepting it is the expected step here, not a workaround.

To use a certificate of your own instead:

```json
"https": { "enabled": true, "certPath": "/path/to/cert.pem", "keyPath": "/path/to/key.pem" }
```

## Local administrator

- New passwords require at least 14 characters and are stored as a versioned scrypt record.
- Browser tokens are hashed in SQLite and delivered in HttpOnly/SameSite cookies. Mutating cookie-authenticated requests also require the CSRF cookie value in `X-CSRF-Token`.
- Run `npm run auth:reset` from an interactive SSH/console TTY if the password is lost. This revokes every browser session. Add `-- --regenerate-api-token` to rotate the automation token too.
- Initial or recovered secrets are never written to `server.log`. Non-interactive first startup writes one-time mode-`0600` files next to `.egressview.json`.

## Google OIDC

Create a Google OAuth 2.0 Web application and set its authorized redirect URI to:

```text
https://YOUR_EGRESSVIEW_ORIGIN/api/auth/oidc/callback
```

In Settings → General → Authentication & Audit, enter the client ID, client secret, and at least one allowed email address or domain. EgressView validates Authorization Code + PKCE, state, nonce, the Google JWKS signature, issuer, audience, expiry, verified email, and the allowlist before creating a normal revocable session.

### Browser roles

Roles are assigned on the server from the verified login path:

| Login | Role | Access |
|---|---|---|
| Local administrator | `admin` | All settings, credentials, authentication, backups and operational features |
| Google account matched by an explicit email entry | `operator` | Network data and device-note updates |
| Google account matched only by a domain entry | `viewer` | Read-only network data |

An authentication allowlist is not an administrator assignment. Google users
cannot become administrators merely by appearing in the email or domain
allowlist. Operators also cannot run AI analysis because it may transmit data
to a configured provider and incur charges.

When upgrading from a version without browser roles, existing local sessions
remain administrators. Existing OIDC sessions are revoked once and must sign in
again so EgressView can assign a role from a newly verified allowlist match.

## Reverse proxy boundary

Set the canonical public URL and trust only the proxy addresses you operate:

```dotenv
EGRESSVIEW_PUBLIC_URL=https://egressview.example.com
EGRESSVIEW_TRUST_PROXY=10.41.0.10
EGRESSVIEW_SECURE_COOKIES=true
```

`EGRESSVIEW_TRUST_PROXY` accepts comma-separated exact IPs and IPv4 CIDRs. Do not use a trust-all proxy setting. Forwarded client/protocol headers affect rate limiting, audit pseudonyms, and Secure-cookie decisions.

When a reverse proxy strips the configured `SUBPATH` before forwarding the
request, also send `X-Forwarded-Prefix` with that exact value. For example, a
proxy exposing `/egressview/` while forwarding to the application root must
send `X-Forwarded-Prefix: /egressview`. This lets the same process serve a
dedicated public host at `/` without breaking private subpath access.

The defaults allow 600 API reads and 120 API mutations per client per minute. Override them with `EGRESSVIEW_RATE_LIMIT_READS` and `EGRESSVIEW_RATE_LIMIT_WRITES` only after observing normal traffic.

Agent ingest is counted separately, at 1500 requests per address per minute (`EGRESSVIEW_AGENT_INGEST_WRITES_PER_IP`). It needs its own budget because agents are not people: one agent may send 30 batches a minute, so sharing the 120 mutation budget would stop the fifth agent arriving from the same address — which is what happens as soon as agents reach the Hub through NAT. Each agent is separately held to 30 requests per minute (`EGRESSVIEW_AGENT_INGEST_REQUESTS_PER_MINUTE`).

Over the limit the Hub answers `429` with `Retry-After`, and the agent backs off and resends, so observations are delayed rather than lost. Delay is still worth avoiding: it shows up as a Hub that looks slightly out of date, with nothing on screen to explain why. `GET /api/agents/ingest-metrics` reports `eventLoopDelayMs`, which is the reading that tells you whether ingest is starting to hold up the web UI.

## Audit

Settings shows recent login, logout, security change, CSRF rejection, and mutating API events. The append-only rows contain request IDs and keyed hashes rather than raw email addresses or client IPs. Default retention is 180 days.
