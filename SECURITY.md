# Security Policy

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Please use GitHub private vulnerability reporting:

[Report a vulnerability](https://github.com/yo1t/egressview/security/advisories/new)

You can expect an acknowledgment within a few days. Fixes are released on a best-effort basis; you will be credited in the release notes unless you prefer otherwise.

## Supported versions

EgressView ships from the `main` branch. Security fixes are applied to `main` only — please keep your installation up to date.

## Deployment model & scope

EgressView monitors your LAN passively and can be accessed remotely when HTTPS is enabled:

- All API endpoints and the WebSocket are protected by local/OIDC sessions or an API token. Browser sessions use HttpOnly/SameSite cookies and CSRF protection.
- Google OIDC is optional and uses PKCE, state, nonce, signed ID tokens, verified email, and an explicit email/domain allowlist. The emergency local administrator remains available during IdP or internet outages.
- Browser authorization is least-privilege: local login is `admin`, an explicitly allowed Google email is `operator`, and a domain-only match is read-only `viewer`. Allowlist membership alone never grants Google users administrator access.
- Authentication and mutating API events are appended to a pseudonymous SQLite audit log. Raw client IPs, email addresses, credentials, and request bodies are not stored there.
- HTTPS protects credentials and dashboard data in transit when accessing EgressView from outside the LAN.
- Router credentials and the SQLite database stay on the host machine; nothing is sent to a cloud service. Threat-intelligence feeds are downloaded and matched locally.
- Router IP inputs are restricted to private address ranges (SSRF protection).

For internet-facing deployments, terminate HTTPS at a trusted reverse proxy, set `EGRESSVIEW_PUBLIC_URL`, and configure an exact `EGRESSVIEW_TRUST_PROXY` IP/CIDR allowlist. Never trust forwarded headers from every source. Use a strong unique login password, keep EgressView updated, and avoid sharing access with untrusted users. Security reports for internet-accessible deployments are in scope.

## Out of scope

- Vulnerabilities in the monitored routers' firmware (report those to the vendor)
- Denial of service against the local dashboard by an attacker who is already on the LAN with the admin token
