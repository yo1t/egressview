# Amazon Bedrock（AI洞察）セットアップ

EgressView は AI 洞察タブの AI プロバイダーとして Amazon Bedrock を利用できます。
Bedrock は **キーレス**です。EgressView は AWS 認証情報を保存しません。認証は
AWS SDK for JavaScript v3 の **default credential provider chain** に完全委譲し、
設定 UI では AWS **リージョン**と**モデル / 推論プロファイル ID** だけを設定します。

> AI は読み取り専用です。送信されるのは上限内・匿名化済みの集計のみで、生の IP・
> MAC・端末名・ルーター認証情報・通信ログ全件は送信しません。

## Bedrock サポートを有効化（SDK を追加インストール）

AWS SDK は **optional peer dependency** で、**デフォルトではインストールされません**
（基本インストールを軽量に保つため）。Bedrock を使うホストで一度だけインストールします。

```bash
npm install @aws-sdk/client-bedrock-runtime @aws-sdk/client-bedrock
```

SDK 未インストールの間に Amazon Bedrock を選んで接続確認すると、次のメッセージが
返ります: *「Amazon Bedrock support is not installed. Run: npm install
@aws-sdk/client-bedrock-runtime @aws-sdk/client-bedrock」*。他のプロバイダー
（Ollama・Anthropic・OpenAI）や EgressView の他機能は SDK 無しで動作します。

## 前提条件

1. 上記の Bedrock SDK をインストール済みであること。
2. 対象リージョンで Amazon Bedrock を有効化した AWS アカウント。
3. 使用するモデルの **モデルアクセス許可**（Bedrock コンソール → *モデルアクセス*）。
   アクセスはリージョン単位・モデル単位です。
4. EgressView を動かすホストで、AWS SDK 標準 chain により解決できる認証情報。

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

## 接続確認

Bedrock の場合、**保存して接続確認**ボタンは次を行います。

1. fail-open のモデル discovery で候補を取得し、
2. Converse で最小の固定文字列生成を送り、`bedrock:InvokeModel` が実際に機能するか
   検証します（通信・端末・脅威データは送信しません）。

認証・権限・throttling・timeout・非対応モデル / リージョンの問題は短いエラーメッセージ
として表示されます。
