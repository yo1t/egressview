# Cisco IOS — SSH 設定ガイド

EgressView で Cisco IOS ルータを試すための準備手順です。

> **現在の位置づけ:** EgressView の Cisco ルータ対応は **サンプル実装** です。**実機での評価はまだ完了していません。** 実機テスト完了までは beta 扱いとして利用してください。

---

## EgressView が前提としていること

現時点では、Cisco IOS 機器に対して次のことを前提にしています。

- SSH でログインできる
- `show ip nat translations` が実行できる
- 必要に応じて `enable` で特権EXECへ入れる
- ローカル端末の対応付けに使う ARP 情報が参照できる

機種、IOS バージョン、権限設計によっては、自動検出や定期取得が期待通りに動かない場合があります。

実機でエラーを見つけた場合は、GitHub Issue で以下を共有してください。

- ルータの機種名
- IOS バージョン
- `enable` が必要かどうか
- 機密情報をマスクした `show ip nat translations` の出力
- 機密情報をマスクした `show arp` の出力
- 関連する EgressView のログ

未対応の出力形式については、機密情報をマスクした fixture とパーサテストを含む Pull Request も歓迎します。

---

## Step 1 — SSH アクセスを有効化

設定例:

```text
hostname edge-router
ip domain-name home.local
crypto key generate rsa modulus 2048
ip ssh version 2

username egressview privilege 15 secret yourpassword

line vty 0 4
 login local
 transport input ssh
```

権限を抑えたユーザーで運用し、必要なときだけ `enable` を使いたい場合は、その方針に合わせて設定し、EgressView 側にも enable パスワードを入力してください。

---

## Step 2 — NAT 情報が見えることを確認

EgressView は NAT translation table を読み取ります。まず次のコマンドが使えるか確認してください。

```text
show ip nat translations
```

アクティブな translation が返ってくれば、基本的な取得経路はあります。

このコマンドが使えない、権限不足になる、通信があるのに空になる、といった場合は、EgressView で L3/L4 セッションを安定取得できません。

対応機器では、EgressView は `show ip nat translations verbose` を優先して使います。エントリごとの `create` / `left` の経過時間から、各セッションの正確な開始時刻と残存 TTL を取得できるためです。verbose キーワードが拒否される機器では、自動的に通常のコマンドへフォールバックします。

```text
show ip nat translations verbose
```

---

## Step 3 — ARP 情報が見えることを確認

ローカル端末への対応付けのため、ARP 情報もあると有利です。

```text
show arp
```

ARP 出力が参照できない場合でも接続情報自体は見えることがありますが、端末識別の精度は下がる可能性があります。

---

## Step 4 — 同じログイン経路を手動確認

EgressView を動かすマシンから:

```bash
ssh egressview@192.168.1.1
```

ログイン後に次を確認します。

```text
terminal length 0
show ip nat translations
show arp
```

`enable` が必要な構成なら、その流れも確認してください。

```text
enable
```

---

## Step 5 — EgressView に設定を入力

設定 → `L3/L4` を開き、以下を入力します。

| 項目 | 値 |
|------|----|
| Cisco IOS の IP | ルータの LAN 側 IP |
| ユーザー名 | SSH ログイン用ユーザー |
| パスワード | SSH ログイン用パスワード |
| Enable パスワード | 任意。非特権モードで着地する構成なら必要 |

まず **接続して自動検出** を押し、成功したら保存してください。

---

## 現状の制限

- 実機での評価はまだ未完了
- IOS バージョンや機種により挙動差がありうる
- `enable` パスワードの流れはプロンプトや権限モデル差異の影響を受けうる
- NAT コマンド出力形式は機種差がありうる

実機で試して、動いた・動かなかった・特定の出力差分があった、というフィードバックは、サンプル実装から正式対応へ進めるうえでかなり重要です。
