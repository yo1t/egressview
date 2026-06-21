# AIエージェント連携 — MCP サーバーの設定

EgressView は [Model Context Protocol (MCP)](https://modelcontextprotocol.io) サーバーを内蔵しており、AWS Kiro・Anthropic Claude・Anysphere Cursor・Zed などの AI アシスタントからネットワークデータを直接参照できます。

> 🇬🇧 [English version](setup-mcp.md)

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

**前提条件:** Node.js 18+、稼働中の EgressView、API/admin トークン

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

### Step 1 — EgressView サーバー上で MCP サーバーを起動

```bash
# 環境ファイルをコピーして編集:
cp .env.mcp.example .env.mcp
# MCP_PORT=3010、EGRESSVIEW_URL=http://localhost:3000、EGRESSVIEW_TOKEN=... を設定
# EgressView をリバースプロキシ背後の別ポートで動かしている場合は、
# そのローカルURLを指定してください（例: http://localhost:3002）。
chmod 600 .env.mcp

# 動作確認:
set -a; source .env.mcp; set +a
node mcp-server.js
# → [egressview-mcp] HTTP transport listening on 127.0.0.1:3010/mcp
```

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
        "X-Admin-Token": "your-admin-token"
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
| `EGRESSVIEW_URL` | ✅ | `http://localhost:3000` | EgressView サーバーのベース URL |
| `EGRESSVIEW_TOKEN` | ✅ | — | API/admin トークン（EgressView 初回起動時にコンソールへ表示。ブラウザ用ログインパスワードではありません） |
| `MCP_PORT` | HTTP モード | — | MCP HTTP サーバーのローカルポート（例: `3010`）。stdio モードの場合は不要 |
| `MCP_TOKEN` | — | `EGRESSVIEW_TOKEN` と同じ | MCP HTTP エンドポイントの認証トークン。EgressView API とは別のトークンを使いたい場合に設定 |

---

## セキュリティについて

- MCP HTTP サーバーは `127.0.0.1` のみをリッスンします。リバースプロキシなしでは外部から到達できません
- 認証は `X-Admin-Token` ヘッダーを使用します（EgressView API と同じ仕組み）
- ほとんどのツールは読み取り専用です。`set_device_note` のみ端末メモの書き込みが可能です（`.egressview.notes.json` への保存。メインDBへの書き込みはありません）
- `.env.mcp` には API/admin トークンが含まれるため、`chmod 600` で保護してください

## 商標について

AWS Kiro、Anthropic Claude、Anysphere Cursor などの製品名は、各社の商標または登録商標です。EgressView はこれらの企業と提携・承認・後援関係にありません。
