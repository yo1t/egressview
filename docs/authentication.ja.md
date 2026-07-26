# 認証とreverse proxy

> [English](authentication.md)

EgressViewは緊急用ローカル管理者を常に維持します。Google OIDCは任意の追加ログイン方式で、ローカル復旧経路を無効化できません。

## ローカル管理者

- 新規パスワードは14文字以上で、version付きscrypt recordとして保存します。
- Browser tokenはSQLite上でhash化し、HttpOnly/SameSite cookieで渡します。cookie認証による更新requestではCSRF cookieと同じ値を`X-CSRF-Token`へ指定します。
- パスワード紛失時は、SSH/consoleの対話TTYで`npm run auth:reset`を実行します。全browser sessionを失効します。automation tokenも変える場合は`-- --regenerate-api-token`を追加します。
- 初期・復旧secretは`server.log`へ書きません。非対話の初回起動では`.egressview.json`隣接のmode `0600` one-time fileへ保存します。

## Google OIDC

Google OAuth 2.0のWeb applicationを作成し、承認済みredirect URIを次に設定します。

```text
https://YOUR_EGRESSVIEW_ORIGIN/api/auth/oidc/callback
```

設定 → 一般 → 認証と監査でclient ID、client secret、許可emailまたはdomainを1件以上設定します。EgressViewはAuthorization Code + PKCE、state、nonce、Google JWKS署名、issuer、audience、有効期限、verified email、allowlistを検証してから、通常の失効可能なsessionを作成します。

### ブラウザのロール

検証済みのログイン経路から、サーバー側でロールを割り当てます。

| ログイン | ロール | 権限 |
|---|---|---|
| ローカル管理者 | `admin` | 設定、認証情報、認証、バックアップ、運用機能のすべて |
| 許可メールに明示したGoogleアカウント | `operator` | ネットワーク情報と端末メモの更新 |
| 許可ドメインだけに一致したGoogleアカウント | `viewer` | ネットワーク情報の閲覧のみ |

認証のallowlistは管理者権限の指定ではありません。emailまたはdomain
allowlistに含まれるだけでGoogle利用者が管理者になることはありません。
また、生成AIへのデータ送信と課金が発生し得るため、operatorにはAI分析を
許可しません。

ブラウザロール未対応版からの更新時は、既存のローカルsessionだけを管理者
として維持します。既存OIDC sessionは一度失効し、再ログイン時に検証済みの
allowlist一致からロールを割り当て直します。

## Reverse proxy境界

公開URLを指定し、自分で管理するproxy addressだけを信頼します。

```dotenv
EGRESSVIEW_PUBLIC_URL=https://egressview.example.com
EGRESSVIEW_TRUST_PROXY=10.41.0.10
EGRESSVIEW_SECURE_COOKIES=true
```

`EGRESSVIEW_TRUST_PROXY`はカンマ区切りのexact IPまたはIPv4 CIDRです。全proxyを信用する設定は禁止です。forwarded client/protocol headerはrate limit、監査用pseudonym、Secure cookie判定に影響します。

既定値はclientごとに1分間600 API read、120 API mutationです。通常trafficを観測した上で、必要な場合だけ`EGRESSVIEW_RATE_LIMIT_READS`と`EGRESSVIEW_RATE_LIMIT_WRITES`を変更してください。

## 監査

設定画面でlogin、logout、security変更、CSRF拒否、更新APIの最近のeventを確認できます。Append-only rowは生のemail/client IPではなく、request IDとkeyed hashを保存します。既定保持期間は180日です。
