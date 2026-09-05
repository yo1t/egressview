# EgressView REST API リファレンス

> [English](api-reference.md)

EgressViewは、Web UIとローカル自動化向けに管理APIを提供します。現時点ではバージョン固定された公開互換APIではないため、外部連携を更新する前にリリースノートを確認してください。

## ベースURLと認証

Web UIをサブパスで公開している場合も、APIは常に`/api`配下です。認証必須requestは従来の`X-Admin-Token`、同じheaderへ指定するscoped API identity token、またはHttpOnly browser session cookieを受け付けます。cookie認証による更新requestでは対応する`X-CSRF-Token`も必要です。

scoped API identityは`GET` / `POST /api/auth/api-identities`と`POST /api/auth/api-identities/:id/revoke`で管理し、いずれも`auth.admin`が必要です。作成時はlabel、空でないpermission一覧、1分以上1年以下の`expiresInMs`を指定します。平文の`egv_...` tokenを返すのは`201`作成responseだけで、DBにはSHA-256 hashだけを保存します。identity管理responseには`Cache-Control: no-store`を付けます。

Macおよび将来のendpoint Agentは、browser/API/MCPとは別のcredential境界を使います。登録は3段階で、**どの1段階も単独ではcredentialを生みません**。管理者が`POST /api/agents/enrollment-tokens`で英数字6文字・10分有効のcodeを発行します。Agentは`POST /api/agent/enrollment-requests`で申請し、返るのはclaim secretと**承認待ちの申請**であってtokenではありません。管理者が`POST /api/agents/enrollment-requests/:requestId/approve`で承認した後、Agentは`POST /api/agent/enrollment-requests/claim`から`egva_...` bearerを一度だけ受け取ります。codeは5回失敗で失効し、未承認の申請は10分で失効します。bearerはmacOS Keychainへ保存し、Hubはpepper付きhashだけを保持します。このcredentialが持つのは`agent.ingest`だけで、browser/admin/MCP routeには使えず、token rotation、ingest、`POST /api/agent/registration/revoke`だけが受け付けます。最後のrouteは、そのbearerで認証されたAgent自身だけを失効でき、別のAgentは指定できません。ingestは非圧縮JSON 512 KiB・最大200観測で、1 batchをtransaction保存し、同じAgent/batch IDの再送には元のACKを返します。上限はAgent単位30 requests/minute、Hub全体で同時4件です。Agent一覧、集約ingest metrics、管理者による失効には`auth.admin`が必要です。Agent responseはcacheせず、登録codeは再表示せず、HTTPはloopback開発環境だけで許可します。

`GET /api/auth/api-identities/self`は、現在認証中のscoped identity自身だけを
返し、`network.read`を要求します。browser sessionと従来のadmin tokenは
拒否します。remote MCP serverはこのAPIを使い、内部service identityの権限が
`network.read`と`notes.write`だけでない場合にfail-closedで停止します。

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

`POST /api/admin/verify`も公開APIで、request body内のtokenを検証します。認証状態・方式の取得、OIDC redirect/callback、codeで保護された`POST /api/agent/enrollment-requests`と`.../claim`入口、詳細情報を返さない`/healthz`と`/readyz`も公開します。それ以外は文書化したbrowser、API identity、またはAgent credentialが必要です。

## 共通仕様

- 時刻はUnix epoch millisecondです。個別の指定がない限り、空の`from`/`to`は期間の始端/終端を制限しません。
- すべてのresponseに`X-Request-Id`を付与します。`[A-Za-z0-9][A-Za-z0-9._:-]{0,63}`に一致する呼び出し元IDは維持し、未指定または安全でない値は生成したUUIDへ置換します。同じ安全なIDでrequest、非同期処理、slow-request、error logを関連付けます。HTTP完了logにはquery stringを含めません。
- endpointを持つ全route moduleで、request body、query、path parameterをstrictなZod境界で検証します。未知field、scalar parameterへの配列・object混入、文書化した上限を超える値は、状態を変更する前に`400`を返します。
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

- `GET /api/backup/list`は通常generation、保持設定、通常／pre-migration inventory、ディスク余力、次回migration準備状態を返します。inventoryはメタデータのみを読み、`integrity: "unchecked"`を返します。完全な整合性検査はバックアップ作成時とリストア直前に実行します。
- `POST /api/backup/create`は整合性のあるSQLite snapshotを作成・検証します。
- `GET /api/backup/download/:name`は指定generationをdownloadします。
- `POST /api/backup/restore`は`{ "name": "..." }`を使います。
- `POST /api/backup/upload`はmultipartではなく、最大100 MBのSQLite fileをraw bodyで受け取ります。owner限定の一時fileへstreamし、restore uploadは同時1件だけを許可します。重複要求には`409`を返します。
- `POST /api/backup/config`は正の`intervalHours`、2以上の`maxGenerations`、0以上の`maxBackupBytes`（`0`は上限無効）、booleanの`autoPrune`を受け取ります。自動pruneは既定で無効です。
- `POST /api/backup/prune`は`{ "execute": false }`で高速なdry-run、`{ "execute": true }`で確認済みcleanupを開始し、worker jobを含む`202`を返します。計画時は各ファイルのSQLiteヘッダー100バイトだけを読み、復元不能なファイルを保持世代数から除外し、利用可能な通常2世代とmigration 1世代を新しい順に保護します。一方が不足する場合は、もう一方の利用可能な世代で合計3世代を補います。同時実行は1件だけで、重複要求には`409`を返します。
- `GET /api/backup/prune/:jobId`はjob状態（`running`、`cancelling`、`timing_out`、`completed`、`cancelled`、`timed_out`、`failed`）、進捗、完了後の計画／結果を返します。`DELETE /api/backup/prune/:jobId`は安全なcancelを要求します。実行時は計画を再作成し、削除直前に候補の論理サイズ、割当サイズ、更新時刻、ヘッダー状態を再照合します。一時ファイルは候補にしません。完全なintegrity checkはバックアップ作成時と復元前に引き続き必須です。

## プロセスhealth

- `GET /healthz`は認証不要・cache無効のliveness確認で、Node.js event loopが応答できる場合だけ`{ "status": "ok" }`を返します。
- `GET /readyz`は認証不要・cache無効のreadiness確認です。設定とDB bootstrap完了前は`503`と`{ "status": "not_ready" }`、完了後は`200`と`{ "status": "ready" }`を返します。必須の監査storeへの書き込みが失敗すると、復旧まで詳細を限定した`503` `degraded`応答になります。router、DB path、例外文、認証情報は公開しません。

## AIプロバイダー設定

AI洞察はローカル集計を常時表示し、利用者が明示的に実行した場合だけ、通信先IP・ホスト名・端末名・MACと接続の集計情報を設定済みのAI providerへ送信します。パスワード等の認証情報は送信しません。

- `GET /api/config/ai`は選択中provider、モデルID、Ollama endpoint、AWS `region`、キー設定済み・同意済みフラグ、`selectedModelPricing`を返します。APIキー値は返しません。
- `POST /api/config/ai`は`provider`（`disabled`、`ollama`、`anthropic`、`openai`、`bedrock`）、provider別`models`、`ollamaEndpoint`、Bedrock用`region`、任意のcloud `keys`と`clearKeys`を受け付けます。外部送信を伴うprovider（`anthropic`、`openai`、`bedrock`）選択時はprovider別`cloudConsent: true`が必須です。Bedrockはキーを保存せず、認証はAWS SDKのdefault credential chainに委譲します。`models.bedrock`は基盤モデルID、cross-region推論プロファイルID（`global`/`us`/`eu`/`apac`/`jp`/`au`）、またはARN（最大400文字）を受け付けます。任意の`guardrail`（`{ enabled, id, version }`）でBedrock Guardrailを有効化でき、有効時はConverseの`guardrailConfig`へ渡します（`bedrock:ApplyGuardrail`が必要）。Guardrailは日本内処理を保証しない点に注意（`docs/setup-bedrock.ja.md`参照）。
- `POST /api/ai/models`はBedrockの`region`を受け取り、推論を実行せずに最大200件の文章生成モデル・推論プロファイルIDを取得します。文字列の`models`配列を維持したまま`modelPricing` coverageを追加します。画像・音声・embedding等の専用IDは候補から除外しますが、誤除外に備えて手入力をfallbackとして残します。
- `POST /api/ai/pricing/check`はproviderとmodel IDを受け取り、versioned catalogに標準token単価があるか返します。providerへの接続やmodel呼び出しは行いません。
- `POST /api/ai/guardrails`はBedrockの`region`を受け取り、推論を実行せずにそのリージョンのGuardrail（id・名前・バージョン）を一覧します。fail-open で、`bedrock:ListGuardrails`権限が無い場合は空を返し、設定画面は手入力にフォールバックします。
- `POST /api/ai/test`は空のJSON objectを受け付けます。fetch系providerは保存済み設定で最大200件のモデルIDを取得します（timeout 10秒、応答上限1MB）。Bedrockはfail-openのmodel discoveryに加え、`bedrock:InvokeModel`権限を確認するため固定の短い文をConverseへ送信します（通信・端末・脅威データは送信しません）。
- `GET /api/ai/facts`はepoch millisecondsの`from`が必須で、`to`は任意です。接続、端末、宛先、脅威レベルについて、選択期間と直前の同一期間の件数、およびcredentialを含まないrouter収集状態を返します。期間上限は14日で、AI providerへは送信しません。
- `POST /api/ai/analyze`は`from`と任意の`to`を受け付け、接続集計に加えて通信量優先の端末一覧（最大30台）とASUS network node要約（最大10 node、nodeごとの代表端末最大5台）を送信します。通信先/端末IP、hostname、端末名、MAC、vendor、IPv6、初回/最終観測、収集元、状態、件数を含み得ます。認証情報、端末メモ、archive済み端末、router/node管理IP、raw logは送信しません。外部送信を伴うprovider（Anthropic/OpenAI/Bedrock）では保存済み同意に加えて要求ごとの`cloudConsentConfirmed: true`が必須です。期間上限は14日、timeoutは30秒、サーバー全体の同時分析は1件です。
- `GET /api/ai/usage/monthly`はbrowserの`timezoneOffset`（分）を受け取り、現地暦の今月・先月について呼び出し回数とtoken合計を返します。応答の`pricing`にはcatalog version、基準日、根拠URLを含みます。`pricedTokens`、`unpricedTokens`、model別`unpricedModels`により、概算USDが価格確認済み分だけの部分合計である場合を明示します。成功したOllama / Anthropic / OpenAI / Bedrock呼び出しはprovider/modelと呼び出し時点の価格表version・単価をv7 SQLiteへ追記するため、料金表更新後も過去月を再計算しません。未知model料金の`unknownPriceRequests`とproviderがusageを返さなかった`usageMissingRequests`を区別し、0 USDと誤表示しません。Bedrock Guardrailsなどの追加料金は含みません。会話履歴取得時はassistant回答へ同じrequest IDの`usageInputTokens` / `usageOutputTokens` / `usageTotalTokens` / `estimatedCostUsd` / `pricingVersion`を付加し、記録開始前の履歴はprovider/modelとnullのusageだけを返します。UIは英語で`$`、日本語で明示的な`USD`表記を使い、為替換算しません。
- `GET /api/ai/pricing/diagnostics`は`timezoneOffset`を受け取り、選択中modelのcatalog状態と今月・先月の未価格model別usageを返します。model IDと使用量だけを扱い、APIキー、prompt、通信内容は公開しません。
- `POST /api/ai/chat`は最大4,000文字の`message`、期間、任意の`conversationId`と`requestId`を受け付けます。user行をAI呼び出し前にv6 SQLiteへ追記し、完了後にassistant行、失敗時は本文を含まない失敗行を追記します。同じ`requestId + role`は重複しません。
- 全生成経路はprovider呼び出し前にUTC日単位の永続budgetを予約します。principal/providerごとのrequest・記録token上限の既定値は`.env.example`に記載し、到達時は`429`、provider失敗もrequest 1回として記録します。
- `GET /api/ai/conversations`は最大100会話と保存件数・本文bytesを返します。`GET /api/ai/conversations/:id`は最大500メッセージを追記順に返し、`DELETE /api/ai/conversations/:id`だけが会話を明示削除します。再起動や設定変更で既存行を更新・truncateしません。

providerは初期状態で無効です。Anthropic/OpenAIは固定の公式API endpointを使い、任意HTTP(S) endpointを設定できるのはOllamaだけです。BedrockはリージョンとConverse APIを使い、認証はAWS SDKのdefault credential chainに委譲します（キー入力・保存なし）。Bedrock対応は通常依存（`@aws-sdk/client-bedrock-runtime`と`@aws-sdk/client-bedrock`）として同梱され、追加インストールは不要です。詳細は`docs/setup-bedrock.ja.md`を参照してください。

Restoreはfail-closedです。復元元の検査、安全backup成功の確認、restore、全DB利用者の再接続、復元後検査を行い、失敗時はrollbackします。成功後は既存のbrowser sessionを失効します。

## Endpoint一覧

実装済みHTTP endpoint 101本の全一覧です。**公開**以外は従来またはscopedの`X-Admin-Token` credential、browserのHttpOnly session cookie、または明記されたAgent bearerが必要です。cookie認証による更新要求では`X-CSRF-Token`も必要です。

| 分類 | Methodとpath | Access |
|---|---|---|
| 認証 | `POST /api/auth/login` | 公開 |
| 認証 | `POST /api/admin/verify` | 公開 |
| 認証 | `GET /api/auth/status` | 公開 |
| 認証 | `GET /api/auth/methods` | 公開 |
| 認証 | `GET /api/auth/oidc/start` | 公開 |
| 認証 | `GET /api/auth/oidc/callback` | 公開 |
| 認証 | `POST /api/auth/logout` | 認証必須 |
| 認証 | `GET /api/auth/sessions` | 認証必須 |
| 認証 | `POST /api/auth/sessions/:id/revoke` | 認証必須 |
| 認証 | `POST /api/auth/sessions/revoke-all` | 認証必須 |
| 認証 | `POST /api/auth/change-password` | 認証必須 |
| 認証 | `POST /api/admin/regenerate-token` | 認証必須 |
| 認証 | `GET /api/auth/security-config` | 認証必須 |
| 認証 | `POST /api/auth/security-config` | 認証必須 |
| 認証 | `POST /api/auth/oidc/test` | 認証必須 |
| 認証 | `GET /api/auth/api-identities` | 認証必須 |
| 認証 | `POST /api/auth/api-identities` | 認証必須 |
| 認証 | `POST /api/auth/api-identities/:id/revoke` | 認証必須 |
| 認証 | `GET /api/auth/audit-events` | 認証必須 |
| Agent | `POST /api/agents/enrollment-tokens` | `auth.admin`必須。登録codeを一度だけ返す |
| Agent | `POST /api/agent/enrollment-requests` | 公開。6文字codeで申請する。**tokenは返らない** |
| Agent | `POST /api/agent/enrollment-requests/claim` | 公開。承認後にtokenを一度だけ受け取る |
| Agent | `GET /api/agents/transport` | `auth.admin`必須。暗号化の有無と、平文の場合に露出する内容を返す |
| Agent | `POST /api/agents/transport` | `auth.admin`必須。平文通信の承諾を記録する |
| Agent | `GET /api/agents/enrollment-requests` | `auth.admin`必須。承認待ち一覧 |
| Agent | `POST /api/agents/enrollment-requests/:requestId/approve` | `auth.admin`必須。承認してtokenを発行する |
| Agent | `POST /api/agents/enrollment-requests/:requestId/reject` | `auth.admin`必須。申請を却下する |
| Agent | `GET /api/agents` | `auth.admin`必須。credential hashは返さない |
| Agent | `GET /api/agents/ingest-metrics` | `auth.admin`必須。集約counterと上限だけを返す |
| Agent | `POST /api/agents/:agentId/revoke` | `auth.admin`必須 |
| Agent | `POST /api/agent/token/rotate` | Agent bearerの`agent.ingest`だけ |
| Agent | `POST /api/agent/registration/revoke` | Agent bearer。認証されたAgent自身だけを失効 |
| Agent | `POST /api/agent/ingest` | Agent bearerの`agent.ingest`。最大200観測・非圧縮JSON 512 KiB |
| Agent | `GET /api/agent/capabilities` | Agent bearerの`agent.ingest`。受理するschema versionとbatch上限を返し、Agentが双方の話せるversionを選べるようにする |
| Agent | `GET /api/agent/geo-cache` | Agent bearerの`agent.ingest`。位置キャッシュを全件返す。**Agentは宛先を送らない** — 絞り込みは「どの宛先に関心があるか」を伝えることになるため。`ETag`/`304`に対応 |
| Agent | `GET /api/agent/threat-intel` | Agent bearerの`agent.ingest`。脅威指標を全件返す。**Agentは宛先を送らない** — 「危ないか」を尋ねるために宛先を送ると、何を気にしているかを相手に伝えることになるため。フィード未設定のHubでは`available: false`を返し、Agentはこれを**「脅威が無い」と読んではならない**。`ETag`/`304`に対応 |
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
| Backup | `POST /api/backup/prune` | 認証必須 |
| Backup | `GET /api/backup/prune/:jobId` | 認証必須 |
| Backup | `DELETE /api/backup/prune/:jobId` | 認証必須 |
| Process health | `GET /healthz` | 認証不要。最小livenessのみ |
| Process health | `GET /readyz` | 認証不要。最小readinessのみ |
| 全般設定 | `GET /api/status` | 認証必須 |
| 全般設定 | `POST /api/config/general` | 認証必須 |
| Data source | `GET /api/config/datasources` | 認証必須 |
| Data source | `POST /api/config/datasources` | 認証必須 |
| Slack | `GET /api/config/slack` | 認証必須 |
| Slack | `POST /api/config/slack` | 認証必須 |
| 通知 | `GET /api/config/detection-notifications` | 認証必須 |
| 通知 | `POST /api/config/detection-notifications` | 認証必須 |
| 手動脅威調査 | `GET /api/config/manual-threat` | 認証必須。APIキー値は返さず設定済みかだけ返す |
| 手動脅威調査 | `POST /api/config/manual-threat` | 認証必須。APIキー、cache、provider別cooldownを保存 |
| 手動脅威調査 | `POST /api/threat/manual-lookup` | 認証必須。明示操作で公開IP 1件を選択providerへ送信 |
| AI設定 | `GET /api/config/ai` | 認証必須。APIキー値は返さず設定済みかだけ返す |
| AI設定 | `POST /api/config/ai` | 認証必須。provider、model、endpoint、cloud APIキーを保存 |
| AI設定 | `POST /api/ai/models` | 認証必須。推論せずBedrockのモデル・推論プロファイルIDを取得 |
| AI設定 | `POST /api/ai/pricing/check` | 認証必須。providerへ接続せず内蔵料金表の対応を確認 |
| AI設定 | `POST /api/ai/guardrails` | 認証必須。推論せずBedrockのGuardrailを取得（fail-open） |
| AI設定 | `POST /api/ai/test` | 認証必須。通信データを送らずモデルIDを取得 |
| AI洞察 | `GET /api/ai/facts` | 認証必須。local factsと直前期間比較のみ |
| AI洞察 | `GET /api/ai/usage/monthly` | 認証必須。現地暦の今月・先月token使用量とUSD概算 |
| AI洞察 | `GET /api/ai/pricing/diagnostics` | 認証必須。選択model状態と未価格usageのmodel別診断 |
| AI洞察 | `POST /api/ai/analyze` | 認証必須。通信先IP・ホスト名・端末名・MACと接続集計を選択providerで手動分析。cloudは二重同意必須 |
| AI通知 | `GET /api/ai/notification-config` | 認証必須。schedule、発火条件、通知先、実行状態を返す |
| AI通知 | `POST /api/ai/notification-config` | 認証必須。検証済みscheduleと自動実行同意を保存 |
| AI通知 | `GET /api/ai/notification-events` | 認証必須。append-only通知履歴を最大200件返す |
| AI通知 | `POST /api/ai/notification-test` | 認証必須。AIを呼ばずUI/Slack通知をテスト |
| AI通知 | `POST /api/ai/notification-run-now` | 認証必須。設定済み期間のAI分析を明示実行 |
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
