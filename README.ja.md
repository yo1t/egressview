# Widemap

**Yamaha RTX ルーター + ASUS WiFi アクセスポイント対応のリアルタイムネットワーク接続可視化ツール**

家庭やオフィスのネットワーク上の全デバイスが「どこと通信しているか」を、リアルタイムに世界地図上で表示します。

![License](https://img.shields.io/badge/license-AGPL--3.0-blue)
![Node](https://img.shields.io/badge/node-%3E%3D18-green)

> 🇬🇧 [English README](README.md) | 🌐 [プロジェクトページ](https://yo1t.github.io/widemap/index.ja.html)

---

## 概要

- **Yamaha RTX** ルーターにSSH接続し、NATセッションテーブルを5秒ごとに取得
- 各接続先IPに対して**逆引きDNS**、**RDAP**（組織名）、**GeoIP**（緯度経度・都市）を自動付与
- インタラクティブな**世界地図**上にアニメーション付きアークで全接続をプロット
- **OUIベンダー検索**、**mDNS/Bonjour**、**SSDP**、**NetBIOS**、**Appleモデル辞書**でデバイスを自動識別（「iPhone 15 Pro」レベルまで特定）
- オプションで**ASUS WiFi アクセスポイント**（APモード/AiMeshとして使用、ルーターとしてではない）に接続し、WiFiクライアント情報（帯域、信号強度、トラフィック量、AiMeshトポロジー）を取得
- **7日間の接続履歴**を**SQLite**で永続保存（WALモード、クラッシュセーフ）
- **脅威インテリジェンス**: Feodo Tracker、ThreatFox、URLhaus、Spamhaus DROP フィードと全接続を突合（1時間ごと自動更新）
- **通信ログ**: ソート・検索可能なセッション一覧（脅威バッジ・詳細ポップアップ付き）
- ダークテーマのシングルページUI（グラフビュー、地図ビュー、統計ビュー、通信ログ）

## デモ

https://github.com/user-attachments/assets/9360b145-60cb-46b1-8489-898d7ea62b60

> UI言語: 英語 / 日本語 切り替え可能

収集したNATセッション情報をもとに、ネットワークグラフ・世界地図上の通信アーク・時系列トレンドチャートをリアルタイムに表示します。

右側のサイドバーにはLAN内の全デバイスが一覧表示され、IPアドレスやMACアドレスに加えてホスト名・ベンダー名・機種名などを自動収集して表示します。デバイスを選択すると、そのデバイスの通信先だけにフィルタされ、地図やグラフに反映されます。

## スクリーンショット

![widemap1](docs/widemap1.png)
![widemap2](docs/widemap2.png)
![widemap3](docs/widemap3.png)

## アーキテクチャ

```
┌─────────────────┐   SSH    ┌──────────────┐
│  Yamaha RTX     │◄────────►│              │
│  (NATテーブル)   │          │   Widemap    │   WebSocket
└─────────────────┘          │   Server     │◄──────────► ブラウザ
┌─────────────────┐  HTTP    │  (Node.js)   │
│  ASUS WiFi AP   │◄────────►│              │
│  (クライアント)   │          └──────┬───────┘
└─────────────────┘                 │
                    ┌───────────────┼───────────────┐
                    │               │               │
              ┌─────┴─────┐  ┌─────┴─────┐  ┌─────┴─────┐
              │エンリッチ  │  │ 脅威      │  │  SQLite   │
              │ • 逆引DNS │  │インテル   │  │  履歴     │
              │ • RDAP    │  │ • Feodo   │  │  (WAL)    │
              │ • GeoIP   │  │ • TFox    │  └───────────┘
              │ • OUI     │  │ • URLhaus │
              │ • mDNS    │  │ • DROP    │
              └───────────┘  └───────────┘
```

## 動作要件

- **Node.js** 18以上
- **Yamaha RTX** ルーター（SSH有効化済み）— RTX1200, RTX1210, RTX1220, RTX1300 等
- （任意）**ASUS WiFi アクセスポイント**（Web管理画面が有効、APモード/AiMeshとして使用）

## クイックスタート

### Step 1 — 事前準備チェックリスト

| | 必要なもの | 設定ガイド |
|--|-----------|-----------|
| ✅ | Mac/PC/Raspberry Pi に Node.js 18以上をインストール | [nodejs.org](https://nodejs.org) |
| ✅ | Yamaha RTX ルーターの SSH を有効化 | [設定ガイド →](docs/setup-yamaha.ja.md) |
| ☐ | （任意）ASUS WiFi AP の Web 管理画面を有効化 | [設定ガイド →](docs/setup-asus.ja.md) |

### Step 2 — インストールと起動

```bash
git clone https://github.com/yo1t/widemap.git
cd widemap
npm install
npm start
```

### Step 3 — ブラウザを開いて管理トークンを入力

初回起動時に**管理トークン**がコンソールに表示されます：

```
══════════════════════════════════════════════════════════════
  Widemap admin token (initial):
  a1b2c3d4e5f6...
  → ブラウザ初回アクセス時にこのトークンを入力してください
══════════════════════════════════════════════════════════════
```

`http://localhost:3000` を開いてトークンを入力してください。

### Step 4 — ルーターの接続情報を設定

設定パネル（⚙）を開いてルーター情報を入力します：

| 項目 | 確認場所 |
|------|---------|
| Yamaha RTX の IP アドレス | ルーターの LAN 側 IP（例: `192.168.1.1`） |
| SSH ユーザー名 / パスワード | [Yamaha 設定ガイド](docs/setup-yamaha.ja.md) で設定したもの |
| NAT ディスクリプタ番号 | ルーターで `show nat descriptor` を実行 — 通常は `100` |
| ASUS AP の IP / パスワード | AP の LAN 側 IP と管理者パスワード（[ASUS 設定ガイド](docs/setup-asus.ja.md)） |

数秒後にデバイスと接続先が地図に表示されはじめます。

> **注意:** 管理トークンは初回起動時に1度だけ生成され、`.widemap.json` に保存されます。紛失した場合は `.widemap.json` を削除して再起動すれば新しいトークンが生成されます。

## 管理トークン

管理トークンは全APIエンドポイントとWebSocket接続を保護します。ブラウザUIを開くたびに入力が必要です。

### トークンの確認方法

1. **初回起動時** — 上記のようにコンソール（stdout）に表示されます
2. **起動後** — `.widemap.json` に保存されています（フィールド: `adminToken`）

### トークンを紛失した場合

```bash
# 方法1: 設定ファイルから読み取る
cat .widemap.json | grep adminToken

# 方法2: リセット（新しいトークンが生成される）
rm .widemap.json
npm start
```

### 仕組み

- ブラウザは初回アクセス時にトークンの入力を求め、`localStorage` に保存します
- 全APIリクエストは `X-Admin-Token` ヘッダーにトークンを含めます
- WebSocket接続はSocket.IOのハンドシェイク認証でトークンを渡します
- トークン比較には `crypto.timingSafeEqual` を使用し、タイミング攻撃を防止します

## 設定

設定は `.widemap.json`（自動生成、gitignore対象）に保存されます。環境変数でも指定可能：

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `PORT` | `3000` | HTTPサーバーポート |
| `POLL_INTERVAL_MS` | `2000` | ASUSポーリング間隔（ミリ秒） |
| `ROUTER_IP` | `192.168.1.1` | ASUSルーターのデフォルトIP |
| `YAMAHA_IP` | — | Yamaha RTXのIPアドレス |
| `YAMAHA_USER` | — | Yamaha SSHユーザー名 |
| `YAMAHA_PASS` | — | Yamaha SSHパスワード |
| `YAMAHA_NAT` | `100` | NATディスクリプタ番号 |
| `SUBPATH` | — | リバースプロキシのサブパス（例: `/widemap`） |

## 機能詳細

### L3/L4: Yamaha RTX（NATセッション監視）

- `show nat descriptor address <N> detail` の出力をパース
- TCP/UDP/ICMP/GRE セッションを送信元・宛先・ポート・TTL付きで追跡
- SSHタイムアウト・切断時の自動再接続
- TOFU（Trust On First Use）によるホスト鍵検証

### L2: ASUS WiFi アクセスポイント（Mesh対応、クライアント監視）

ASUSデバイスは**WiFiアクセスポイント（APモードまたはAiMesh）**として使用します。L3ルーティングとNATはYamaha RTXが担当し、ASUS APはL2のクライアント可視性を提供します：

- SHA256チャレンジレスポンス認証
- クライアント一覧（接続種別: 有線/2.4G/5G/6G、RSSI、トラフィック量）
- AiMeshノード検出（マルチAPトポロジー）
- トークン自動更新

### デバイス識別

- **OUIデータベース**（Wireshark manuf、週次自動ダウンロード）
- **mDNS/Bonjour** サービス探索（100種類以上のサービスタイプ）
- **SSDP/UPnP** デバイス検出
- **NetBIOS** 名前解決
- **Appleモデル辞書**（200機種以上: iPhone, iPad, Mac, Apple TV, HomePod, Apple Watch）
- **自動調査モード**: 未知のデバイスをバックグラウンドでスキャン

### 可視化

- **グラフビュー**: 力学モデルによるネットワークトポロジー
- **世界地図**: 接続先IPを緯度経度にプロットし、設置場所からアニメーションアークを描画
- **統計**: 接続先別セッション数の時系列チャート・棒グラフ
- **通信ログ**: 全セッションのテーブル表示（カラムごとのソート・検索フィルター対応、脅威行のクリックで詳細ポップアップ）
- **接続パネル**: デバイスごとのアクティブなインターネット接続一覧（組織名・国情報付き）
- **IPv4/IPv6バッジ**: NDPキャッシュポーリングによるプロトコル検出

### 脅威インテリジェンス（C2/ボットネット検出）

- **Feodo Tracker**: Emotet/Dridex/TrickBot C2サーバーIP
- **ThreatFox**: マルウェアIOC（IP:port）
- **URLhaus**: マルウェア配布URL（GitHub等のCDNドメインは低信頼度として区別）
- **Spamhaus DROP**: ハイジャック済みIP範囲（CIDR）
- 3段階の信頼度: 🚨 検出（高信頼度） / ⚠️ 要確認（低信頼度 — 正規サービス上） / ✅ 未検出
- 脅威詳細ポップアップ（信頼度に応じた推奨アクションを表示）
- フィード自動更新（1時間ごと、設定で変更可能）

### セキュリティ

- 管理トークン認証（タイミングセーフ比較）
- SSRF防止（プライベートIP範囲のみ許可）
- Socket.IO 同一オリジン制限
- SSHホスト鍵フィンガープリント検証（TOFU）
- 設定ファイルは `0600` パーミッションで保存
- パスワードはブラウザに送信しない（真偽値フラグのみ）

## 対応ルーター

### Yamaha RTX（L3/L4）
SSH接続とNATディスクリプタに対応した全モデル：
- RTX1200, RTX1210, RTX1220, RTX1300
- RTX810, RTX830
- NVR500, NVR510, NVR700W

### ASUS WiFi アクセスポイント（L2、Mesh対応）
標準Web管理インターフェースを持つ全モデル（APモードまたはAiMeshで使用）：
- RT-AXシリーズ（AX86U, AX88U, AX92U 等）
- RT-ACシリーズ
- ZenWiFi（AiMesh）

## ロードマップ

- [x] ~~モジュール分割（server.js → src/ ディレクトリ構造）~~
- [x] ~~SQLiteベースの永続ストレージ~~
- [x] ~~脅威インテリジェンス連携（Feodo, ThreatFox, URLhaus, Spamhaus）~~
- [x] ~~通信ログ（ソート・検索・脅威ポップアップ）~~
- [x] ~~IPv4/IPv6プロトコルバッジ（NDP検出）~~
- [ ] アラート通知（Slack/メール Webhook）
- [ ] OpenWrt / MikroTik / pfSense 対応
- [ ] DNSログ監視（L7可視化）
- [ ] IPv6通信先可視化（パケットミラー方式）
- [ ] AWS VPC Flow Logs 連携
- [ ] モバイルアプリ（iOS/Android、Capacitor）
- [ ] CSV/JSONエクスポート

## ライセンス

[AGPL-3.0](LICENSE) — このソフトウェアを改変してネットワークサービスとして提供する場合、変更内容を公開する必要があります。

```
Widemap — リアルタイムネットワーク接続可視化ツール
Copyright (C) 2025 Yoichi Takizawa

ソースコード: https://github.com/yo1t/widemap
```

## コントリビュート

Issue や Pull Request を歓迎します。大きな変更の場合は、先に Issue で相談してください。
