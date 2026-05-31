# Widemap

**Yamaha RTX ルーター + ASUS WiFi AP 対応のリアルタイムネットワーク接続可視化ツール**

家庭やオフィスのネットワーク上の全デバイスが「どこと通信しているか」を、リアルタイムに世界地図上で表示します。

![License](https://img.shields.io/badge/license-AGPL--3.0-blue)
![Node](https://img.shields.io/badge/node-%3E%3D18-green)

> 🇬🇧 [English README](README.md)

---

## 概要

- **Yamaha RTX** ルーターにSSH接続し、NATセッションテーブルを5秒ごとに取得
- 各接続先IPに対して**逆引きDNS**、**RDAP**（組織名）、**GeoIP**（緯度経度・都市）を自動付与
- インタラクティブな**世界地図**上にアニメーション付きアークで全接続をプロット
- **OUIベンダー検索**、**mDNS/Bonjour**、**SSDP**、**NetBIOS**、**Appleモデル辞書**でデバイスを自動識別（「iPhone 15 Pro」レベルまで特定）
- オプションで**ASUSルーター**に接続し、WiFiクライアント情報（帯域、信号強度、トラフィック量）を取得
- **7日間の接続履歴**を永続保存
- ダークテーマのシングルページUI（グラフビュー、地図ビュー、統計ビュー）

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
│  ASUS ルーター   │◄────────►│              │
│  (クライアント)   │          └──────────────┘
└─────────────────┘               │
                          ┌───────┴───────┐
                          │ エンリッチメント │
                          │ • 逆引きDNS    │
                          │ • RDAP (組織名) │
                          │ • GeoIP        │
                          │ • OUI ベンダー  │
                          │ • mDNS/SSDP    │
                          └───────────────┘
```

## 動作要件

- **Node.js** 18以上
- **Yamaha RTX** ルーター（SSH有効化済み）— RTX1200, RTX1210, RTX1220, RTX1300 等
- （任意）**ASUS ルーター**（Web管理画面が有効）

## クイックスタート

```bash
git clone https://github.com/yo1t/widemap.git
cd widemap
npm install
npm start
```

初回起動時に**管理トークン**がコンソールに表示されます：

```
══════════════════════════════════════════════════════════════
  Widemap admin token (initial):
  a1b2c3d4e5f6...
  → ブラウザ初回アクセス時にこのトークンを入力してください
══════════════════════════════════════════════════════════════
```

`http://localhost:3000` を開いてトークンを入力し、設定パネル（⚙）からルーター接続を設定してください。

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

### L2: ASUS ルーター（WiFiクライアント監視）

- SHA256チャレンジレスポンス認証
- クライアント一覧（接続種別: 有線/2.4G/5G/6G、RSSI、トラフィック量）
- AiMeshノード検出
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
- **接続パネル**: デバイスごとのアクティブなインターネット接続一覧（組織名・国情報付き）

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

### ASUS（L2）
標準Web管理インターフェースを持つ全モデル：
- RT-AXシリーズ（AX86U, AX88U, AX92U 等）
- RT-ACシリーズ
- ZenWiFi（AiMesh）

## ロードマップ

- [ ] 脅威インテリジェンス連携（C2/ボットネット検出）
- [ ] SQLiteベースの長期保存（2年以上）
- [ ] OpenWrt / MikroTik / pfSense 対応
- [ ] アラート通知（Slack/メール Webhook）
- [ ] CSV/JSONエクスポート

## ライセンス

[AGPL-3.0](LICENSE) — このソフトウェアを改変してネットワークサービスとして提供する場合、変更内容を公開する必要があります。

## コントリビュート

Issue や Pull Request を歓迎します。大きな変更の場合は、先に Issue で相談してください。
