# Yamaha RTX — SSH 設定ガイド

EgressView が接続できるよう、Yamaha RTX ルーターの SSH アクセスを有効化する手順です。

**対応モデル:** RTX1200, RTX1210, RTX1220, RTX1300, RTX810, RTX830, NVR500, NVR510, NVR700W

---

## Step 1 — ルーターにログイン

Web インターフェースまたはシリアル/Telnet 接続でルーターのコンソールにアクセスします。

**Web インターフェース:** ブラウザで `http://<ルーターのIP>/` を開き、管理者としてログインします。

**Telnet（有効な場合）:**
```bash
telnet 192.168.1.1
```

---

## Step 2 — SSH 用ログインユーザーを作成

```
# EgressView 専用ユーザーを作成（"egressview" とパスワードは任意の値に変更してください）
login user egressview yourpassword <!-- pragma: allowlist secret -->
```

> **ポイント:** 管理者アカウントではなく専用ユーザーを使うことで、万が一の認証情報漏洩時の影響範囲を限定できます。

---

## Step 3 — SSH サービスを有効化

```
ip ssh service on
```

SSH サービスが起動しているか確認します：
```
show ip ssh
```

正常時の出力例：
```
SSH service     : enable
...
```

---

## Step 4 — NAT が設定されているか確認（まだの場合はサンプルを参考に設定）

EgressView は NAT セッションテーブルを読み取るため、ルーターで NAT（masquerade）が動作していることが前提です。

まず現在の設定を確認します：

```
show nat descriptor
```

出力例（正常）：
```
NAT descriptor list:
  100: masquerade
```

上記のように `masquerade` が表示されていれば NAT は設定済みです。**Step 5 へ進んでください。**

---

### NAT が設定されていない場合 — 設定サンプル

> ⚠️ **以下のアドレスはすべてダミーです。実際の環境に合わせて変更してください。**
> プロバイダーや契約内容によって設定が異なります。不明な場合はプロバイダーのマニュアルまたはサポートに確認してください。

```
# LAN 側インターフェース（実際の LAN アドレスに変更）
ip lan1 address 192.168.1.1/24

# WAN 側デフォルトルート（プロバイダーから指定されたゲートウェイ IP に変更）
ip route default gateway 203.0.113.1

# NAT ディスクリプタの設定
nat descriptor type 100 masquerade
nat descriptor address outer 100 primary

# 基本的なセキュリティフィルター（Windows ファイル共有等をブロック）
ip filter 200010 reject * * udp,tcp * 135
ip filter 200020 reject * * udp,tcp 135 *
ip filter 200030 reject * * tcp * 139
ip filter 200040 reject * * tcp 139 *
ip filter 500000 pass * * * * *

# WAN インターフェースに NAT とフィルターを適用（lan2 は WAN ポートの名称に変更）
ip lan2 nat descriptor 100
ip lan2 secure filter in 200010 200020 200030 200040
ip lan2 secure filter out 500000

# 設定を保存
save
```

> **よくある変更点:**
> - `192.168.1.1/24` → 実際の LAN アドレス（例: `192.168.0.1/24`）
> - `203.0.113.1` → プロバイダーから指定されたゲートウェイ IP（PPPoE の場合は `pp 1` を使う場合もあり）
> - `lan2` → WAN ポートの名称（環境によって `lan2` / `pp 1` 等が異なる）

---

## Step 5 — NAT ディスクリプタ番号を確認

EgressView は NAT セッションテーブルを読み取ります。ルーターで使用しているディスクリプタ番号を確認します：

```
show nat descriptor
```

出力例：
```
NAT descriptor list:
  100: masquerade
```

この番号（通常は `100`）を控えておきます。EgressView の設定パネルで入力します。

---

## Step 6 — 設定を保存

```
save
```

---

## Step 7 — PC/Mac から SSH 接続をテスト

```bash
ssh egressview@192.168.1.1
```

ログインできれば設定完了です。

---

## Step 8 — EgressView に設定を入力

EgressView の設定パネル（⚙）を開き、以下を入力します：

| 項目 | 値 |
|------|---|
| Yamaha RTX の IP アドレス | ルーターの LAN 側 IP（例: `192.168.1.1`） |
| SSH ユーザー名 | `egressview`（または設定した名前） |
| SSH パスワード | 設定したパスワード |
| NAT ディスクリプタ番号 | `show nat descriptor` で確認した番号（例: `100`） |

---

## 自動検出の診断表示について

設定パネルの「接続して自動検出」ボタンを押すと、以下のいずれかが表示されます。

| 表示 | 意味 |
|------|------|
| `✓ SSH接続確認 OK` / `✓ NAT descriptor を検出` | 正常。「この設定を保存」で完了 |
| `✓ SSH接続確認 OK` / `✗ NAT descriptor が見つかりませんでした` | SSH は成功したが NAT が検出できない（後述） |
| `✗ SSH接続失敗` / 詳細メッセージ | SSH 接続自体が失敗（後述） |

---

## トラブルシューティング

### ✗ SSH接続失敗 — 接続拒否（ポート22が開いているか確認）

SSH サービスが有効になっていない、または LAN セグメントが異なる可能性があります。

```
ip ssh service on
save
```

ルーターで確認：
```
show ip ssh
```
`SSH service : enable` が表示されていれば有効です。EgressView と同じ LAN にいるか確認してください。

---

### ✗ SSH接続失敗 — 接続タイムアウト

IP アドレスが間違っているか、ルーターが応答していない可能性があります。

1. ルーターの IP アドレスを再確認する（`show ip route` などで確認）
2. PC/Mac から疎通確認：
   ```bash
   ping 192.168.1.1
   ssh egressview@192.168.1.1
   ```

---

### ✗ SSH接続失敗 — 認証失敗（ユーザー名・パスワードを確認）

ユーザー名またはパスワードが一致していません。

ルーターのコンソールで確認・再設定：
```
show login user
login user egressview newpassword  <!-- pragma: allowlist secret -->
save
```

---

### ✗ SSH接続失敗 — ホストキーが一致しません

**原因:** 以前の接続時に記録したルーターのSSHホスト鍵（hostFp）と、現在のルーターの鍵が異なっています。

**よくある原因:**
- ルーターを初期化・ファームウェア更新でホスト鍵が再生成された
- ルーターを別機器に交換した

**対処方法:**

設定ファイル `.egressview.json`（サーバーと同じディレクトリ）を開き、`yamaha.hostFp` フィールドを削除します：

```json
// 変更前
"yamaha": {
  "ip": "192.168.1.1",
  "user": "egressview",
  "hostFp": "abc123def456..."
}

// 変更後（hostFp 行を削除）
"yamaha": {
  "ip": "192.168.1.1",
  "user": "egressview"
}
```

EgressView を再起動後、「接続して自動検出」を再実行すると新しいホスト鍵を自動記録します。

> ⚠️ **セキュリティ上の注意:** ルーターの初期化や交換をした覚えがないのにこのエラーが出た場合は、ネットワーク上の機器を確認してから hostFp を削除してください（中間者攻撃の可能性があります）。

---

### ✓ SSH 成功 — NAT descriptor が見つかりません

SSH 接続は正常ですが、NAT セッションテーブルの読み取りに失敗しています。

**確認手順:**

1. ルーターで NAT が設定されているか確認：
   ```
   show nat descriptor
   ```
   `masquerade` が表示されていれば設定済みです。

2. NAT ディスクリプタ番号を手動で入力して再試行：
   設定パネルの「NAT ディスクリプタ番号」欄に `show nat descriptor` の番号（例: `100`）を入力してから検出を実行してください。

3. 実際にセッションが存在するか確認：
   ```
   show nat descriptor address 100 detail
   ```
   セッションが 0 件の場合、LAN 内の端末が通信するまで待ってから再試行してください。

---

### EgressView にセッションが表示されない（接続後）

接続は成功しているが通信ログが空の場合：
- NAT ディスクリプタ番号が正しいか再確認してください（`show nat descriptor`）
- ルーター上でセッションが発生しているか確認：`show nat descriptor address 100 detail`
- ポーリング間隔（デフォルト 30 秒）が経過するまで待ってください

---

## セキュリティに関する注意

- SSH アクセスはデフォルトで LAN 内のデバイスに限定されます（インターネットには公開されません）
- EgressView はセッション情報の読み取りのみを行います。ルーターの設定を**変更しません**
- ファームウェアが対応していれば `login user privilege` で SSH ユーザーを読み取り専用に制限できます
