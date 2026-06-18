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

## トラブルシューティング

**SSH 接続が拒否される**
- `ip ssh service on` を実行して `save` したか確認してください
- PC/Mac とルーターが同じ LAN 上にあるか確認してください

**認証に失敗する**
- `show login user` でユーザー名を確認してください
- パスワードを再設定: `login user egressview newpassword` → `save` <!-- pragma: allowlist secret -->

**EgressView にセッションが表示されない**
- NAT ディスクリプタ番号が `show nat descriptor` の結果と一致しているか確認してください
- ルーターで `show nat descriptor address 100 detail` を実行してセッションが存在するか確認してください

---

## セキュリティに関する注意

- SSH アクセスはデフォルトで LAN 内のデバイスに限定されます（インターネットには公開されません）
- EgressView はセッション情報の読み取りのみを行います。ルーターの設定を**変更しません**
- ファームウェアが対応していれば `login user privilege` で SSH ユーザーを読み取り専用に制限できます
