# Security Policy

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, use one of these private channels:

1. **GitHub private vulnerability reporting** (preferred):
   [Report a vulnerability](https://github.com/yo1t/widemap/security/advisories/new)
2. **Email**: yo1@tkywave.com — include "widemap security" in the subject line.

You can expect an acknowledgment within a few days. Fixes are released on a best-effort basis; you will be credited in the release notes unless you prefer otherwise.

## Supported versions

Widemap ships from the `main` branch. Security fixes are applied to `main` only — please keep your installation up to date.

## Deployment model & scope

Widemap is designed to run **inside your LAN** and monitors it passively:

- All API endpoints and the WebSocket are protected by an admin token (timing-safe comparison, brute-force delay).
- Router credentials and the SQLite database stay on the host machine; nothing is sent to a cloud service. Threat-intelligence feeds are downloaded and matched locally.
- Router IP inputs are restricted to private address ranges (SSRF protection).

**Do not expose Widemap directly to the internet.** If you need remote access, put it behind a VPN or an authenticating reverse proxy. Reports that assume an internet-exposed deployment without such protection are still welcome, but will be triaged as lower severity.

## Out of scope

- Vulnerabilities in the monitored routers' firmware (report those to the vendor)
- Denial of service against the local dashboard by an attacker who is already on the LAN with the admin token
