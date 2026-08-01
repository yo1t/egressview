# Remote MCP OAuth compatibility evaluation

Last reviewed: 2026-08-01

This document records the P2-60 PR 1 authorization-server and MCP-client
compatibility evaluation. It is a design decision only. It does not enable a
public MCP endpoint or change application code.

The authorization-server comparison below records the original
MCP Authorization `2025-11-25` decision and remains relevant to the OAuth
profile. The EgressView transport now serves both `2025-11-25` and
`2026-07-28`; active publication probes require both revisions. Real clients
record the supported revision in their current release, and are retested when
modern support ships. This update does not publish the endpoint.

The AWS-specific findings were checked a second time with the AWS
Documentation MCP server configured in Kiro. That server searches AWS primary
documentation; it does not access this AWS account or execute Cognito requests.

## Decision

No authorization server fully passes the strict profile. **Cognito Essentials
is the conditional first choice for production, with Keycloak as the
standards-oriented fallback.** Both choices retain an explicit exception:

- **Amazon Cognito is not eligible for the strict MCP 2025-11-25 profile
  today.** A live discovery document did not contain
  `code_challenge_methods_supported`. MCP clients are required to stop when
  this field is absent. Cognito supports RFC 8707 resource binding and PKCE
  S256, but those capabilities do not override the metadata requirement.
- **Keycloak does not fully conform to the strict profile today.** Its own MCP
  guide marks RFC 8707 as unsupported, so the client-supplied `resource`
  parameter is not processed. For EgressView's initial single MCP resource,
  however, each allowed scope can map to one fixed canonical `aud`, and
  EgressView can reject every token without that exact audience. This preserves
  the token audience-restriction security goal, but must be documented as an
  interim compatibility exception rather than RFC 8707 compliance.
- **authentik remains unselected because evidence is incomplete.** Its official OAuth provider
  documentation covers OIDC discovery, PKCE, refresh-token rotation, and
  revocation, but does not document RFC 8707 resource indicators, CIMD, or
  DCR. It can be reconsidered when those capabilities are documented or tested.

Start with Cognito in DNS-unpublished staging. Its explicit compatibility
profile permits only the missing PKCE metadata field for an exact regional
user-pool issuer; token signature, issuer, expiry, canonical audience, and
scope validation remain strict. Adopt it only after PKCE S256 wire evidence
and versioned Inspector, Claude Code, and Copilot CLI tests pass. Use Keycloak
if any target client is incompatible. Keycloak's CIMD support is experimental,
and its fixed-audience mapper remains a single-resource RFC 8707 exception.

## 2026-07-28 private client retest (2026-07-29)

The retest used Keycloak 26.7.0, EgressView MCP, and a fixture API bound only
to loopback. It made no Internet publication or AWS infrastructure change.
Claude Code 2.1.220 and GitHub Copilot CLI 1.0.75 both completed PKCE S256,
`resource`, and RFC 9207 authorization-response `iss` handling, but the wire
trace showed legacy `initialize` traffic and an actual selected revision of
`2025-11-25`. The `2026-07-28` client gate therefore remains incomplete and
publication stays blocked.

An independent probe proved that EgressView accepts the fixed audience,
read/write scopes, RS256 signature, and 60-second access token, and that normal
refresh rotation succeeds repeatedly. Reusing a two-generation-old refresh
token, however, succeeded once and then caused the entire family to return
`invalid_grant`. The gate accepts that behavior as the explicit
`revoke-family` mode only when the current family also fails after replay and
the access-token lifetime is at most 15 minutes. Providers that reject the
replay while preserving the current family use `reject-replay`. The evidence
records the selected mode instead of treating these different semantics as the
same result. Issuer-change binding, scope step-up, and real-client refresh will
be retested when a modern-revision client release is available.

## Required profile

EgressView supports the MCP Authorization requirements used by both the
legacy `2025-11-25` and modern `2026-07-28` protocol eras:

- clients send the canonical `resource` in both authorization and token
  requests;
- the authorization server publishes `code_challenge_methods_supported` with
  `S256`;
- clients use Authorization Code with PKCE and an exact registered redirect
  URI;
- a supported registration path exists: pre-registration, CIMD, or DCR;
- public-client refresh tokens rotate, and an operational revocation path
  exists;
- the MCP server validates signature, issuer, expiry, audience, resource, and
  scope without token passthrough.

The provisional Keycloak profile is a documented exception to the first item.
It permits exactly one MCP resource and requires all exposed scopes to add the
same canonical audience. Multi-resource deployments are prohibited until RFC
8707 is supported.

The canonical URI and public DNS name are deliberately not invented in this
evaluation. Before a live test, one exact URI such as
`https://mcp.example.net/mcp` must be selected and reused as the MCP endpoint,
Protected Resource Metadata `resource`, Cognito resource-server identifier,
authorization/token `resource` parameter, and access-token `aud`.

## Authorization-server matrix

| Requirement | Cognito | Keycloak | authentik |
| --- | --- | --- | --- |
| RFC 8707 resource binding | Authorization endpoint documented; `resource` is absent from documented token-endpoint parameters | No: officially unsupported | No documented support; reject |
| `aud` bound to canonical resource | Yes when Cognito resource binding succeeds | Scope mapper workaround only | Custom claim mapping is not RFC 8707 |
| PKCE S256 | Protocol support exists, but live discovery omitted `code_challenge_methods_supported`; strict fail | Supported and enforceable | Supported; discovery field must be captured |
| Client registration | Pre-registration only for this design | Pre-registration, DCR, experimental CIMD | Pre-registration documented; DCR/CIMD not documented |
| Exact callback compatibility | Fixed callbacks can be registered; up to 100 callback URLs; no wildcard behavior is documented | Configurable exact redirects | Exact or regex redirects |
| Refresh / rotation | Supported; rotation grace period is configurable up to 60 seconds | Supported and configurable | Requires `offline_access`; rotation configurable |
| Revocation endpoint | `/oauth2/revoke` | OIDC revoke endpoint | `/application/o/revoke/` |
| P2-60 result | **Conditional production-first choice; compatibility profile required** | **Standards-oriented fallback with a single-resource exception** | **Unselected; evidence incomplete** |

## MCP-client matrix

Official client documentation does not expose every wire-level OAuth
parameter. "Live test required" means the provider is not approved for that
client until an authorization trace proves both `resource` parameters,
PKCE S256, refresh, and revocation behavior.

| Client | Documented capability | Registration / callback | Cognito result |
| --- | --- | --- | --- |
| ChatGPT custom MCP app | OAuth and refresh-token use; `offline_access` must be advertised | Generic static client-ID and callback behavior are not publicly documented | **Live compatibility test required** |
| Claude web / Desktop | OAuth, DCR, custom client ID/secret, expiry and refresh | Fixed `https://claude.ai/api/mcp/auth_callback`; also register the future `https://claude.com/api/mcp/auth_callback` | **Live compatibility test required** |
| Claude Code | Browser OAuth with secure token storage and automatic refresh | Official setup guide lists localhost callbacks, but static-client configuration is not documented | **Live compatibility test required** |
| Cursor | Streamable HTTP/SSE OAuth; static-client OAuth improvements are documented | Callback behavior has changed across releases and is not configurable in the public MCP reference | **Live compatibility test required** |
| Kiro CLI | Browser OAuth, pre-registered public/confidential client, custom scopes, refresh/reauth | Exact loopback URL, port, and path are configurable | **Live compatibility test required** |

Cognito is approved only for clients that tolerate the missing metadata field
while demonstrably using PKCE S256. Each supported version must pass the
DNS-unpublished publication gate. If any target client is incompatible,
Keycloak remains the fallback using pre-registered clients.

## Cognito live-test result

### Essentials re-evaluation (2026-08-01)

Before provisioning the Keycloak infrastructure, a disposable Cognito
Essentials pool was evaluated with managed login, Authorization Code + PKCE
S256, a URL-formatted resource server, a secretless public client, an exact
localhost callback, five-minute access tokens, refresh-token rotation, and
token revocation.

- A valid code exchange succeeded and the access-token `aud` exactly matched
  the canonical MCP resource.
- URL-formatted custom read/write scopes were included in the access token,
  and refresh preserved both the audience and scopes.
- Refresh tokens rotated. Reuse of the old token and use after revocation both
  failed with `invalid_grant`.
- The implicit grant failed with `unauthorized_client`, and an unregistered
  callback port failed with `redirect_mismatch`.
- The regional issuer's OIDC discovery document still omitted
  `code_challenge_methods_supported` and `registration_endpoint`, and did not
  advertise custom scopes in `scopes_supported`. EgressView's production OAuth
  verifier failed closed with `Authorization Server Metadata does not
  advertise PKCE S256`.

Token issuance, resource binding, rotation, and revocation meet the functional
requirements. Cognito is therefore the conditional production-first choice,
despite not passing the strict MCP metadata profile. EgressView's compatibility
profile permits only the omitted field for an exact Cognito issuer and requires
PKCE S256 wire evidence plus versioned client tests before publication. It does
not add a metadata proxy, disable PKCE, or relax JWT validation. The disposable
pool and domain were deleted; existing pools, EC2, DNS, ALB, security groups,
and EgressView configuration were not changed.

### Initial live test (2026-07-26)

The existing unrelated Amplify user pool was not changed or reused. A
disposable, tagged P2-60 user pool was created with self-registration disabled,
then deleted after the following tests:

1. A managed-login domain, URL-formatted resource server, `network.read` and
   `notes.write` scopes, and a secretless public client were created.
2. The client allowed only Authorization Code, used an exact localhost
   callback, five-minute access tokens, refresh-token rotation, and a
   zero-second rotation grace period.
3. The new domain-backed pool's public OIDC discovery document omitted both
   `code_challenge_methods_supported` and `registration_endpoint`. The managed
   login domain itself returned 404 for `/.well-known/openid-configuration`;
   discovery is served from the regional issuer path.
4. The same invalid authorization-code request returned `invalid_grant` both
   without and with `resource`. An invalid refresh request with `resource` also
   returned `invalid_grant`. Cognito therefore does not reject the parameter
   before grant validation, but this negative test does not prove that it binds
   a successfully issued token.
5. An implicit `response_type=token` request was rejected with
   `unauthorized_client`, confirming the code-only client gate.
6. No test user or valid token was created. The managed-login domain and user
   pool were deleted, and a final list operation confirmed that the test pool
   no longer exists.

MCP Authorization 2025-11-25 requires clients to refuse authorization when the
PKCE metadata field is absent. This initial result fails the strict profile;
the later compatibility profile does not change that standards assessment.

AWS Documentation MCP confirms that AWS documents `resource` at
`/oauth2/authorize`, while the documented `/oauth2/token` parameter list does
not include it. This absence does **not** prove that the endpoint rejects an
unknown parameter. Similarly, AWS documents S256 as the only supported PKCE
method but does not explicitly document the discovery JSON field required by
MCP. Both questions therefore remain live-test gates.

The account-aware AWS MCP entry found in a Kiro configuration was not active
and its proxy executable was unavailable. AWS Documentation MCP was used for
primary-source research and the authenticated AWS CLI was used for the
disposable test. No valid token was issued, and all test resources were
removed.

## Operational conclusion

Do not expose port 3010 yet. Proceed with Cognito in DNS-unpublished staging and
require the compatibility evidence described above for every supported client
version. If those tests pass, Cognito is the production choice. If they fail,
deploy the private Keycloak fallback and retain its documented single-resource
RFC 8707 exception. Neither path permits DNS publication before the P2-60 gate.

## Primary sources

- [MCP Authorization 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [Amazon Cognito resource binding](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-define-resource-servers.html)
- [Amazon Cognito token endpoint](https://docs.aws.amazon.com/cognito/latest/developerguide/token-endpoint.html)
- [Amazon Cognito revocation endpoint](https://docs.aws.amazon.com/cognito/latest/developerguide/revocation-endpoint.html)
- [Keycloak MCP integration](https://www.keycloak.org/securing-apps/mcp-authz-server)
- [authentik OAuth 2.0 provider](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/)
- [ChatGPT developer mode and MCP apps](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)
- [Claude custom remote MCP connectors](https://support.claude.com/en/articles/11503834-build-custom-connectors-via-remote-mcp-servers)
- [Claude custom connector setup](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
- [Cursor MCP documentation](https://docs.cursor.com/context/model-context-protocol)
- [Kiro CLI MCP OAuth configuration](https://kiro.dev/docs/cli/mcp/configuration/)
