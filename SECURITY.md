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

- All API endpoints and the WebSocket are protected by login/session authentication or an API token (timing-safe comparison, brute-force delay, session expiry).
- HTTPS protects credentials and dashboard data in transit when accessing EgressView from outside the LAN.
- Router credentials and the SQLite database stay on the host machine; nothing is sent to a cloud service. Threat-intelligence feeds are downloaded and matched locally.
- Router IP inputs are restricted to private address ranges (SSRF protection).

For internet-facing deployments, enable HTTPS, use a strong unique login password, keep EgressView updated, and avoid sharing access with untrusted users. Security reports for internet-accessible deployments are in scope.

## Out of scope

- Vulnerabilities in the monitored routers' firmware (report those to the vendor)
- Denial of service against the local dashboard by an attacker who is already on the LAN with the admin token
