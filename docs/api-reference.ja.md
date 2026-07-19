# EgressView REST API リファレンス

> [English](api-reference.md)

EgressViewは、Web UIとローカル自動化向けに管理APIを提供します。現時点ではバージョン固定された公開互換APIではないため、外部連携を更新する前にリリースノートを確認してください。

## ベースURLと認証

Web UIをサブパスで公開している場合も、APIは常に`/api`配下です。後述する2つの公開認証APIを除き、すべてのリクエストで`X-Admin-Token`ヘッダーにadmin tokenまたはブラウザのsession tokenを指定します。

```bash
export EGRESSVIEW_URL='https://egressview.example.net'
export EGRESSVIEW_TOKEN='replace-with-your-admin-token'

curl --fail-with-body \
  -H "X-Admin-Token: $EGRESSVIEW_TOKEN" \
  "$EGRESSVIEW_URL/api/status"
```

ネットワーク境界を越える場合はHTTPSまたは信頼できるVPNを使用してください。tokenをURL、ログ、ソースコードへ書かないでください。JSON request bodyの上限は64 KBです。

### パスワードログイン

`POST /api/auth/login`は公開APIで、UIパスワードを失効可能なsession tokenへ交換します。パスワードは最大256文字です。同じクライアントから10分間に5回失敗すると、5分間ロックされます。

```bash
curl --fail-with-body \
  -H 'Content-Type: application/json' \
  -d '{"password":"replace-with-your-password"}' \
  "$EGRESSVIEW_URL/api/auth/login"
```

```json
{"success":true,"token":"session-token","expiresAt":1784304000000}
```

`POST /api/admin/verify`も公開APIで、request body内のtokenを検証します。それ以外はすべて認証必須です。

## 共通仕様

- 時刻はUnix epoch millisecondです。個別の指定がない限り、空の`from`/`to`は期間の始端/終端を制限しません。
- 成功時のJSONは`application/json`、エラーは原則として`{ "error": "message" }`です。
- 主なstatus codeは、入力不正`400`、認証失敗`401`、対象なし`404`、upload過大`413`、内部処理・永続化失敗`500`、router検出失敗`502`、認証初期化前`503`です。
- Router一覧APIは、パスワード、enable password、host fingerprint、admin tokenを返しません。
- MCPは別プロトコルです。MCP clientからREST APIを直接使わず、[MCP設定ガイド](setup-mcp.ja.md)を参照してください。

## 通信履歴

### 通信履歴一覧

`GET /api/connections`

| Query | 内容 |
|---|---|
| `from`, `to` | 任意のepoch millisecond期間。 |
| `limit`, `offset` | ページング。`limit`は最大1,000。互換用の未ページング形式は最大50,000行で`truncated`を返し、グラフは`/api/connections/summary`を使用します。 |
| `sort` | `lastSeen`, `src`, `dst`, `dport`, `proto`, `country`, `org`。既定値は`lastSeen`。 |
| `sortDir` | `asc`または`desc`。既定値は`desc`。 |
| `fSrc`, `fDst`, `fDport`, `fProto`, `fCountry`, `fOrg` | Server-side filter。末尾に`Mode`を付け、`contains`, `startsWith`, `endsWith`, `exact`を指定できます。 |
| `fSrcMac` | 送信元MACの完全一致。 |
| `fThreat` | `safe`, `warn`, `danger`。 |

```bash
curl --fail-with-body \
  -H "X-Admin-Token: $EGRESSVIEW_TOKEN" \
  "$EGRESSVIEW_URL/api/connections?from=1784217600000&limit=100&sort=lastSeen&sortDir=desc"
```

Responseには`connections`, `total`, `limit`, `offset`, `serverTime`が含まれます。各connectionには端末情報、接続先の付加情報、`firstSeen`, `lastSeen`, 互換用`source`, 観測したrouter IDの`observedBy`、任意の`threat`が含まれます。

### 集計・セキュリティ表示

- `GET /api/connections/summary`は`from`, `to`, 任意の`src`、1から240の`buckets`（既定60）を受け取ります。
- `GET /api/connections/new-nodes`は期間内に新しく観測した送信元・接続先を返します。
- `GET /api/connections/threat-connections`は`confidence=low|high|all`と最大200の`limit`を受け取ります。
- `GET /api/connections/threat-counts`は`safe`, `warn`, `danger`の件数を返し、標準filterを使用できます。
- `GET /api/connections/memory`はmemory上のworking set統計を返します。

### CSV / JSON export

`GET /api/connections/export`では`format=csv|json`と`from`が必須で、`to`省略時は現在時刻です。

```bash
curl --fail-with-body \
  -H "X-Admin-Token: $EGRESSVIEW_TOKEN" \
  "$EGRESSVIEW_URL/api/connections/export?format=csv&from=1784217600000" \
  -o connections.csv
```

1,000行単位でstreamし、最大50,000行、timeoutは60秒です。`X-Export-Total`, `X-Export-Count`, `X-Export-Truncated`を確認してください。CSVはUTF-8 BOM付きでspreadsheet formula injectionを防ぎます。JSONは`meta`と`connections`を返します。

## Router

EgressViewには、Yamaha/Ciscoを混在して最大10台登録できます。

- `GET /api/routers`は機密情報を除く設定と実行状態を返します。
- `POST /api/routers/detect`は保存前の定義で接続し、LAN/NAT情報または`502`の診断情報を返します。
- `POST /api/routers`はrouterを作成し、`201`を返します。
- `PUT /api/routers/:id`はrouterを更新します。`kind`と安定したrouter IDは変更できません。
- `DELETE /api/routers/:id`は有効設定から削除しますが、過去の観測はtombstone化したIDへ帰属したままです。

作成・検出bodyでは`kind`（`yamaha`または`cisco`）、`displayName`, `ip`, `user`, `pass`, `enabled`を使います。Yamahaは`nat`、Ciscoは任意の`enablePass`も使用します。更新時にpasswordを省略すると保存済みの値を維持します。

## 端末とメモ

- `GET /api/devices`は`includeArchived=1`を受け取り、識別情報、状態、IPv6 address、メモを返します。
- `GET /api/devices/merge-candidates`は`status=pending|approved|rejected|all`を受け取ります。
- `POST /api/devices/merge`は`{ "keepId": "...", "dropId": "..." }`を使います。
- `POST /api/devices/reject`は`{ "id": "..." }`を使います。
- `POST /api/devices/archive`と`POST /api/devices/unarchive`は`{ "deviceId": "..." }`を使います。
- `GET /api/notes`はメモを取得します。`POST /api/notes`は最大500文字のメモを保存し、`POST /api/notes/draft`は設定済みのassistant連携で下書きを作成します。

## Backupとrestore

- `GET /api/backup/list`はgenerationと保持設定を返します。
- `POST /api/backup/create`は整合性のあるSQLite snapshotを作成・検証します。
- `GET /api/backup/download/:name`は指定generationをdownloadします。
- `POST /api/backup/restore`は`{ "name": "..." }`を使います。
- `POST /api/backup/upload`はmultipartではなく、最大100 MBのSQLite fileをraw bodyで受け取ります。
- `POST /api/backup/config`は正の`intervalHours`と`maxGenerations`を受け取ります。

## AIプロバイダー設定

AI洞察はローカル集計を常時表示し、利用者が明示的に実行した場合だけ、通信先IP・ホスト名・端末名・MACと接続の集計情報を設定済みのAI providerへ送信します。パスワード等の認証情報は送信しません。

- `GET /api/config/ai`は選択中provider、モデルID、Ollama endpoint、AWS `region`、キー設定済み・同意済みフラグを返します。APIキー値は返しません。
- `POST /api/config/ai`は`provider`（`disabled`、`ollama`、`anthropic`、`openai`、`bedrock`）、provider別`models`、`ollamaEndpoint`、Bedrock用`region`、任意のcloud `keys`と`clearKeys`を受け付けます。外部送信を伴うprovider（`anthropic`、`openai`、`bedrock`）選択時はprovider別`cloudConsent: true`が必須です。Bedrockはキーを保存せず、認証はAWS SDKのdefault credential chainに委譲します。`models.bedrock`は基盤モデルID、cross-region推論プロファイルID（`global`/`us`/`eu`/`apac`/`jp`/`au`）、またはARN（最大400文字）を受け付けます。任意の`guardrail`（`{ enabled, id, version }`）でBedrock Guardrailを有効化でき、有効時はConverseの`guardrailConfig`へ渡します（`bedrock:ApplyGuardrail`が必要）。Guardrailは日本内処理を保証しない点に注意（`docs/setup-bedrock.ja.md`参照）。
- `POST /api/ai/models`はBedrockの`region`を受け取り、推論を実行せずに最大200件のモデル・推論プロファイルIDを取得します。設定画面のgeo変更時の候補更新に使います。
- `POST /api/ai/guardrails`はBedrockの`region`を受け取り、推論を実行せずにそのリージョンのGuardrail（id・名前・バージョン）を一覧します。fail-open で、`bedrock:ListGuardrails`権限が無い場合は空を返し、設定画面は手入力にフォールバックします。
- `POST /api/ai/test`は空のJSON objectを受け付けます。fetch系providerは保存済み設定で最大200件のモデルIDを取得します（timeout 10秒、応答上限1MB）。Bedrockはfail-openのmodel discoveryに加え、`bedrock:InvokeModel`権限を確認するため固定の短い文をConverseへ送信します（通信・端末・脅威データは送信しません）。
- `GET /api/ai/facts`はepoch millisecondsの`from`が必須で、`to`は任意です。接続、端末、宛先、脅威レベルについて、選択期間と直前の同一期間の件数、およびcredentialを含まないrouter収集状態を返します。期間上限は14日で、AI providerへは送信しません。
- `POST /api/ai/analyze`は`from`と任意の`to`を受け付け、内部IP、MAC、端末名、router管理情報、raw logを除いた集計を選択providerへ送信します。外部送信を伴うprovider（Anthropic/OpenAI/Bedrock）では保存済み同意に加えて要求ごとの`cloudConsentConfirmed: true`が必須です。期間上限は14日、timeoutは30秒、サーバー全体の同時分析は1件です。
- `POST /api/ai/chat`は最大4,000文字の`message`、期間、任意の`conversationId`と`requestId`を受け付けます。user行をAI呼び出し前にv6 SQLiteへ追記し、完了後にassistant行、失敗時は本文を含まない失敗行を追記します。同じ`requestId + role`は重複しません。
- `GET /api/ai/conversations`は最大100会話と保存件数・本文bytesを返します。`GET /api/ai/conversations/:id`は最大500メッセージを追記順に返し、`DELETE /api/ai/conversations/:id`だけが会話を明示削除します。再起動や設定変更で既存行を更新・truncateしません。

providerは初期状態で無効です。Anthropic/OpenAIは固定の公式API endpointを使い、任意HTTP(S) endpointを設定できるのはOllamaだけです。BedrockはリージョンとConverse APIを使い、認証はAWS SDKのdefault credential chainに委譲します（キー入力・保存なし）。Bedrock対応は通常依存（`@aws-sdk/client-bedrock-runtime`と`@aws-sdk/client-bedrock`）として同梱され、追加インストールは不要です。詳細は`docs/setup-bedrock.ja.md`を参照してください。

Restoreはfail-closedです。復元元の検査、安全backup成功の確認、restore、全DB利用者の再接続、復元後検査を行い、失敗時はrollbackします。成功後は既存のbrowser sessionを失効します。

## Endpoint一覧

実装済みREST API 66本の全一覧です。**公開**以外はすべて`X-Admin-Token`が必要です。

| 分類 | Methodとpath | Access |
|---|---|---|
| 認証 | `POST /api/auth/login` | 公開 |
| 認証 | `POST /api/admin/verify` | 公開 |
| 認証 | `POST /api/auth/logout` | 認証必須 |
| 認証 | `GET /api/auth/sessions` | 認証必須 |
| 認証 | `POST /api/auth/sessions/:id/revoke` | 認証必須 |
| 認証 | `POST /api/auth/sessions/revoke-all` | 認証必須 |
| 認証 | `POST /api/auth/change-password` | 認証必須 |
| 認証 | `POST /api/admin/regenerate-token` | 認証必須 |
| Router初期設定 | `POST /api/nonce` | 認証必須 |
| Router初期設定 | `POST /api/yamaha/detect` | 認証必須 |
| Router初期設定 | `POST /api/cisco/detect` | 認証必須 |
| Router初期設定 | `POST /api/login` | 認証必須、旧setup flow |
| Router | `GET /api/routers` | 認証必須 |
| Router | `POST /api/routers/detect` | 認証必須 |
| Router | `POST /api/routers` | 認証必須 |
| Router | `PUT /api/routers/:id` | 認証必須 |
| Router | `DELETE /api/routers/:id` | 認証必須 |
| 通信 | `GET /api/connections` | 認証必須 |
| 通信 | `GET /api/connections/memory` | 認証必須 |
| 通信 | `GET /api/connections/summary` | 認証必須 |
| 通信 | `GET /api/connections/new-nodes` | 認証必須 |
| 通信 | `GET /api/connections/threat-connections` | 認証必須 |
| 通信 | `GET /api/connections/threat-counts` | 認証必須 |
| 通信 | `GET /api/connections/export` | 認証必須 |
| 端末 | `GET /api/devices` | 認証必須 |
| 端末 | `GET /api/devices/merge-candidates` | 認証必須 |
| 端末 | `POST /api/devices/merge` | 認証必須 |
| 端末 | `POST /api/devices/reject` | 認証必須 |
| 端末 | `POST /api/devices/archive` | 認証必須 |
| 端末 | `POST /api/devices/unarchive` | 認証必須 |
| メモ | `GET /api/notes` | 認証必須 |
| メモ | `POST /api/notes` | 認証必須 |
| メモ | `POST /api/notes/draft` | 認証必須 |
| Backup | `GET /api/backup/list` | 認証必須 |
| Backup | `POST /api/backup/create` | 認証必須 |
| Backup | `GET /api/backup/download/:name` | 認証必須 |
| Backup | `POST /api/backup/restore` | 認証必須 |
| Backup | `POST /api/backup/upload` | 認証必須 |
| Backup | `POST /api/backup/config` | 認証必須 |
| 全般設定 | `GET /api/status` | 認証必須 |
| 全般設定 | `POST /api/config/general` | 認証必須 |
| Data source | `GET /api/config/datasources` | 認証必須 |
| Data source | `POST /api/config/datasources` | 認証必須 |
| Slack | `GET /api/config/slack` | 認証必須 |
| Slack | `POST /api/config/slack` | 認証必須 |
| 手動脅威調査 | `GET /api/config/manual-threat` | 認証必須。APIキー値は返さず設定済みかだけ返す |
| 手動脅威調査 | `POST /api/config/manual-threat` | 認証必須。APIキー、cache、provider別cooldownを保存 |
| 手動脅威調査 | `POST /api/threat/manual-lookup` | 認証必須。明示操作で公開IP 1件を選択providerへ送信 |
| AI設定 | `GET /api/config/ai` | 認証必須。APIキー値は返さず設定済みかだけ返す |
| AI設定 | `POST /api/config/ai` | 認証必須。provider、model、endpoint、cloud APIキーを保存 |
| AI設定 | `POST /api/ai/models` | 認証必須。推論せずBedrockのモデル・推論プロファイルIDを取得 |
| AI設定 | `POST /api/ai/guardrails` | 認証必須。推論せずBedrockのGuardrailを取得（fail-open） |
| AI設定 | `POST /api/ai/test` | 認証必須。通信データを送らずモデルIDを取得 |
| AI洞察 | `GET /api/ai/facts` | 認証必須。local factsと直前期間比較のみ |
| AI洞察 | `POST /api/ai/analyze` | 認証必須。通信先IP・ホスト名・端末名・MACと接続集計を選択providerで手動分析。cloudは二重同意必須 |
| AI対話 | `POST /api/ai/chat` | 認証必須。質問を先に追記し、回答または失敗行をappend-only保存 |
| AI対話 | `GET /api/ai/conversations` | 認証必須。会話一覧と保存量 |
| AI対話 | `GET /api/ai/conversations/:id` | 認証必須。再起動後も残るメッセージ履歴 |
| AI対話 | `DELETE /api/ai/conversations/:id` | 認証必須。会話単位の明示削除 |
| Slack | `POST /api/slack/test` | 認証必須 |
| Slack | `POST /api/slack/verify` | 認証必須 |
| Slack | `POST /api/slack/lookup-user` | 認証必須 |
| 検出ログ | `GET /api/notification-log` | 認証必須 |
| Beacon | `GET /api/beacons` | 認証必須 |
| Beacon | `GET /api/beacons/config` | 認証必須 |
| Beacon | `POST /api/beacons/config` | 認証必須 |
| Beacon | `POST /api/beacons/:id/dismiss` | 認証必須 |
