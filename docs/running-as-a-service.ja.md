# Hubをサービスとして動かす

> [English / 英語](running-as-a-service.md)

Hubはworkerスレッド上で**event-loop watchdog**を動かしています。`better-sqlite3`は同期的なので、**病的なクエリ1つがプロセス全体を止め得ます** — 「ページが遅い」ではなく「障害」に見える種類の失敗です。メインスレッドが閾値（既定120秒、`EGRESSVIEW_WATCHDOG_STALL_MS`）を超えて応答しなくなると、watchdogはプロセスへ**ブロック不能なSIGKILL**を送ります。

**これは、何かが再起動してくれる場合にのみ良い取引です。** このページの内容はすべて、その「何か」を確実にするためにあります。**Hubはスーパーバイザ配下で動かしてください。そうでなければ、watchdogを当てにしないでください。**

## systemd

[`deploy/egressview.service`](../deploy/egressview.service)がサポート対象のunitです。中のパスとユーザーはプレースホルダです。

```bash
sudo install -m 0644 deploy/egressview.service /etc/systemd/system/
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now egressview
```

2つのディレクティブは好みではありません。

| ディレクティブ | 理由 |
|---|---|
| `Restart=always` | Hubには「戻ってくるな」を意味する終了コードが無く、`on-failure`だけではSIGKILLを正常終了と読む場合がある |
| `StartLimitIntervalSec=0` | 既定では**10秒間に5回**の再起動で systemd が諦め、unitをfailedのまま放置する。**病的なクエリが持続したときにまさに起きる形**であり、繰り返す停止を**恒久的な障害に変えてしまう。** 永久にゆっくり再起動し続ける方がましな失敗である——再起動の合間はサービスが応答し、ログが理由を語る |

## コンテナ

[`Dockerfile`](../Dockerfile)が本番用イメージです。`Dockerfile.demo`は別物で、合成データを同梱し書き込み禁止で動きます。

```bash
docker build -t egressview .
```

```bash
docker run -d --restart=on-failure:10 --init -p 3000:3000 -v egressview-data:/data --env-file .env egressview
```

- **`--restart`は任意ではありません。** 冒頭の理由によります。**イメージは自分自身を再起動できません。**
- **`--init`** はコンテナに本物のPID 1を与え、シグナルとプロセス回収を正しく振る舞わせます。
- **状態はvolumeに置きます。** イメージはデータベースを持ちません——持てるイメージは、**1台分の通信記録をそのイメージのすべての複製へ運んでしまいます。** `/data`にデータベース・バックアップ・設定が入ります。
- `HEALTHCHECK`が見るのは`/healthz`ではなく**`/readyz`**です。前者は「プロセスが応答する」、後者は「データベースとマイグレーションが使える」を意味し、**スーパーバイザが反応すべきなのは後者**です。

CIは変更のたびにこのイメージをビルドし、コンテナを起動し、ready報告を待ち、データベースがイメージではなくvolume側にあることを確認します。**テストされていないDockerfileをリポジトリに置くことは、裏付けの無い「サポート対象」の主張です。**

## 監督が実際に効いているか確かめる

**止めても構わないマシンで一度だけ実施してください。これ以外に証明する方法はありません。**

```bash
sudo systemctl show egressview -p Restart -p RestartSec -p StartLimitIntervalSec
```

```bash
sudo kill -9 "$(systemctl show egressview -p MainPID --value)"
```

`RestartSec`以内に再び応答していれば正常です。**そうでなければ、このホストでwatchdogは多層防御ではなく、単にHubを止める仕組みです。**
