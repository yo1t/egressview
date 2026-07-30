# Deployment profiles

> [Japanese / 日本語](deployment-profiles.ja.md)

EgressView keeps its collection, SQLite, browser, REST, and MCP domain logic
independent of a specific cloud. AWS, another cloud, and on-premises
installations use the same application and database schema. Infrastructure
services such as a load balancer, public DNS, WAF, and identity provider are
deployment adapters rather than runtime requirements.

## Profile matrix

| Profile | Exposure | MCP transport | Authentication | TLS | Identity provider | Intended outbound access |
|---|---|---|---|---|---|---|
| `local-stdio` | Local process/private API | stdio | Scoped EgressView API identity | Not required for stdio; protect the API path | None | Private EgressView API; optional internal DNS |
| `private-http` | LAN/VPN/private subnet only | HTTP | Dedicated MCP token plus scoped API identity | Required outside loopback | None | Private EgressView API; optional internal DNS |
| `private-oauth` | LAN/VPN/private subnet only | HTTP | OAuth/OIDC scopes plus scoped service identity | Required; an internal CA is supported | Internal OIDC provider | Internal issuer/JWKS and EgressView API |
| `public-oauth` | Internet through a reviewed proxy only | HTTP | OAuth/OIDC scopes plus scoped service identity | Publicly trusted TLS required | OIDC provider | Issuer/JWKS and EgressView API |

Set `EGRESSVIEW_DEPLOYMENT_PROFILE` in the MCP process to one of these four
values. When omitted, EgressView preserves compatibility by inferring
`local-stdio` for stdio, `private-http` for HTTP token mode, and `public-oauth`
for HTTP OAuth mode. An explicit profile that conflicts with `MCP_PORT` or
`MCP_AUTH_MODE` fails before the MCP endpoint starts.

The matrix states the required end-state controls. The current Phase 0
implementation validates the profile name plus its transport/authentication
pair. HTTP still listens on `127.0.0.1`; configurable private/container
binding and enforcement of the private least-privilege controls belong to
Phase 1. A guaranteed offline switch and self-hosted browser assets belong to
Phase 2. Do not claim an air-gapped installation until those gates pass.

For a private CA, start Node with `NODE_EXTRA_CA_CERTS` pointing to a protected
PEM trust bundle and install the same CA in each MCP client trust store. Never
disable TLS certificate verification as a substitute for distributing the CA.

## Threat model and required controls

| Boundary | Main threats | Required controls |
|---|---|---|
| Local stdio | Malicious local process, leaked API identity | OS account isolation, mode-`0600` client configuration, scoped identity, rotation |
| Private network | LAN compromise, token capture, unintended route exposure | TLS outside loopback, firewall/VPN, dedicated credential, least privilege, audit, rate and timeout limits |
| Private OAuth | Internal IdP compromise, internal CA misuse, stale tokens | PKCE S256, exact issuer/audience/resource, trusted internal CA distribution, short access tokens, refresh replay handling |
| Public OAuth | Internet scanning, credential replay, denial of service, proxy bypass | Publication gate, public TLS, OAuth, WAF/proxy limits, no direct application ingress, append-only audit, rollback |
| Offline runtime | Hidden egress through CDN, enrichment, cloud AI, or updates | Self-hosted assets, explicit outbound deny policy, local agent/model, egress-blocked integration tests |

A private network is not treated as trusted by default. Private HTTP must not
reuse a browser administrator token or send a bearer token over plaintext LAN.
Binding to `0.0.0.0` is not evidence that a service is private; the deployment
must also prove its firewall, security-group, network-policy, or proxy boundary.

## External dependency matrix

| Capability | Internet dependency today | Private replacement | Offline target |
|---|---|---|---|
| Router collection and SQLite | None | Same runtime | Supported |
| MCP stdio/private HTTP | None after installation | Private API and optional internal TLS | Supported with a local MCP client |
| Browser graph libraries and world map | Public D3/jsDelivr assets | Self-hosted assets | Phase 2 |
| Reverse DNS | Resolver-dependent | Internal DNS | Optional |
| RDAP, threat feeds, OUI updates | Public services | Controlled mirror where available | Disabled with visible status |
| Browser OIDC | Google in the current optional implementation | Local administrator or future generic internal OIDC | Local administrator |
| MCP OAuth | Issuer-dependent, not cloud-specific | Self-hosted OIDC and internal CA | Private OAuth if all issuer/JWKS endpoints are internal |
| AI Insights | Ollama or cloud provider | Ollama/private compatible endpoint | Local model only |
| Package/image updates | Package registry or image registry | Internal mirror | Signed offline bundle, checksum, lock file, and SBOM in Phase 4 |

Cloud agents such as Claude Code and GitHub Copilot require their own Internet
connectivity even when the MCP endpoint is private. A fully offline deployment
therefore needs an MCP-capable local agent and a local model such as Ollama.

## AWS mapping

The planned AWS deployment is the `public-oauth` profile, not a separate
application edition:

- existing EC2 for EgressView and its loopback MCP process;
- ECS Fargate plus RDS PostgreSQL for the selected Keycloak deployment;
- ALB and ACM for TLS termination;
- WAF and proxy limits for the public boundary;
- Route 53 for `www`, `mcp`, and `auth` names;
- security groups that prevent direct Internet ingress to EgressView and MCP.

The same application can instead use an on-premises reverse proxy and internal
Keycloak, or equivalent services in another cloud. AWS construction remains
`publishDns=false` until the MCP protocol and publication gates pass.
