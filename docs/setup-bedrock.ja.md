# Amazon Bedrock（AI洞察）セットアップ

EgressView は AI 洞察タブの AI プロバイダーとして Amazon Bedrock を利用できます。
Bedrock は **キーレス**です。EgressView は AWS 認証情報を保存しません。認証は
AWS SDK for JavaScript v3 の **default credential provider chain** に完全委譲し、
設定 UI では AWS **リージョン**と**モデル / 推論プロファイル ID** だけを設定します。

> AI は読み取り専用です。送信されるのは上限内の集計で、通信先 IP・ホスト名・端末名を
> 含みます。ただし MAC・ルーター認証情報・通信ログ全件は送信しません。

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

## 接続確認

Bedrock の場合、**保存して接続確認**ボタンは次を行います。

1. fail-open のモデル discovery で候補を取得し、
2. Converse で最小の固定文字列生成を送り、`bedrock:InvokeModel` が実際に機能するか
   検証します（通信・端末・脅威データは送信しません）。

認証・権限・throttling・timeout・非対応モデル / リージョンの問題は短いエラーメッセージ
として表示されます。
