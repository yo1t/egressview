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

Signed portable releases use an Ed25519 signature over the archive checksum,
plus a CycloneDX SBOM and per-file manifest. The public key distributed beside
an archive must be matched to a fingerprint obtained through a separate trusted
release channel. CI's ephemeral signing key proves the mechanism only and is
not an official release identity.

The active release signing key is:

```text
key id       egressview-release-2026
algorithm    Ed25519
fingerprint  SHA256:6288265bd746d230a3637e3a520e2335f48dc939a4d76d7b05c44ea5baf3eccc
```

Cross-check that value against DNS, which is the one place holding it that is
not this repository:

```console
$ dig +short TXT _egressview-release.egressview.com
"egressview-release-key=egressview-release-2026; fp=SHA256:6288265bd746d230a3637e3a520e2335f48dc939a4d76d7b05c44ea5baf3eccc; created=2026-08-05"
```

This matters more than the number of places the fingerprint appears. It is also
in `release-signing/trusted-fingerprints.json` and on the project website, but
those are built from this repository and would change together with it. The DNS
record is served from a separate provider under separate credentials, so anyone
who rewrote this file could not silently rewrite that too.

Compare the **complete** fingerprint, never a prefix or suffix. The private half
is held in AWS KMS and cannot be exported; signing is restricted to a dedicated
release principal by key policy. Verifying a release needs no AWS access — only
`openssl` and the public key shipped beside the archive. The enrolled record is
in [`release-signing/trusted-fingerprints.json`](release-signing/trusted-fingerprints.json). Installation requires temporary npm-registry
access; runtime Internet access can then be disabled with
`EGRESSVIEW_OFFLINE_MODE=true`.

## Out of scope

- Vulnerabilities in the monitored routers' firmware (report those to the vendor)
- Denial of service against the local dashboard by an attacker who is already on the LAN with the admin token
