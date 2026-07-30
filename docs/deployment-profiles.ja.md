# Deployment profile

> [English](deployment-profiles.md)

EgressViewは、収集、SQLite、browser、REST、MCPのdomain logicを特定cloudから
分離します。AWS、他CSP、オンプレミスでも同じapplicationとDB schemaを使用します。
Load balancer、公開DNS、WAF、IdPはruntime必須要素ではなく、交換可能なdeployment
adapterとして扱います。

## Profile matrix

| Profile | 公開範囲 | MCP transport | 認証 | TLS | IdP | 想定outbound |
|---|---|---|---|---|---|---|
| `local-stdio` | local process/private API | stdio | scoped EgressView API identity | stdioには不要。API経路を保護 | なし | private EgressView API、任意の内部DNS |
| `private-http` | LAN/VPN/private subnet限定 | HTTP | 専用MCP token + scoped API identity | loopback以外は必須 | なし | private EgressView API、任意の内部DNS |
| `private-oauth` | LAN/VPN/private subnet限定 | HTTP | OAuth/OIDC scope + scoped service identity | 必須。内部CAを利用可能 | 内部OIDC provider | 内部issuer/JWKS、EgressView API |
| `public-oauth` | 審査済みproxy経由のInternet | HTTP | OAuth/OIDC scope + scoped service identity | public trust TLS必須 | OIDC provider | issuer/JWKS、EgressView API |

MCP processの`EGRESSVIEW_DEPLOYMENT_PROFILE`へ上記4値のいずれかを設定します。
未設定時は互換性のため、stdioを`local-stdio`、HTTP token modeを
`private-http`、HTTP OAuth modeを`public-oauth`と推定します。明示profileが
`MCP_PORT`または`MCP_AUTH_MODE`と矛盾する場合、MCP endpoint起動前に停止します。

Phase 1でprivate HTTPのcontrolを強制します。HTTPは既定で`127.0.0.1`へbind
します。非loopbackの`MCP_BIND_ADDRESS`は、deployment profileを明示し、かつ
`MCP_ALLOW_NON_LOOPBACK=true`を設定した場合だけ許可します。名前解決によって
公開範囲が変わることを避けるためhostnameは拒否します。全HTTP profileで、
`network.read`と`notes.write`だけを持つ専用`MCP_SERVICE_TOKEN`、append-only
監査、rate・同時実行上限、body上限、request/API timeoutを使用します。
endpoint token、service identity、監査鍵、管理tokenは別々の値にします。

Application自体は平文HTTPを提供するため、非loopback経路はTLS reverse proxy
または同等の信頼できるprivate transportと、firewall、security group、
network policyで保護します。bindの明示承認はnetworkの安全性を保証しません。
外向き通信を保証付きで止めるoffline switchとfrontend assetのself-hostは
Phase 2です。それらのgate完了前に「air-gapped対応済み」と表記しません。

内部CAを使う場合、保護したPEM trust bundleを`NODE_EXTRA_CA_CERTS`へ指定して
Nodeを起動し、各MCP clientのtrust storeにも同じCAを登録します。CA配布の代わりに
TLS certificate検証を無効化しません。

## Threat modelと必須control

| Boundary | 主な脅威 | 必須control |
|---|---|---|
| Local stdio | 悪意あるlocal process、API identity漏洩 | OS account分離、mode `0600`のclient設定、scoped identity、rotation |
| Private network | LAN侵害、token盗聴、意図しないroute公開 | loopback外のTLS、firewall/VPN、専用credential、最小権限、監査、rate/timeout上限 |
| Private OAuth | 内部IdP侵害、内部CA誤用、stale token | PKCE S256、issuer/audience/resource完全一致、内部CAの安全な配布、短命access token、refresh replay対策 |
| Public OAuth | Internet scan、credential replay、DoS、proxy迂回 | 公開gate、public TLS、OAuth、WAF/proxy上限、application direct ingress禁止、append-only監査、rollback |
| Offline runtime | CDN、enrichment、cloud AI、updateからの隠れたegress | asset同梱、outbound deny、local agent/model、egress遮断integration test |

Private networkも既定では信頼しません。private HTTPでbrowser管理tokenを流用せず、
平文LANへBearer tokenを送信しません。`0.0.0.0`へのbindはprivateである証拠に
ならないため、firewall、security group、network policy、proxy境界も検証します。

## 外部依存matrix

| 機能 | 現在のInternet依存 | Private代替 | Offline目標 |
|---|---|---|---|
| Router収集とSQLite | なし | 同じruntime | 対応 |
| MCP stdio/private HTTP | install後はなし | private API、任意の内部TLS | local MCP clientで対応 |
| Browser graph library/world map | public D3/jsDelivr asset | self-host asset | Phase 2 |
| Reverse DNS | resolver依存 | 内部DNS | 任意 |
| RDAP、threat feed、OUI更新 | public service | 必要なら管理mirror | 状態を表示して無効化 |
| Browser OIDC | 現行の任意機能はGoogle | local管理者、将来の汎用内部OIDC | local管理者 |
| MCP OAuth | issuer依存でCSP非依存 | self-host OIDC + 内部CA | issuer/JWKSが全て内部ならprivate OAuth |
| AI Insights | Ollamaまたはcloud provider | Ollama/private互換endpoint | local modelのみ |
| Package/image更新 | package/image registry | 内部mirror | Phase 4で署名済みbundle、checksum、lock、SBOM |

Claude CodeやGitHub Copilot等のcloud agentは、MCP endpointがprivateでもagent自身の
Internet接続を必要とします。完全閉域ではMCP対応local agentとOllama等のlocal
modelを使用します。

## AWS mapping

週末に予定しているAWS構成は`public-oauth` profileの実装であり、別editionでは
ありません。

- 既存EC2でEgressViewとloopback MCP processを実行
- ECS Fargate + RDS PostgreSQLで選定したKeycloakを実行
- ALB + ACMでTLS終端
- WAFとproxy上限でpublic boundaryを保護
- Route 53で`www`、`mcp`、`auth`を管理
- Security GroupでEgressView/MCPへのInternet direct ingressを禁止

同じapplicationをオンプレミスのreverse proxy・内部Keycloak、または他CSPの同等
serviceでも利用できます。AWS構築はMCP protocol/publication gate完了まで
`publishDns=false`を維持します。

## オフラインモード

エアギャップ環境や外向き通信を遮断した環境では `EGRESSVIEW_OFFLINE_MODE=true` を設定します。有効化されるのは正確に `true` の場合だけです。綴り間違いで「隔離されているつもり」の状態が生まれないようにしています。

保証するのは「外向きリクエストを**試行しない**」ことであり、「失敗する」ことではありません。実行してタイムアウトさせる方式では、パケットは出てしまい、EgressViewの稼働が外部に伝わり、タイムアウト分だけ起動も遅れます。そのため各機能は、通信を行うモジュールが組み立てられる前に判定されます。クラウドプロバイダのSDK clientも生成しないので、認証情報の解決も接続の確立も発生しません。

### 起動前に無効化されるもの

RDAP、GeoIP、脅威フィード、WiresharkのOUIベンダーデータベース、手動脅威調査、Google OIDC、Anthropic / OpenAI / Bedrock の各AIプロバイダ。

### 影響を受けないもの

ルーターのSSH収集、SQLiteの保存とmigration、Web UI、stdio および private HTTP のMCP。いずれも定義上ローカルで完結します。

### 明示設定時のみ許可されるもの

| 機能 | 有効化する変数 |
|---|---|
| 内部DNS / PTR | `EGRESSVIEW_INTERNAL_DNS` |
| 自己ホストのOllama | `EGRESSVIEW_OLLAMA_URL` |
| 内部OIDC issuer | `EGRESSVIEW_INTERNAL_OIDC_ISSUER` |

これらは隔離網の内部で到達可能な場合がありますが、**接続先を指定するまでは無効のまま**です。「内部にある」というのは運用者のネットワークについての主張であり、EgressView側では検証できないため、前提にしません。

### 失われる機能

通信先の組織名・国・座標が表示されず、脅威判定は既にキャッシュ済みの情報だけで行われ、未知のMACプレフィックスにはベンダー名が付きません。既存のキャッシュはそのまま利用でき、更新が止まるだけです。

起動ログに無効化した機能が列挙されます。`GET /api/config/status` も同じ状態を返すため、UIは空欄を放置せず「オフラインモードのため無効」と説明できます。

### フロントエンドのasset

D3、TopoJSON、world atlasは固定版を同一オリジンから配信し、CSPは外部オリジンを一切許可しません。オフラインモードでのページ読み込みで外部リクエストは発生しません。
