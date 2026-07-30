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

Phase 1 enforces the private HTTP controls. HTTP binds to `127.0.0.1` by
default. A non-loopback `MCP_BIND_ADDRESS` is accepted only when the deployment
profile is explicit and `MCP_ALLOW_NON_LOOPBACK=true`; hostnames are rejected
to avoid resolver-dependent exposure. Every HTTP profile uses a dedicated
`MCP_SERVICE_TOKEN` with exactly `network.read` and `notes.write`, append-only
audit, rate and concurrency limits, bounded bodies, and request/API deadlines.
The endpoint token, service identity, audit key, and administrator token must
remain distinct.

The application serves plain HTTP, so any non-loopback path must be protected
by a TLS reverse proxy or equivalent trusted private transport plus firewall,
security-group, or network-policy controls. Explicit bind approval is not a
claim that the network is safe. A guaranteed offline switch and self-hosted
browser assets belong to Phase 2. Do not claim an air-gapped installation
until those gates pass.

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

## Offline mode

Set `EGRESSVIEW_OFFLINE_MODE=true` for an air-gapped or egress-filtered
deployment. Only the exact string `true` enables it, so a typo cannot leave a
deployment believing it is isolated.

The guarantee is that no outbound request is **attempted** — not that it fails.
Letting a call go out and time out would still emit packets, still reveal that
EgressView is running, and still stall startup for the length of every timeout.
Each feature is therefore decided before the module that would perform the call
is wired up, and cloud provider SDK clients are never constructed, so no
credential resolution or connection setup happens either.

### Disabled before startup

RDAP, GeoIP, threat intelligence feeds, the Wireshark OUI vendor database,
manual threat lookup, Google OIDC, and the Anthropic, OpenAI and Bedrock AI
providers.

### Unaffected

Router SSH collection, SQLite storage and migrations, the web UI, and stdio and
private HTTP MCP. These are local by definition.

### Allowed only when explicitly configured

| Feature | Enable with |
|---|---|
| Internal DNS / PTR | `EGRESSVIEW_INTERNAL_DNS` |
| Self-hosted Ollama | `EGRESSVIEW_OLLAMA_URL` |

These can be reachable inside an isolated network, but they stay off until you
point them at a loopback or private IP address. Hostnames are rejected in
offline mode so DNS cannot redirect an approved endpoint outside the isolated
network. Private OAuth for MCP is configured separately with the MCP OAuth
settings described in the [MCP setup guide](setup-mcp.md).

### What you lose

Destinations show no owner, country or coordinates, threat matching uses only
what is already cached, and unknown MAC prefixes have no vendor name. Existing
cached data keeps working; it simply stops being refreshed.

The startup log lists exactly which features were disabled, and `GET
/api/status` reports the same state so the UI can explain a disabled
panel instead of leaving it blank.

### Front-end assets

D3, TopoJSON and the world atlas are served from this origin at pinned versions,
and the CSP allows no external origin. A page load in offline mode makes no
third-party request.
