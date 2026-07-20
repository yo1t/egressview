# Amazon Bedrock（AI洞察）セットアップ

EgressView は AI 洞察タブの AI プロバイダーとして Amazon Bedrock を利用できます。
Bedrock は **キーレス**です。EgressView は AWS 認証情報を保存しません。認証は
AWS SDK for JavaScript v3 の **default credential provider chain** に完全委譲し、
設定 UI では AWS **リージョン**と**モデル / 推論プロファイル ID** だけを設定します。

> AIは読み取り専用です。上限付きの接続集計、端末一覧、network node要約を送信します。
> 認証情報、端末メモ、生ログ、管理IPは送信しません。

## データ処理の境界

BedrockはOllamaのようなlocal providerではありません。分析requestはEgressView hostを出て、
選択model/profileのrouting境界に従ってAWSで処理されます。AWSの標準的なBedrockデータ保護では、
model providerは利用者のprompt/応答へアクセスせず、入出力はbase modelの学習に使われません。
ただしmodelによってはprovider data sharingを含む別のdata-retention modeがあり得るため、有効化前に
利用modelの最新条件を確認してください。このためEgressViewはBedrockにも明示的なcloud同意を必須とします。

AWS公式の[Bedrock data protection](https://docs.aws.amazon.com/bedrock/latest/userguide/data-protection.html)と
[model data-retention mode](https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html)も確認してください。

## 前提条件

AWS SDK（`@aws-sdk/client-bedrock-runtime` と `@aws-sdk/client-bedrock`）は通常
依存として同梱されるため、`npm install` の時点で Bedrock サポートも入ります
（追加インストール不要）。

1. 対象リージョンで Amazon Bedrock を有効化した AWS アカウント。
2. 使用するモデルの **モデルアクセス / サブスクリプション**。サーバーレス基盤
   モデルは初回呼び出しで自動有効化されますが、サードパーティの **AWS Marketplace
   提供モデル（例: Anthropic Claude）は一度だけサブスクリプションが必要**です。
   下記の[Marketplace サブスクリプション](#marketplace-サブスクリプション初回のみ)を参照。
3. EgressView を動かすホストで、AWS SDK 標準 chain により解決できる認証情報。

## 環境別の認証

EgressView は独自の認証探索順を持たず、AWS SDK v3 の標準 chain（概ね 環境変数 →
SSO キャッシュ → Web Identity → 共有 config/credentials → EC2/ECS/EKS メタデータ）に
委譲します。最初に解決できた認証情報を使い、有効期限付きの一時認証情報の更新は
SDK に任せます。

- **EC2 / ECS / EKS:** 必要な Bedrock 権限を持つインスタンスプロファイル / タスク
  ロール / IRSA ロールを付与すれば、他の設定は不要です。
- **自宅サーバ / VPS / Docker（AWS 外）:** 環境変数
  `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`、または共有認証ファイル
  （`~/.aws/credentials`、`aws configure` で設定）を用意します。
- **AWS IAM Identity Center（SSO）:** `aws sso login` を実行し、ポータルセッション
  から一時認証情報を解決できるようにします。**SSO ポータルセッションが失効すると
  EgressView は自動復旧できません。再度 `aws sso login` してください。** それまで
  接続確認は認証エラーを表示します。

## 必要な IAM 権限

- **生成（必須）:** 使用するモデル / 推論プロファイルに対する `bedrock:InvokeModel`。
  Converse API は `bedrock:InvokeModel` で認可されます。
- **cross-region 推論プロファイル:** 地理プロファイル（下記）を使う場合、**推論
  プロファイル**に加え、その地理の**各宛先リージョンの基盤モデルリソース**に対する
  `bedrock:InvokeModel` も必要です。
- **モデル discovery（任意）:** `bedrock:ListFoundationModels` と
  `bedrock:ListInferenceProfiles` はモデル候補の取得に使います。discovery は
  fail-open で、無くてもモデル / プロファイル ID を直接入力できます。なお一覧取得
  の成功は `bedrock:InvokeModel` の付与を意味しないため、接続確認では最小の生成
  呼び出しも行います。

### 最小IAMポリシー例

実行ロールには、実際に使う推論プロファイルと基盤モデルだけを許可します。次は
`jp.`プロファイルを使う場合の骨格です。`ACCOUNT_ID`、`PROFILE_ID`、`MODEL_ID`を実値へ
置き換え、destination regionは選択したプロファイルの現在の構成に合わせてください。

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "InvokeConfiguredProfile",
      "Effect": "Allow",
      "Action": "bedrock:InvokeModel",
      "Resource": "arn:aws:bedrock:ap-northeast-1:ACCOUNT_ID:inference-profile/PROFILE_ID"
    },
    {
      "Sid": "InvokeOnlyThroughConfiguredProfile",
      "Effect": "Allow",
      "Action": "bedrock:InvokeModel",
      "Resource": [
        "arn:aws:bedrock:ap-northeast-1::foundation-model/MODEL_ID",
        "arn:aws:bedrock:ap-northeast-3::foundation-model/MODEL_ID"
      ],
      "Condition": {
        "StringEquals": {
          "bedrock:InferenceProfileArn": "arn:aws:bedrock:ap-northeast-1:ACCOUNT_ID:inference-profile/PROFILE_ID"
        }
      }
    },
    {
      "Sid": "DiscoverModelsAndProfiles",
      "Effect": "Allow",
      "Action": [
        "bedrock:ListFoundationModels",
        "bedrock:ListInferenceProfiles"
      ],
      "Resource": "*"
    }
  ]
}
```

`GetInferenceProfile`の`models`に返るARNを使うと、destination regionの手入力ミスを避けられます。
[AWS公式の地理profile IAM例](https://docs.aws.amazon.com/bedrock/latest/userguide/geographic-cross-region-inference.html)と
照合し、profile変更時はpolicyも見直してください。

Guardrailsを使う場合だけ、対象guardrail ARNへの`bedrock:ApplyGuardrail`と、設定画面で
自動検出する場合だけ`bedrock:ListGuardrails`（`Resource: "*"`）を追加します。モデルIDを
直接入力する運用ならdiscovery statementは削除できます。Marketplace購読権限は常設しません。

## Marketplace サブスクリプション（初回のみ）

**AWS Marketplace 提供のサードパーティモデル（例: Anthropic Claude）**は、呼び出す
前に **アカウントで一度サブスクリプションを確立**する必要があります。未確立の間は、
`bedrock:InvokeModel` を `Resource: "*"` で付与していても、次のように失敗します。

> `AccessDeniedException ... not authorized to perform the required AWS
> Marketplace actions (aws-marketplace:ViewSubscriptions, aws-marketplace:Subscribe)`

`aws-marketplace:*` 権限は**サブスク確立時にだけ**必要で、確立後はサブスクが
**アカウント全体に永続**するため `bedrock:InvokeModel` だけで動作します。AWS 純正
モデル（例: Amazon Nova）は Marketplace サブスク不要です。

サブスクは**一度だけ**確立し、実行ロールは最小権限に戻します。

**方法A（推奨）— 管理者がサブスク、サービスロールは触らない。**
`aws-marketplace:ViewSubscriptions` と `aws-marketplace:Subscribe` を持つ
ユーザー/プリンシパルが、対象モデルを一度呼び出す（Bedrock コンソールの playground、
AWS Marketplace コンソール、または CLI）。以後アカウント全体で有効になります。

**方法B — サービスロールに一時付与して、後で削除する。**

1. EgressView ロールに次を追加して保存:
   ```json
   { "Sid": "BedrockMarketplaceSubscribe", "Effect": "Allow",
     "Action": ["aws-marketplace:ViewSubscriptions", "aws-marketplace:Subscribe"],
     "Resource": "*" }
   ```
2. モデルを一度呼び出す（設定の**保存して接続確認**ボタン、または
   `aws bedrock-runtime converse ...`）。反映に約2分かかることがあります。
   `jp.`/`apac.` プロファイルは複数の宛先リージョン（`jp.` なら東京＋大阪）に
   ルーティングし各リージョンでサブスクが要るため、安定して成功するまで数回叩く。
3. **`BedrockMarketplaceSubscribe` の Statement を削除**して最小権限に戻す。
   サブスクは残るので、`bedrock:InvokeModel` だけで生成は動き続けます。

> **再サブスク:** 後で**未サブスクの別モデル**へ切り替える場合は、そのモデルに対し
> 再度サブスクが必要です（方法A/B を再実施、または管理者がサブスク）。権限削除は
> 恒久的なロックアウトではなく、新モデル導入時に一度だけ再サブスクが要るという意味です。

> **組織の制限:** AWS Organizations の **SCP** や **Private Marketplace** で
> サブスク自体がブロックされている場合、`aws-marketplace:Subscribe` を持つユーザー
> でも完了できません。組織/調達（procurement）管理者がサブスクを許可するか、対象
> 製品を Private Marketplace に追加する必要があります。

## リージョンとモデル / 推論プロファイルの選択

*設定 → AI 洞察* で **Amazon Bedrock** を選び、次を設定します。

- **AWS リージョン（source region）:** 例 `ap-northeast-1`（東京）、`us-east-1`。
- **モデル:** 基盤モデル ID、**cross-region 推論プロファイル ID**、または ARN。
  候補から選ぶか、ID を直接入力できます。

### Cross-region 推論（CRIS）

JP に限らず、どの CRIS も選択できます。

| 選択 | プロファイル接頭辞 | データのルーティング |
|------|------------------|--------------------|
| Global | `global.` | 全 commercial リージョン（地理境界なし） |
| US | `us.` | US 地理内のリージョン |
| EU | `eu.` | EU 地理内のリージョン |
| APAC | `apac.` | APAC 地理内のリージョン |
| **Japan** | `jp.` | 東京（ap-northeast-1）・大阪（ap-northeast-3）＝日本内処理 |
| Australia | `au.` | Australia 地理内のリージョン |

地理プロファイルは推論リクエスト全体をその地理内に保ちます。**Global** は任意の
commercial リージョンへルーティングされ得る（レジデンシー保証なし）ため、レイテンシ・
スループット・データレジデンシーの要件で選んでください。日本内データレジデンシー
用途では `jp.` プロファイル（例
`jp.anthropic.claude-sonnet-4-5-20250929-v1:0`）を使います。

**可用性は AWS の提供状況に依存します。** すべてのモデルがすべての地理でプロファイルを
持つわけではありません（例: Japan CRIS は特定の Claude モデルから提供開始）。特定地理
での処理が必須なら、その地理にプロファイルがあるモデルに限られます。

## Guardrails（任意・デフォルトOFF）

Bedrock の生成に Amazon Bedrock Guardrail を適用できます。*設定 → AI 洞察* で
**Bedrock Guardrails を使う**を有効化し、guardrail の **ID/ARN** と**バージョン**
（既定 `DRAFT`）を入力します。有効時は Converse の `guardrailConfig` に渡されます。
`bedrock:ApplyGuardrail`（cross-Region guardrail profile 使用時は全 destination
region の profile object への `bedrock:ApplyGuardrail`）が必要です。

> ⚠ **Guardrails は日本内処理を保証しません。** **日本限定（`jp.`）の guardrail
> profile は存在しません**。APAC の guardrail profile（`apac.guardrail.v1:0`）は
> APAC 全域へルーティングされ、東京 source でもシンガポール・ムンバイ・ソウル・
> シドニー等で評価され得ます。したがって `jp.` モデル推論プロファイルを使っていても、
> cross-Region guardrail を有効化すると同じ入出力内容が日本外へ送られ得ます。
> 分類フラグ付きの入出力は不正利用検知のため最大30日保持され得ます。
>
> 日本内データレジデンシーが必須の場合は、Guardrails を **OFF** にするか、
> cross-Region guardrail profile ではなく**呼び出しリージョン内（例
> ap-northeast-1）の single-Region guardrail** を使ってください。

## モデル呼び出しログ（任意・デフォルトOFF）

Bedrockのアカウント／リージョン設定で、Converseの呼び出しをCloudWatch Logs、S3、または
両方へ保存できます。これはEgressViewのアプリ設定ではなくAWS側の設定です。**有効にすると
AIへ送った本文と回答も記録対象になり、EgressViewの場合はIP、ホスト名、端末名、MACを含み
得ます。** 先に保存期間、閲覧ロール、KMS暗号化、S3 lifecycleを決めてください。
詳細は[AWS公式のmodel invocation logging手順](https://docs.aws.amazon.com/bedrock/latest/userguide/model-invocation-logging.html)を参照してください。

1. Bedrock consoleの対象リージョンで *Settings → Model invocation logging* を開く。
2. 監査要件に必要なmodalityだけを選び、CloudWatch Logsまたは同一account/regionのS3を指定する。
3. CloudWatch log groupのretentionと、S3 lifecycle・Block Public Access・必要ならSSE-KMSを設定する。
4. `AWS/Bedrock`のdelivery failure metricsへalarmを設定し、テスト呼び出しが届くことを確認する。

秘密情報の長期保存を避ける場合は本文loggingを有効にせず、標準のCloudWatch runtime metricsで
呼び出し数、latency、token、errorだけを監視します。logging停止後も既存ログは自動削除されない
ため、保存先側のretention/lifecycleが必要です。

## VPC interface endpoint（PrivateLink、任意）

EC2等をprivate subnetで動かす場合、最低限`com.amazonaws.REGION.bedrock-runtime`のinterface
endpointを作成し、Private DNSを有効にするとEgressViewのコード変更なしでConverseをprivate
経路へ流せます。モデル／Guardrail discoveryもprivate経路にする場合は
`com.amazonaws.REGION.bedrock`も作成します。
[AWS公式のPrivateLink手順](https://docs.aws.amazon.com/bedrock/latest/userguide/vpc-interface-endpoints.html)も参照してください。

- endpoint security groupはEgressView hostからTCP 443だけを許可する。
- endpoint policyでも実行role、`bedrock:InvokeModel`、利用model/profileを絞る。
- private subnetのDNSで標準`bedrock-runtime.REGION.amazonaws.com`がprivate IPへ解決されることを確認する。
- Private DNSを無効にした独自endpoint URLは現在のEgressView設定では指定できないため、Private DNSを推奨する。
- cross-region inference profileはsource regionのendpointへ接続後、AWSサービス内で宛先regionへrouteされる。profile自体のresidency条件は別途確認する。

## SDKリトライ

既定の`standard` modeは指数backoffとjitterを使い、通常運用に推奨です。throttlingが継続し、
初回requestも遅延し得ることを許容できる単一workloadだけ`adaptive`を検討します。
[AWS SDK retry behavior](https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html)では
`standard`が既定、`adaptive`は特定用途向けと説明されています。

```dotenv
AWS_RETRY_MODE=standard
AWS_MAX_ATTEMPTS=3
```

`adaptive`は全workload向けの高速化設定ではありません。EgressView自身の30秒timeoutと単一実行制限は
維持されるため、attempt数を増やしすぎるとSDK retry完了前にtimeoutします。変更後はCloudWatchの
throttling、latency、errorを比較し、改善がなければ`standard`へ戻してください。

## 接続確認

Bedrock の場合、**保存して接続確認**ボタンは次を行います。

1. fail-open のモデル discovery で候補を取得し、
2. Converse で最小の固定文字列生成を送り、`bedrock:InvokeModel` が実際に機能するか
   検証します（通信・端末・脅威データは送信しません）。

認証・権限・throttling・timeout・非対応モデル / リージョンの問題は短いエラーメッセージ
として表示されます。

## Token使用量と概算料金

成功したConverse応答のusageをschema v7へappend-onlyで記録し、AI洞察スタートページに
今月・先月のtoken数と概算USDを表示します。会話履歴の各回答にもprovider、model、token、
概算料金を表示します。日本語UIは`USD 0.0012`、英語UIは`$0.0012`表記です。

これはAWS請求額ではありません。呼び出し時点の内蔵料金表による概算で、Guardrails、
prompt caching、税、為替、契約割引等を含みません。未知modelはtokenだけを記録して料金を
推測しません。詳細は[AI洞察設定ガイド](setup-ai-insights.ja.md)を参照してください。
