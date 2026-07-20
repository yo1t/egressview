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

- 選択期間の接続集計には通信先IP、hostname、脅威件数と、通信量を優先した最大30台の端末一覧が含まれます。端末情報にはIP、名前、MAC、vendor、IPv6、初回/最終観測、収集元、状態、接続数を含み得ます。
- ASUS情報がある場合は、最大10件のmesh node要約と、nodeごとの接続台数・代表端末最大5台も含めます。
- Router/node管理IP、端末メモ、archive済み端末、username/password、enable password、API key、admin token、raw logは送りません。
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

概算は呼び出し時点のversioned内蔵料金表を使います。料金表は
`src/data/ai-pricing.json`に分離され、各entryにprovider/model matcher、単価、発効日、根拠URLを
持ちます。更新後も過去行は保存済みのversionと単価で集計され、再計算されません。未知modelは
tokenを保持して「料金未設定」とし、0 USDとして扱いません。成功してもproviderがusageを
返さなかった呼び出しは、未知料金とは別の「token使用量なし」として件数を表示します。
未価格usageがある場合、USDを部分合計と明記し、未価格token数・request数・model IDを別表示します。
設定画面でも取得候補と手入力modelを「料金対応済み / 料金未設定」として利用前に確認できます。
Guardrails、cached token、batch/service tier、税、為替、
providerやAWSの契約割引、失敗時にprovider側だけで発生した費用は含まれません。請求確認には
各providerのbilling consoleを使用してください。

## Privacy上の選択

外部送信を避ける場合はAIを無効のまま使うか、管理下のOllamaを選択してください。Bedrockも
requestをAWSへ送るため、local Ollamaと同じではありません。標準的なBedrockのデータ保護では
prompt/応答をmodel providerへ公開せずbase modelの学習にも使いませんが、modelのdata-retention
modeによってprovider共有の例外があり得るため利用modelの条件を確認してください。Cloud provider
利用時はEgressViewをHTTPSまたは信頼できるVPN内に置き、API keyと設定ファイルをmode `0600`で
保護してください。
