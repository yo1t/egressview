# AI洞察セットアップ

AI洞察はEgressViewの先頭タブ兼スタートページです。上段の収集状態、接続数、端末数、
宛先数、脅威数、前期間比較はローカル集計で、AI未設定でも利用できます。生成AIへの送信は
**分析**または**質問する**を明示的に実行した時だけです。

## Provider

| Provider | 認証 | 送信先 |
|---|---|---|
| Ollama | 不要 | 設定したlocal/private endpoint |
| Anthropic | API key | Anthropic Messages API |
| OpenAI | API key | OpenAI Responses API |
| Amazon Bedrock | AWS SDK default credential chain | 選択regionのBedrock Runtime |

*設定 → AI洞察*でprovider、model、必要な認証を設定し、cloud providerでは外部送信への
同意を有効化します。BedrockはAWS keyを入力・保存しません。詳細は
[Bedrock設定ガイド](setup-bedrock.ja.md)を参照してください。

## 送信データと安全境界

- 選択期間の接続集計には通信先IP、hostname、端末名、MAC、脅威件数が含まれます。
- Router管理IP、username/password、enable password、API key、admin token、raw logは送りません。
- 対象期間は最大14日、promptと応答に上限があり、timeoutは30秒、同時実行は全体で1件です。
- Anthropic / OpenAI / Bedrockは保存済み同意に加え、分析実行時にも確認します。
- AI失敗・遅延はrouter収集、SQLite、Socket.IO、他画面を停止させません。

## 会話履歴

会話とメッセージはschema v6へappend-onlyで保存され、再起動後も復元されます。各assistant
回答にはproviderとmodelを保存します。schema v7以降の成功回答は同じrequest IDのusageと
結合し、input/output/total tokenと概算料金も表示します。記録開始前の履歴はprovider/model
だけを表示し、tokenや料金を逆算しません。

## 使用量と料金

AI洞察には今月・先月の呼び出し回数、input/output/total token、概算USDを表示します。
英語UIは`$0.0012`、日本語UIは`USD 0.0012`です。言語による為替換算は行いません。

概算は呼び出し時点のversioned内蔵料金表を使います。未知modelはtokenを保持して「料金未設定」
とし、0 USDとして扱いません。Guardrails、cached token、batch/service tier、税、為替、
providerやAWSの契約割引、失敗時にprovider側だけで発生した費用は含まれません。請求確認には
各providerのbilling consoleを使用してください。

## Privacy上の選択

外部送信を避ける場合はAIを無効のまま使うか、管理下のOllamaを選択してください。Cloud
provider利用時はEgressViewをHTTPSまたは信頼できるVPN内に置き、API keyと設定ファイルを
mode `0600`で保護してください。
