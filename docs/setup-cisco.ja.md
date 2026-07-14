# Cisco IOS — SSH 設定ガイド

EgressViewで正式対応しているCisco IOSルータの準備手順です。

> **正式対応:** C841M-4X-JSEC/K9（IOS 15.5(3)M9）でSSH、enable、NAT/ARP/NDP、verbose、TOFU、自動再接続を実機検証済みです。

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

旧IOSで鍵交換エラーになる場合は、まず`diffie-hellman-group14-sha1`だけを追加して確認してください。EgressViewはこの方式に対応していますが、弱い`group1-sha1`は許可しません。

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

設定 → `L3/L4` を開いてルーター行を追加し、以下を入力します。

| 項目 | 値 |
|------|----|
| Cisco IOS の IP | ルータの LAN 側 IP |
| ユーザー名 | SSH ログイン用ユーザー |
| パスワード | SSH ログイン用パスワード |
| Enable パスワード | 任意。非特権モードで着地する構成なら必要 |

まず **接続して自動検出** を押し、成功したら保存してください。

Yamaha RTXとCisco IOSを任意に組み合わせ、最大10台まで有効化できます。物理または論理ルーターごとに一意な名前を付けてください。EgressViewは安定したrouterIdを生成・保存し、各ルーターを独立してポーリングします。複数ルーターが同じ通信を報告した場合も、すべての観測元routerIdを保持します。

---

## 現状の制限

- 正式な実機検証範囲はC841M-4X-JSEC/K9 / IOS 15.5(3)M9。その他のIOS機器はCLI互換性に依存する
- `enable` パスワードの流れはプロンプトや権限モデル差異の影響を受けうる
- NAT コマンド出力形式は機種差がありうる
- 複数ルーター自動試験はYamaha/Cisco混在fake router 10台、同時接続最大3、1台の障害分離、重複排除を対象としている
- 実機補足試験はCisco 1台とYamaha 1台を異なるrouterIdで各2重登録したもの。同一メーカーの異なる実機複数台を検証したものではない
- EgressViewはルーター状態を観測するが、HSRP/VRRPの設定・制御、NAT状態同期、フェイルオーバーは行わない

別機種での動作報告や、機密情報を除去した出力fixtureを歓迎します。
