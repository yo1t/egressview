# AIエージェント連携 — MCP サーバーの設定

EgressView は [Model Context Protocol (MCP)](https://modelcontextprotocol.io) サーバーを内蔵しており、AWS Kiro・Anthropic Claude・Anysphere Cursor・Zed などの AI アシスタントからネットワークデータを直接参照できます。

> 🇬🇧 [English version](setup-mcp.md)

MCP SDK v2 serverは1つのtool定義で両方のprotocol eraを提供します。
`2025-11-25` clientは従来の`initialize` flow、`2026-07-28` clientは
statelessな`server/discover`とrequest単位のmetadataを使用します。互換性のため
legacy fallbackを維持し、sticky sessionは必要ありません。

Transportを選ぶ前に、cloud非依存の[Deployment profile](deployment-profiles.ja.md)
から`local-stdio`、`private-http`、`private-oauth`、`public-oauth`のいずれかを
選びます。管理環境では`EGRESSVIEW_DEPLOYMENT_PROFILE`を明示してください。
Transport/認証との矛盾はendpoint起動前に拒否します。

## 使い方の例

接続後は自然な言葉で質問するだけです:

```
「過去24時間の脅威サマリーを見せて」
→ 合計18,142セッション: safe 18,117 / warn 25 / danger 0

「今日一番通信した端末はどれ？」
→ セッション数・MAC・ベンダー付きで端末ランキングを表示

「今週、新しいデバイスはネットワークに現れた？」
→ 過去7日間に初めて出現した端末・宛先を一覧表示

「脅威のある通信はある？」
→ Feodo / ThreatFox / URLhaus / Spamhaus DROP にヒットした宛先を表示

「192.168.1.50 はどこに接続している？」
→ その端末の上位宛先を国・組織・脅威レベル付きで表示

「過去6時間のアラートを教えて」
→ 脅威検出・新規デバイス通知・ビーコン候補の一覧

「メモがついている端末を一覧で見せて」
→ メモが登録されている全端末を表示

「192.168.1.97 にメモを追加して：Roomba、OTA アップデートで GitHub に接続」
→ その端末にメモを保存
```

AIエージェントが適切なツールを自動で選択し、必要であれば複数のツールを組み合わせて回答します。

## 利用できるツール

| ツール名 | 返す情報 |
|---|---|
| `get_threat_summary` | 指定期間の safe / warn / danger セッション数 |
| `get_traffic_summary` | 総セッション数・ユニーク宛先数・ユニーク端末数 |
| `get_top_destinations` | 接続数上位の宛先一覧（国・組織・脅威レベル付き） |
| `get_device_traffic` | 端末ごとのトラフィック（src IP 指定で特定端末の上位宛先） |
| `get_new_nodes` | 指定期間に初出現した端末・宛先 |
| `get_threat_connections` | 脅威判定された通信先（信頼度 low/high 絞り込み可） |
| `get_alerts` | 検出ログ（脅威・新規端末・ビーコン） |
| `get_devices` | LAN 内の全端末（MAC・ベンダー・状態・最終通信） |
| `query_connections` | 送信元/宛先フィルター付きの通信ログ検索 |
| `get_device_notes` | 端末のメモ一覧（src 省略で全端末、src IP 指定で1端末のメモ） |
| `set_device_note` | src IP で端末を指定してメモを追加・更新（空文字で削除） |

期間指定を行うツールは `period` パラメータを受け付けます: `1h` / `6h` / `24h`（デフォルト）/ `7d` / `14d`
`get_devices` / `get_device_notes` / `set_device_note` は `period` パラメータを使用しません。

---

## Option A — stdio モード（ローカル・推奨）

Claude Desktop と同じマシン上でローカルプロセスとして MCP サーバーを起動します。MCP サーバーが EgressView の REST API を HTTP で呼び出します。EgressView はローカルでもリモートサーバー上でも構いません。

**Claude Desktop では stdio モードが推奨です。** `command` ベースの stdio トランスポートはすべての MCP クライアントでサポートされており、URL バリデーションの制限を受けません。

**前提条件:** Node.js 22+、稼働中の EgressView、API/admin トークン

```bash
# 1. クローン（まだの場合）:
git clone https://github.com/yo1t/egressview.git
cd egressview
npm install
```

**Claude Desktop の設定ファイル** (`~/Library/Application Support/Claude/claude_desktop_config.json`、macOS の場合):

```json
{
  "mcpServers": {
    "egressview": {
      "command": "node",
      "args": ["/absolute/path/to/egressview/mcp-server.js"],
      "env": {
        "EGRESSVIEW_URL":   "http://your-server-ip:3000",
        "EGRESSVIEW_TOKEN": "your-admin-token"
      }
    }
  }
}
```

- `/absolute/path/to/egressview` はクローンした実際のパスに置き換えてください。
- `EGRESSVIEW_URL` は EgressView サーバーのベース URL です。リバースプロキシ経由で `/egressview/` に公開している場合はそのパスを含めてください（例: `http://your-server-ip/egressview`）。
- `EGRESSVIEW_TOKEN` は EgressView 初回起動時にコンソールへ表示される API/admin トークンです。ブラウザ用ログインパスワードではありません。

設定後に Claude Desktop を再起動すると、MCP ツール一覧に `egressview` が表示されます。

---

## Option B — リバースプロキシ経由の HTTP モード（リモートアクセス）

EgressView と同じサーバー上で `mcp-server.js` を HTTP サーバーとして起動し、リバースプロキシ（Apache または nginx）経由で外部公開します。

> **Claude Desktop をご利用の方へ:** Claude Desktop はリモート MCP サーバーに `https://` URL を要求します。リバースプロキシで TLS を終端していない場合は、Option A（stdio）を使用してください。stdio モードならローカル・リモートどちらの EgressView にも HTTP で接続できます。

このオプションは、HTTP トランスポートをネイティブでサポートする MCP クライアント（Anysphere Cursor・Zed・AWS Kiro・Anthropic Claude・カスタムエージェントなど）向けです。

### ChatGPT から接続する場合

ChatGPT から EgressView の MCP サーバーへ接続する場合は、Codex や Claude Desktop のローカル設定とは別に、ChatGPT 側で remote MCP / app として設定する必要があります。Codex の `~/.codex/config.toml` や Claude Desktop の `claude_desktop_config.json` に追加した設定は、ChatGPT には自動では引き継がれません。

ChatGPT 側から直接接続する remote MCP サーバーは、原則として ChatGPT から到達できる HTTPS URL が必要です。EgressView を家庭内LAN、SOHO、社内ネットワーク、プライベートサブネットなどに置いている場合は、MCP エンドポイントをそのままインターネットへ公開せず、OpenAI の Secure MCP Tunnel など、プライベートな MCP サーバーを安全に接続する仕組みを検討してください。

ChatGPT Apps として公開・共有する場合は、利用者ごとの認証・権限管理も重要です。個人利用の検証では `X-Admin-Token` による保護でも動作確認できますが、複数ユーザーや外部公開を想定する場合は OAuth などのユーザー単位の認可を検討してください。MCP ツールはネットワーク状態や端末メモを取得できるため、信頼できるクライアントとユーザーだけに利用を限定してください。

### Step 1 — EgressView サーバー上で MCP サーバーを起動

```bash
# 環境ファイルをコピーして編集:
cp .env.mcp.example .env.mcp
# MCP_PORT=3010、MCP_TOKEN=<専用のランダムtoken>、
# EGRESSVIEW_URL=http://localhost:3000、EGRESSVIEW_TOKEN=... を設定
# EgressView をリバースプロキシ背後の別ポートで動かしている場合は、
# そのローカルURLを指定してください（例: http://localhost:3002）。
chmod 600 .env.mcp

# 動作確認:
set -a; source .env.mcp; set +a
node mcp-server.js
# → [egressview-mcp] HTTP transport listening on 127.0.0.1:3010/mcp
```

HTTP tokenモードでは`MCP_TOKEN`の明示設定が必須となり、
`EGRESSVIEW_TOKEN`へフォールバックしなくなりました。これによりMCP
endpoint tokenが漏えいしても、EgressView管理APIの全権限へ直結しません。
旧fallbackを利用していたHTTP環境は、更新前に別のtokenを生成して
`MCP_TOKEN`へ設定してください。stdioモードは変更なく、`MCP_TOKEN`を
使用しません。

### 段階導入中のOAuth Resource Serverモード

P2-60のOAuth Resource Server境界は、`MCP_AUTH_MODE=oauth`、
`MCP_OAUTH_ISSUER`、`MCP_OAUTH_RESOURCE`、`MCP_OAUTH_READ_SCOPE`、
`MCP_OAUTH_NOTES_WRITE_SCOPE`、`MCP_SERVICE_TOKEN`、
`MCP_AUDIT_HMAC_KEY`を
設定するとprivate integration testで利用できます。RFC 9728 Protected
Resource Metadataを提供し、issuerのdiscovery/JWKSからRS256署名を検証し、
issuer、有効期限、audience、scopeの不一致をfail-closedで拒否します。
issuerはPKCE S256をmetadataへ公開する必要があります。loopback限定試験を
除きHTTPSが必須です。

外部provider scopeはEgressViewの共通permissionへ変換します。
`MCP_OAUTH_READ_SCOPE`は`network.read`、
`MCP_OAUTH_NOTES_WRITE_SCOPE`は`notes.write`を付与します。read-onlyの
access tokenでは`set_device_note`をtool一覧へ表示せず、直接呼び出しても
`403 insufficient_scope`で拒否します。scope昇格時に既存のread scopeを
失わないよう、write challengeには両方のscopeを含めます。

`network.read`と`notes.write`だけを持つ専用API identityを作り、作成時に
一度だけ返る平文tokenを`MCP_SERVICE_TOKEN`へ設定します:

```bash
curl -sS -X POST http://127.0.0.1:3002/api/auth/api-identities \
  -H "X-Admin-Token: $EGRESSVIEW_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"label":"Remote MCP service","permissions":["network.read","notes.write"],"expiresInMs":31536000000}'
```

OAuth modeは`egv_...`形式のscoped identityだけを受け付け、
`EGRESSVIEW_TOKEN`へfallbackしません。`.env.mcp`をmode `0600`で保護し、
期限前にidentityをrotationして、確認後に旧identityを失効してください。
監査鍵は`openssl rand -hex 32`で一度だけ生成し、service identityをrotation
しても同じ値を維持します。Internet公開gateは次のP2-60で実装します。
現段階のendpointをInternetへ公開しないでください。

### Step 2a — Apache (httpd) の設定

既存の `<VirtualHost>` または設定ファイルに追記します。MCP のブロックは、既存の `/egressview/` ProxyPass ルール**より前**に置く必要があります。

```apache
# ─── EgressView MCP サーバー ─────────────────────────────────────────────────
<Location /egressview/mcp>
    ProxyPass        http://127.0.0.1:3010/mcp flushpackets=on
    ProxyPassReverse http://127.0.0.1:3010/mcp
    # MCP Streamable HTTP は Accept ヘッダーに両タイプが必要
    RequestHeader set Accept "application/json, text/event-stream"
</Location>

# OAuthモードのみ: RFC 9728 metadataのpathを維持して公開
ProxyPass        /.well-known/oauth-protected-resource http://127.0.0.1:3010/.well-known/oauth-protected-resource
ProxyPassReverse /.well-known/oauth-protected-resource http://127.0.0.1:3010/.well-known/oauth-protected-resource

# ─── EgressView Web UI（既存のルール — 下に置く） ────────────────────────────
ProxyPass        /egressview/ http://127.0.0.1:3002/
ProxyPassReverse /egressview/ http://127.0.0.1:3002/
```

必要な Apache モジュール: `mod_proxy`、`mod_proxy_http`、`mod_headers`（通常はデフォルトで有効）

```bash
sudo apachectl configtest && sudo systemctl reload httpd
```

### Step 2b — nginx の設定

`server {}` ブロック内に追記:

```nginx
location /egressview/mcp {
    proxy_pass         http://127.0.0.1:3010/mcp;
    proxy_http_version 1.1;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Real-IP         $remote_addr;
    proxy_set_header   X-Forwarded-Proto $scheme;
    # SSE（ストリーミングレスポンス）のために必要
    proxy_set_header   Accept            "application/json, text/event-stream";
    proxy_set_header   Connection        '';
    proxy_buffering    off;
    proxy_cache        off;
    proxy_read_timeout 3600s;
}

# OAuthモードのみ: rootとresource固有のmetadata pathを維持
location /.well-known/oauth-protected-resource {
    proxy_pass http://127.0.0.1:3010;
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

### Step 3 — systemd サービスとして登録（推奨）

```ini
# /etc/systemd/system/egressview-mcp.service
[Unit]
Description=EgressView MCP Server
After=network.target egressview.service

[Service]
Type=simple
User=ec2-user
WorkingDirectory=/home/ec2-user/egressview
EnvironmentFile=/home/ec2-user/egressview/.env.mcp
ExecStart=/usr/bin/node /home/ec2-user/egressview/mcp-server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now egressview-mcp
```

### Step 4 — クライアントの設定（HTTP モード）

HTTP トランスポートをサポートする MCP クライアント（Anysphere Cursor・Zed・カスタムエージェント）の場合:

```json
{
  "mcpServers": {
    "egressview": {
      "url": "https://your-server/egressview/mcp",
      "headers": {
        "X-Admin-Token": "your-dedicated-mcp-token"
      }
    }
  }
}
```

リバースプロキシで TLS を終端している場合は `https://` を使用してください（Claude Desktop では必須）。プレーンな `http://` で使いたい場合は Claude Desktop では Option A（stdio）を使用してください。

---

## 環境変数リファレンス

| 変数 | 必須 | デフォルト | 説明 |
|---|---|---|---|
| `EGRESSVIEW_DEPLOYMENT_PROFILE` | 推奨 | 推定 | `local-stdio`、`private-http`、`private-oauth`、`public-oauth`。deployment profile matrix参照 |
| `EGRESSVIEW_URL` | ✅ | `http://localhost:3000` | EgressView サーバーのベース URL |
| `EGRESSVIEW_TOKEN` | ✅ | — | API/admin トークン（EgressView 初回起動時にコンソールへ表示。ブラウザ用ログインパスワードではありません） |
| `MCP_PORT` | HTTP モード | — | MCP HTTP サーバーのローカルポート（例: `3010`）。stdio モードの場合は不要 |
| `MCP_AUTH_MODE` | HTTP モード | `token` | HTTP endpointの認証モード。`token`または段階導入中の`oauth` |
| `MCP_TOKEN` | HTTP tokenモード | — | private HTTP endpoint専用token。明示設定し、`EGRESSVIEW_TOKEN`と別の値にする |
| `MCP_OAUTH_ISSUER` | HTTP OAuthモード | — | Authorization Serverの正確なHTTPS issuer URL。loopback HTTPは試験時だけ許可 |
| `MCP_OAUTH_RESOURCE` | HTTP OAuthモード | — | JWT audienceの完全一致検証に使うcanonical public MCP resource URL |
| `MCP_OAUTH_READ_SCOPE` | HTTP OAuthモード | — | 内部`network.read` permissionへmappingするprovider scope |
| `MCP_OAUTH_NOTES_WRITE_SCOPE` | HTTP OAuthモード | — | 内部`notes.write` permissionへmappingするprovider scope |
| `MCP_SERVICE_TOKEN` | HTTP OAuthモード | — | `network.read`と`notes.write`だけを持つ専用`egv_...` API identity token |
| `MCP_AUDIT_HMAC_KEY` | HTTP OAuthモード | — | 監査subject/clientの仮名化だけに使う32文字以上の安定した秘密鍵 |

---

## セキュリティについて

- MCP HTTP サーバーは `127.0.0.1` のみをリッスンします。リバースプロキシなしでは外部から到達できません
- private tokenモードは専用`MCP_TOKEN`を`X-Admin-Token`または`Authorization: Bearer`で受け取り、EgressView管理tokenへfallbackしません
- ほとんどのツールは読み取り専用です。`set_device_note` のみ端末メモの書き込みが可能です（`.egressview.notes.json` への保存。メインDBへの書き込みはありません）
- `.env.mcp` には非公開API credentialが含まれるため、`chmod 600` で保護してください

---

## 公開MCP: 上限・監査・失効

OAuthモード（`MCP_AUTH_MODE=oauth`）にのみ適用されます。private tokenモードとstdioモードは本節の影響を受けません。

### リクエスト上限

3つの独立したバケットがあり、すべてが許可した場合だけ通過します。加えて同時実行数の上限を別に設けています。遅いtool callは、毎分の上限に達するよりずっと早くプロセスを枯渇させるためです。

| 設定 | 既定値 | 目的 |
|---|---|---|
| `MCP_RATE_LIMIT_GLOBAL` | 60/分 | 単一のバーストからホストを保護 |
| `MCP_RATE_LIMIT_SUBJECT` | 30/分 | 侵害された1利用者が全体の枠を消費できない |
| `MCP_RATE_LIMIT_CLIENT` | 30/分 | 異常な1クライアントも同様 |
| `MCP_MAX_CONCURRENT` | 4 | 同時tool call数を制限 |
| `MCP_MAX_BODY` | `256kb` | 解析・認証の前にbodyを制限 |
| `MCP_REQUEST_TIMEOUT_MS` | 30000 | MCP処理1回の締切 |
| `MCP_API_TIMEOUT_MS` | 15000 | 内部EgressView API呼び出し1回の締切 |

締切が無いと、停止した呼び出しが`MCP_MAX_CONCURRENT`個の枠をすべて占有し、endpointが閉塞します。request締切は内部API呼び出しをabortして応答を終了します。なおMCPのtransportはストリーミングのため、応答を開始した後はステータスを`504`へ変更できません。ストリーム途中で締切を超えた呼び出しは、ステータスではなく監査の`request_timeout`として記録されます。timeout値は1〜600000の整数ミリ秒だけを許可し、不正値は文書記載の既定値へfallbackします。

既定値は意図的に厳しくしています。実測した使用量がまだ無く、誤検知が出てから緩めるのは容易ですが、緩すぎたと気づくのは悪用された後だからです。正当な処理が上限に当たる場合は引き上げてください。

拒否時は`429`と`Retry-After`を返します。正の整数でない値は上限を無効化せず既定値へfallbackします。設定ミスで上限が消えることはありません。

**reverse proxy側の上限も併用してください。** これはNode側の半分にすぎず、ここの不具合や再起動でendpointが無制限になってはいけません。`X-Forwarded-For`は`EGRESSVIEW_TRUST_PROXY`に列挙したproxyアドレスからのみ信頼します（[認証ガイド](authentication.ja.md)参照）。

### 監査

公開endpointへの全リクエストを専用ストア（`MCP_AUDIT_DB_PATH`、既定`.egressview-mcp-audit.db`）へ追記します。EgressView本体の監査とは**意図的に分離**しています。MCPプロセスはscoped API identityで動作しており、本体の監査への書き込み権限を与えると、MCPが侵害された場合に本体の記録を偽造・改竄できてしまうためです。

記録するもの: 仮名化したOAuth subjectとclient ID、tool名、付与scope、成否、理由コード、request ID、処理時間。

**記録しないもの:** tool引数、IP/MACアドレス、端末メモ本文、access token、生のJWT、providerのエラー文言。

**2つの監査の突き合わせ。** EgressView本体はMCP service identityが何をしたかを記録し（`actor: api:<id>`）、こちらのストアはそれをどのOAuth subjectが要求したかを記録します。MCPのrequest IDは`X-Request-Id`としてEgressViewへ転送されるため、1つの事象を両者で追跡できます。**保持期間は必ず揃えてください。**片方だけ先に消えると、「何が起きたか」は残るのに「誰が指示したか」が失われます。

理由コード: `unauthorized`、`invalid_token`、`insufficient_scope`、`global_rate_limit`、`subject_rate_limit`、`client_rate_limit`、`concurrency_limit`、`request_timeout`、`server_error`。これらが連続する場合は調査の合図です。

subjectは専用`MCP_AUDIT_HMAC_KEY`によるHMACで仮名化するため、識別子を保存せずに同一人物の活動を追跡できます。`MCP_SERVICE_TOKEN`をrotationしてもこの鍵は維持してください。意図的に変更した場合は新しい仮名化namespaceになります。180日より古い記録は起動時に削除します。EgressView本体の監査保持期間と揃えています。

### アクセスの失効

1. **認可サーバー側で失効させる** — 新しいtokenの発行を止められるのはここだけです。事象に応じて利用者かclient登録を失効します
2. **access tokenの有効期限が切れるのを待つ。** EgressViewはtokenをoffline検証するため、**発行済みtokenは期限まで有効なままです**。この窓を小さく保つために、access tokenの寿命を短く（5〜15分を前提）設定してください
3. **即座に遮断する場合**は公開endpointを止めます。proxyのrouteを外すか、`MCP_AUTH_MODE=token`に戻します。ローカル収集、ブラウザUI、stdio、private HTTPは動作を継続します
4. **MCPホスト自体が侵害された可能性がある場合は`MCP_SERVICE_TOKEN`をrotateします。** EgressViewで新しいscoped API identityを発行し、`.env.mcp`を更新して再起動し、その後で旧identityを失効させます

### 認可サーバーやJWKSへ到達できない場合

公開MCP endpointはfail-closedで`401`を返します。それ以外は動作を継続します。ルーター収集、ブラウザUI、stdioクライアント、private HTTPモードはいずれも影響を受けません。IdP障害をEgressViewの障害として扱わないでください。

## 公開前gate

P2-60には、公開DNSを作成する前に必ず成功させるfail-closed gateが
あります。このgateは**DNS、証明書、load balancer、security group、
Keycloak、EgressView設定を作成・変更しません**。成功結果も
`ready_for_manual_dns_review`であり、DNS公開は別途レビューする操作です。

DNS未公開のALBまたはreverse proxyに対して実行します。
`MCP_GATE_CONNECT_ADDRESS`へstaging targetを指定しても、TLS SNIとHTTP
`Host`にはcanonical hostnameを維持します。これは
`curl --connect-to`と同じ考え方です。

```bash
cp .env.mcp-gate.example .env.mcp-gate
chmod 600 .env.mcp-gate
cp docs/mcp-publication-evidence.example.json \
  .egressview-mcp-publication-evidence.json

set -a
. ./.env.mcp-gate
set +a
npm run mcp:publication-gate
```

2つのlocalファイルはいずれもgitignoreされています。Bearer tokenは
mode `0600`の環境ファイルだけに置き、試験直後に削除してください。
証跡JSONと生成レポートにはtoken、tool引数、通信観測、IP/MAC、credentialを
記録しません。

dual-era gateは証跡schema v2を要求します。旧schema v1はversion番号だけを
書き換えず、新しいtemplateへ置き換えてください。v2のclient protocol fieldは
実際のclient試験結果から記録する必須項目です。

### 必須証跡

すべて成功済みで、deployした40文字のGit commitと一致し、試験から30日以内
でなければなりません。

- production DNSが無効で、EC2の443/3000/3002/3010へInternetから直接
  ingressできない
- reverse proxyのbody、request rate、同時実行、timeout上限を実測した
- stagingでapplication rollbackとMCP service identity rotationを試験した
- Keycloak DB backupを使い捨て環境へrestoreした
- Keycloak/JWKSを到達不能にしMCPのJWKS cacheを空にした状態で、公開MCPだけが
  fail-closedとなり、`/healthz`、`/readyz`、全有効routerの収集が継続した
- refresh token replay対策が、次のどちらかの記録済み方式で成功した:
  replay requestを拒否して現行familyを維持する`reject-replay`、または
  replay検知後にfamily全体を失効して現行refresh tokenも拒否する`revoke-family`
- family失効前に発行され得るtokenの影響を限定するため、access token寿命を記録し
  15分以下にした
- Claude CodeとGitHub Copilot CLIがstaging endpointでread toolとrefreshを
  完了し、それぞれ選択したprotocol versionが`2026-07-28`であることを記録した
- 保持したlegacy clientが`2025-11-25`で同じtool discoveryを完了した

JWKS障害試験ではMCP processをcold startしてください。起動済みprocessが
有効なcached JWKSで署名検証を継続するのは正常であり、discoveryの
fail-closed証跡にはなりません。

### 自動probe

CLIは続けて次を確認します。

- public hostnameにA/AAAA recordがない
- TLS hostname検証とRFC 9728 metadataの2経路
- 未認証要求がscope付き`401` challengeになる
- `2025-11-25`の`initialize`と`2026-07-28`の`server/discover`が成功する
- 両protocol revisionで同じ11本のtoolを表示する
- modern header/body不整合が`-32020`、未対応versionが`-32022`を返す
- configured issuerのJWKSでfixture署名を独立検証した上で、malformed、期限切れ、
  誤audience、失効後に期限切れとなったaccess tokenを拒否
- scoped internal service identityを通した実際のread tool
- read tokenで`set_device_note`を試した時の`403`と、write tokenでのtool表示
- staging burst後の`429`と`Retry-After`
- 対応するappend-only監査行と仮名化identity
- local readinessと、全有効routerの直近収集成功

rate probeはstaging processのglobal 1分bucketを意図的に使い切ります。
公開中のendpointでは実行しないでください。

EgressViewはJWTをoffline検証するため、Keycloak sessionやrefresh familyを
失効しても、発行済みaccess tokenは`exp`まで無効になりません。そのため
`MCP_GATE_REVOKED_EXPIRED_TOKEN`は短いaccess token TTLの経過後に検査します。
`reject-replay`はreplay request自体の失敗と現行familyの継続を要求します。
Keycloak 26.7.0の実測に一致する`revoke-family`はreplay検知後に現行familyも
失敗することを要求します。この方式ではreplay requestが最後の短命access tokenを
発行する可能性があるため、どちらの方式でもaccess token寿命を15分以下にします。
即時遮断が必要なら最初にpublic proxy routeを外し、access tokenを即時失効
できるとは表現しません。

### 結果とrollback

成功するとmode `0600`の`.egressview-mcp-publication-gate.json`を生成します。
deploy commit、実行日時、hostname、router数、各分類の成否だけを記録し、
秘密情報は保存しません。失敗時はnonzeroで終了し、DNS公開を禁止します。

公開後の確認に失敗した場合はWeb/MCPのDNS aliasを削除し、MCP proxy routeを
無効化してVPN/SSM運用へ戻します。applicationの確認済みreleaseとKeycloak
DBは、それぞれ事前試験したrollback手順だけで復元します。router収集と
local recovery administratorは常に利用可能な状態を維持してください。

## 商標について

AWS Kiro、Anthropic Claude、Anysphere Cursor などの製品名は、各社の商標または登録商標です。EgressView はこれらの企業と提携・承認・後援関係にありません。
