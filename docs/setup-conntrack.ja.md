# Linux conntrack ルーター設定（プレビュー）

EgressViewは、`/proc/net/nf_conntrack`または`conntrack -L`を利用できるLinux系ルーターから、SSH経由でIPv4 NATセッションを収集できます。

> privileged Linuxルーターコンテナを使ったSSH自動統合試験は完了しています。OpenWrt、ASUSWRT/Merlin、Ubiquiti実機の確認は未完了のため、現時点ではプレビュー機能です。

## 必要条件

- EgressViewから到達できるプライベートIPv4管理アドレス
- TCP 22番でのSSHパスワード認証
- conntrack状態を読めるアカウント。通常は`root`または`CAP_NET_ADMIN`相当の権限
- 端末・LAN IP検出に使う`ip -4 neigh`、`ip -6 neigh`、`ip -o -4 addr`

EgressViewは最初に`cat /proc/net/nf_conntrack`を実行します。パスが存在しない場合や権限不足の場合は`conntrack -L`へ切り替えます。両方とも利用できない場合は、空のセッションとして成功扱いせず、原因を含むエラーにします。

## 登録手順

1. **設定 > ルーター**を開き、**Linux conntrack**を選択します。
2. 管理IP、SSHユーザー名、パスワードを入力します。
3. **接続して自動検出**を押し、SSH、LAN IP、セッション数が表示されることを確認します。
4. 保存後、ルーターの状態が緑になることを確認します。

初回接続時にSSHホスト鍵を固定します。ホスト鍵が変わった場合は、管理IPを意図的に変更するか登録を作り直すまで接続を拒否します。

ルーターSSHをインターネットへ公開せず、管理ネットワークまたはVPN内で利用してください。機種側で可能なら必要な読み取り権限だけを付与してください。SSHパスワードはGit対象外かつ`0600`の`.egressview.json`へ保存されます。
