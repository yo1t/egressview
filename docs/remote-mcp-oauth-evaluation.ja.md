# Remote MCP OAuth互換性評価

最終確認: 2026-08-01

本書はP2-60 PR 1の認可サーバー・MCPクライアント互換性評価を記録する。
設計判断だけを対象とし、public MCP endpointの有効化やコード変更は行わない。

以下の認可サーバー比較は、当初のMCP Authorization `2025-11-25`に対する
判断記録であり、OAuth profileとして引き続き有効である。EgressViewのtransportは
現在`2025-11-25`と`2026-07-28`の両方を提供し、公開gateのactive probeで
両revisionを必須にする。実clientは現在のreleaseが対応するrevisionを記録し、
modern対応版の公開後に追加回帰する。この更新によってendpointを公開することはない。

AWS固有の判定は、Kiroに設定済みのAWS Documentation MCP serverでも二重確認した。
このserverはAWS一次資料を検索するものであり、AWS accountへの接続やCognito
requestの実行は行わない。

## 結論

厳格profileを完全に通過する認可サーバーはない。**実運用はCognito Essentialsを
条件付き第一候補、Keycloakを標準準拠性優先のfallback**とする。どちらにも明示的な
互換性例外が残る。

- **Amazon Cognitoも厳格なMCP 2025-11-25構成では現時点で採用しない。**
  実際のdiscovery documentに`code_challenge_methods_supported`がなかった。
  MCP clientはこのfieldがない場合に認可を中止する必要がある。CognitoはRFC 8707
  resource bindingとPKCE S256自体には対応するが、metadata要件を代替しない。
- **Keycloakは厳格profileへ完全準拠しない。** 公式MCPガイド自身がRFC 8707
  未対応としており、clientの`resource` parameterは処理しない。ただし初期版を
  MCP resource 1つに限定し、全許可scopeを同じcanonical `aud`へmappingし、
  EgressViewが完全一致しないtokenを拒否すれば、token用途制限というsecurity
  goalは維持できる。RFC 8707準拠とは表記せず、暫定互換例外として扱う。
- **authentikは根拠不足のため未選定とする。** 公式文書でOIDC discovery、PKCE、
  refresh token rotation、失効は確認できるが、RFC 8707 resource indicator、
  CIMD、DCRは確認できない。公式化または実測後に再評価する。

CognitoをDNS非公開stagingで先に試す。明示的compatibility profileはAWS regional
user-pool issuerとの完全一致時だけPKCE metadata fieldの欠落を許容し、署名、issuer、
有効期限、canonical audience、scope検証は維持する。PKCE S256のwire証跡と
Inspector、Claude Code、Copilot CLIのversion付き試験が合格した場合だけ採用する。
対象clientが非互換ならKeycloakへ切り替える。KeycloakのCIMDはexperimentalであり、
固定audience mapperも単一resource限定のRFC 8707例外として残る。

## 2026-07-28 client private再試験（2026-07-29）

Internet公開やAWS環境変更を行わず、Keycloak 26.7.0、EgressView MCP、fixture APIを
loopbackだけで試験した。Claude Code 2.1.220とGitHub Copilot CLI 1.0.75はいずれも
PKCE S256、`resource`、RFC 9207 response `iss`を送受信できたが、wire traceでは
legacy `initialize`を使い、選択revisionは`2025-11-25`だった。したがって
`2026-07-28` client gateは未達で、公開禁止を維持する。

独立probeでは固定audience、read/write scope、RS256、60秒access tokenを
EgressViewが受理し、連続refresh rotationも成功した。ただし2世代前のrefresh
token再利用は最初のrequestが成功し、その後family全体が`invalid_grant`となった。
gateはこの挙動を`revoke-family`方式として、replay後に現行familyも失敗し、
access token寿命が15分以下の場合だけ許可する。replay request自体を拒否しながら
現行familyを維持するproviderは`reject-replay`方式を使う。異なる意味を同じ成功と
みなさず、証跡へ採用方式を記録する。modern対応client release後にissuer変更、
scope step-up、実client refreshを再試験する。

## 必須profile

EgressViewはlegacy `2025-11-25`とmodern `2026-07-28`の両protocol eraで
必要なMCP Authorization要件に対応する。

- clientはcanonical `resource`をauthorization requestとtoken requestの両方へ送る。
- 認可サーバーは`code_challenge_methods_supported`に`S256`を公開する。
- Authorization Code + PKCEと完全一致する登録済みredirect URIを使う。
- 事前登録、CIMD、DCRのいずれかのclient登録経路を持つ。
- public clientのrefresh tokenをrotationし、運用可能な失効経路を持つ。
- MCP serverはtoken passthroughを行わず、署名、issuer、期限、audience、
  resource、scopeを検証する。

暫定Keycloak profileは最初の要件に対する明示的な例外である。MCP resourceを
1つに限定し、公開する全scopeが同じcanonical audienceを付与することを必須とする。
RFC 8707正式対応まではmulti-resource構成を禁止する。

本評価ではpublic DNS名を推測で決めない。実接続試験前に
`https://mcp.example.net/mcp`のようなURIを1つ確定し、MCP endpoint、
Protected Resource Metadataの`resource`、Cognito resource server identifier、
authorization/token requestの`resource`、access tokenの`aud`で完全に一致させる。

## 認可サーバー対応表

| 要件 | Cognito | Keycloak | authentik |
| --- | --- | --- | --- |
| RFC 8707 resource binding | authorize側は公式確認済み、token endpointの文書化parameterに`resource`なし | 非対応と公式明記 | 公式な対応根拠なし、不可 |
| canonical resourceへの`aud`束縛 | resource binding成功時は対応 | scope mapperによる回避のみ | custom claimはRFC 8707の代替にならない |
| PKCE S256 | protocol対応はあるが実discoveryに`code_challenge_methods_supported`なし、厳格判定は失敗 | 対応・強制可能 | 対応、discovery fieldは実測保存 |
| client登録 | 本設計では事前登録のみ | 事前登録、DCR、実験的CIMD | 事前登録は確認、DCR/CIMDは未確認 |
| callback | 固定callbackを最大100件登録可能、wildcard挙動は公式文書になし | 完全一致redirectを設定可能 | 完全一致またはregex |
| refresh / rotation | 対応、rotation grace periodは最大60秒 | 対応・設定可能 | `offline_access`必須、rotation設定可能 |
| 失効endpoint | `/oauth2/revoke` | OIDC revoke endpoint | `/application/o/revoke/` |
| P2-60判定 | **compatibility profile付きの条件付き第一候補** | **単一resource例外を持つ標準準拠性優先fallback** | **根拠不足で未選定** |

## MCPクライアント対応表

公式client文書はOAuthの全wire parameterを公開していない。「実測必須」は、
authorization/token両方の`resource`、PKCE S256、refresh、失効を認可traceで
確認するまで、そのclient向けproviderを採用しないことを意味する。

| Client | 公式確認できた機能 | 登録・callback | Cognito判定 |
| --- | --- | --- | --- |
| ChatGPT custom MCP app | OAuth、refresh token、`offline_access`広告の必要性 | 汎用のstatic client ID・callback仕様は公開文書で未確認 | **実互換性試験が必要** |
| Claude web / Desktop | OAuth、DCR、custom client ID/secret、token期限・refresh | `https://claude.ai/api/mcp/auth_callback`固定。将来用`https://claude.com/api/mcp/auth_callback`も登録 | **実互換性試験が必要** |
| Claude Code | browser OAuth、token安全保存、自動refresh | localhost callbackは公式guideにあるがstatic client設定は未確認 | **実互換性試験が必要** |
| Cursor | Streamable HTTP/SSE OAuth、static-client OAuth改善 | release間でcallback挙動が変化し、公開MCP referenceでは設定不可 | **実互換性試験が必要** |
| Kiro CLI | browser OAuth、事前登録public/confidential client、scope指定、refresh/再認証 | loopback URL、port、pathを完全指定可能 | **実互換性試験が必要** |

Cognitoはmetadata欠落を許容しながらPKCE S256を実際に使うclientだけを対応対象とし、
versionごとにDNS非公開gateを通す。対象clientが非互換ならKeycloakへ切り替える。

## Cognito実測結果

### Essentials再評価（2026-08-01）

Keycloak用インフラを構築する前に、使い捨てのCognito Essentials poolでmanaged
loginを再評価した。Authorization Code + PKCE S256、URL形式resource server、
secretなしpublic client、固定localhost callback、5分access token、refresh token
rotation、token revocationを使用した。

- 正常code交換が成功し、access tokenの`aud`はcanonical MCP resourceと一致した。
- URL形式のcustom read/write scopeがaccess tokenへ入り、refresh後も`aud`とscopeを
  維持した。
- refresh tokenはrotationされ、旧tokenの再利用とrevoke後の利用はいずれも
  `invalid_grant`で拒否された。
- implicit grantは`unauthorized_client`、未登録callback portは
  `redirect_mismatch`で拒否された。
- 一方、regional issuerのOIDC discoveryは引き続き
  `code_challenge_methods_supported`と`registration_endpoint`を公開せず、custom
  scopeも`scopes_supported`へ掲載しなかった。EgressViewの実OAuth verifierは
  `Authorization Server Metadata does not advertise PKCE S256`でfail-closedした。

トークン発行、resource binding、rotation、失効は要件を満たすため、Cognitoを
厳格MCP metadata profileには適合しない条件付き第一候補とする。compatibility
profileは完全一致するCognito issuerのfield欠落だけを許容し、公開前にPKCE S256の
wire証跡とclient version付き試験を要求する。metadata proxy、PKCE無効化、JWT検証
緩和は行わない。試験用poolとdomainは削除し、既存pool、EC2、DNS、ALB、
Security Group、EgressView設定は変更していない。

### 初回実測（2026-07-26）

既存の無関係なAmplify user poolは変更・流用しなかった。自己登録を無効化した
tag付きP2-60専用poolを一時作成し、次の試験後に削除した。

1. managed login domain、URL形式resource server、`network.read` /
   `notes.write` scope、secretなしpublic clientを作成した。
2. clientはAuthorization Codeだけ、完全一致localhost callback、access token
   5分、refresh token rotation、rotation grace period 0秒に固定した。
3. domain付き新規poolの公開OIDC discoveryにも
   `code_challenge_methods_supported`と`registration_endpoint`がなかった。
   managed login domain自身の`/.well-known/openid-configuration`は404で、
   discoveryはregional issuer pathから提供された。
4. 同じ無効authorization code requestは`resource`なし・ありの両方で
   `invalid_grant`となった。無効refresh token + `resource`も`invalid_grant`だった。
   Cognitoはgrant検証前にparameter自体を拒否しないが、このnegative testだけでは
   正常発行tokenへのbindingを証明しない。
5. implicit `response_type=token`は`unauthorized_client`で拒否され、
   code-only client gateは成功した。
6. test userと有効tokenは作成していない。managed login domainとuser poolを
   削除し、最終listで検証poolが残っていないことを確認した。

MCP Authorization 2025-11-25はPKCE metadata fieldがない場合、clientへ認可中止を
要求する。この初回結果は厳格profileで失敗しており、後から追加したcompatibility
profileも仕様上の判定自体は変更しない。

AWS Documentation MCPでも、AWSが`resource`を`/oauth2/authorize`で説明する一方、
`/oauth2/token`のparameter一覧には含めていないことを確認した。ただし、文書に
ないことは未知parameterを拒否する証明にはならない。また、AWSはPKCEでS256だけを
対応すると明記するが、MCP必須のdiscovery JSON fieldは明記していない。この2点は
実測gateのままとする。

Kiro設定内に見つかったaccount操作型AWS MCP entryはactiveではなく、proxy
executableも存在しなかった。AWS Documentation MCPを一次資料調査に、認証済み
AWS CLIを一時検証に使用した。有効tokenは発行せず、検証resourceは全て削除した。

## 運用判断

port 3010はまだ公開しない。CognitoをDNS非公開stagingで先に試し、対応client
versionごとにcompatibility証跡を要求する。合格時はCognitoを採用し、不合格時は
Keycloak fallbackを構築して単一resourceのRFC 8707例外を記録する。どちらも
P2-60 gate完了前にDNSを公開しない。

## 一次資料

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
