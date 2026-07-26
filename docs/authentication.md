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

### Every allowed user is an administrator

> **Warning**
> EgressView authenticates users but does not yet separate permissions. Any account that passes the allowlist signs in with full administrator access: it can read all captured traffic, change router credentials, rotate secrets, restore backups, and revoke other sessions.

A **domain** allowlist therefore grants that access to everyone in the domain, including accounts created after you configured it. Until role-based access control ships, prefer an explicit **email** allowlist that lists each person individually.

EgressView never disables an existing configuration on your behalf — locking out remote users silently would be worse. Instead it warns in the server log at startup and next to the field in Settings whenever a domain allowlist is active.

**Moving from a domain allowlist to an email allowlist**

1. Sign in with the emergency local administrator, so you keep access even if the next step removes your own Google account. This account is always available and is unaffected by OIDC settings.
2. In Settings → General → Authentication & Audit, add every person who needs access to **Allowed emails**.
3. Clear the **Allowed domains** field and save. At least one email or domain must remain while Google OIDC is enabled.
4. Revoke existing sessions in the session list so anyone who no longer matches the allowlist is signed out. Removing an allowlist entry does not end sessions that are already open.
5. Confirm the startup warning is gone from the server log on the next restart.

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
