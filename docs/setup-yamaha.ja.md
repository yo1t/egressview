# Yamaha RTX — SSH 設定ガイド

Widemap が接続できるよう、Yamaha RTX ルーターの SSH アクセスを有効化する手順です。

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
# Widemap 専用ユーザーを作成（"widemap" とパスワードは任意の値に変更してください）
login user widemap yourpassword
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

## Step 4 — NAT ディスクリプタ番号を確認

Widemap は NAT セッションテーブルを読み取ります。ルーターで使用しているディスクリプタ番号を確認します：

```
show nat descriptor
```

出力例：
```
NAT descriptor list:
  100: masquerade
```

この番号（通常は `100`）を控えておきます。Widemap の設定パネルで入力します。

---

## Step 5 — 設定を保存

```
save
```

---

## Step 6 — PC/Mac から SSH 接続をテスト

```bash
ssh widemap@192.168.1.1
```

ログインできれば設定完了です。

---

## Step 7 — Widemap に設定を入力

Widemap の設定パネル（⚙）を開き、以下を入力します：

| 項目 | 値 |
|------|---|
| Yamaha RTX の IP アドレス | ルーターの LAN 側 IP（例: `192.168.1.1`） |
| SSH ユーザー名 | `widemap`（または設定した名前） |
| SSH パスワード | 設定したパスワード |
| NAT ディスクリプタ番号 | `show nat descriptor` で確認した番号（例: `100`） |

---

## トラブルシューティング

**SSH 接続が拒否される**
- `ip ssh service on` を実行して `save` したか確認してください
- PC/Mac とルーターが同じ LAN 上にあるか確認してください

**認証に失敗する**
- `show login user` でユーザー名を確認してください
- パスワードを再設定: `login user widemap newpassword` → `save`

**Widemap にセッションが表示されない**
- NAT ディスクリプタ番号が `show nat descriptor` の結果と一致しているか確認してください
- ルーターで `show nat descriptor address 100 detail` を実行してセッションが存在するか確認してください

---

## セキュリティに関する注意

- SSH アクセスはデフォルトで LAN 内のデバイスに限定されます（インターネットには公開されません）
- Widemap はセッション情報の読み取りのみを行います。ルーターの設定を**変更しません**
- ファームウェアが対応していれば `login user privilege` で SSH ユーザーを読み取り専用に制限できます
