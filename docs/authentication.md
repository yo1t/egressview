# Authentication and reverse proxy

> [Japanese / 日本語](authentication.ja.md)

EgressView always keeps one emergency local administrator. Google OIDC is an optional additional login method and cannot disable local recovery.

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

## Reverse proxy boundary

Set the canonical public URL and trust only the proxy addresses you operate:

```dotenv
EGRESSVIEW_PUBLIC_URL=https://egressview.example.com
EGRESSVIEW_TRUST_PROXY=10.41.0.10
EGRESSVIEW_SECURE_COOKIES=true
```

`EGRESSVIEW_TRUST_PROXY` accepts comma-separated exact IPs and IPv4 CIDRs. Do not use a trust-all proxy setting. Forwarded client/protocol headers affect rate limiting, audit pseudonyms, and Secure-cookie decisions.

The defaults allow 600 API reads and 120 API mutations per client per minute. Override them with `EGRESSVIEW_RATE_LIMIT_READS` and `EGRESSVIEW_RATE_LIMIT_WRITES` only after observing normal traffic.

## Audit

Settings shows recent login, logout, security change, CSRF rejection, and mutating API events. The append-only rows contain request IDs and keyed hashes rather than raw email addresses or client IPs. Default retention is 180 days.
