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

### 許可された利用者は全員が管理者になります

> **警告**
> EgressViewは本人確認を行いますが、権限の分離はまだ実装していません。allowlistを通過したアカウントは全員が管理者としてログインし、収集した全通信の閲覧、ルーター認証情報の変更、シークレットの再生成、バックアップの復元、他sessionの失効まで実行できます。

そのため**domain** allowlistは、そのdomainに所属する全員（設定後に作成されたアカウントを含む）へ管理者権限を与えることになります。role-based access controlが実装されるまでは、各利用者を個別に列挙する**email** allowlistでの運用を推奨します。

EgressViewは既存設定を自動で無効化しません。無告知でremote利用者を締め出すほうが危険なためです。代わりにdomain allowlistが有効な間、起動時のサーバーログと設定画面の該当項目の横で警告します。

**domain allowlistからemail allowlistへの移行手順**

1. 緊急用ローカル管理者でログインします。次の手順で自分のGoogleアカウントが対象外になっても、アクセスを失わないためです。このアカウントは常に利用でき、OIDC設定の影響を受けません。
2. 設定 → 一般 → 認証と監査で、アクセスが必要な全員を**許可メール**へ追加します。
3. **許可ドメイン**欄を空にして保存します。Google OIDCが有効な間は、emailかdomainのどちらかが1件以上必要です。
4. session一覧から既存sessionを失効させ、allowlistに該当しなくなった利用者をログアウトさせます。allowlistから削除しても、既に開いているsessionは終了しません。
5. 次回再起動時に、サーバーログから警告が消えていることを確認します。

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
