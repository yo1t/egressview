# EgressView Agent for macOS

ルーターからは分からない「Mac上のどのアプリが外部へ接続したか」を確認するためのAgentです。取得するのはアドレス、ポート、プロセス名などの通信メタデータだけです。**通信内容を読み取らず、復号せず、通信を遮断しません。**

HostアプリとNetwork ExtensionはmacOSのApp Sandbox内で動作します。HostにはHub送信と署名済み更新確認に必要な外向き通信だけを許可し、Extensionには一般的な外向き・受信ネットワーク権限を与えません。両者が共有するのはEgressView専用のApp Group領域だけで、ホームディレクトリやAWS CLIのファイルを読む例外権限は付けていません。

## 必要な環境

- macOS 13以降
- EgressView Hub 1.9.0以降
- Hubの設定を操作できる管理者

## インストール

1. [GitHub Releases](https://github.com/yo1t/egressview/releases)から`egressview-agent-<version>.dmg`を取得します。
2. **EgressView Agent**を**アプリケーション**へ移動して起動します。
3. **ネットワーク監視**を選び、macOSのSystem Extensionを承認します。正式Sandbox版では、監視方式を迷わず選べるよう軽量監視を表示しません。
4. Hubの設定で6文字の登録コードを発行します。
5. Agentの**設定 > Hub**へHubのアドレスと登録コードを入力し、Hub側で申請を承認します。

Hubへの送信は既定で無効です。送信先と送信項目を確認して有効にするまで、このMacから観測結果を送信しません。AgentからHubへ接続する方式であり、HubからMacをポーリングしません。

## アンインストール

先にアプリをゴミ箱へ入れないでください。EgressView Agentの**設定 > アンインストール**を開き、削除対象を確認して実行します。

1. Hubへの送信を停止し、Hub上のこのMacの登録を失効します。
2. ネットワークフィルタ設定とSystem Extensionを削除します。
3. ログイン項目、Hub資格情報、送信待ちキューを削除します。
4. 選択した場合だけローカル通信履歴を削除します。
5. Finderでアプリを表示するので、Agentを終了してゴミ箱へ移動します。

ローカル履歴は既定で残します。Hubがすでに受理したデータはHubから削除しません。Hubへ接続できない場合は資格情報を保持して再試行できます。ローカル処理だけを続ける場合は、HubのAgent設定から手動で登録を失効してください。System Extensionの削除にはmacOSの承認や再起動が必要になる場合があります。

## 開発者向け情報

ビルド、署名、公証、実装の詳細は[英語README](README.md)を参照してください。
