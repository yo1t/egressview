# EgressView コード品質レポート

- **評価日**: 2026-08-06
- **評価基準**: PR #182後 `30e7bce`（v1.8.0を署名付きで公開）
- **バージョン**: 1.8.0
- **Node.js**: >=22（CI: 22 / 24 / 26）
- **評価方法**: 自動テスト、V8 coverage、静的解析、依存・secret scan、browser smoke、parser fuzzing、手動コードレビュー

> 本レポートは現在のmainを評価します。SonarQubeとOpenSSFのスコアはリポジトリ内容からの推定で、公式scannerは実行していません。penetration testも対象外です。

---

## 総合評価

**総合グレード: A**

CriticalまたはHighの不具合は見つかりませんでした。前回レポート（PR #177基準）以降、5件のPR（#178--#182）がマージされ、**v1.8.0が本プロジェクト初の署名付きリリースとして公開されました** — portable distributionにKMS Ed25519署名がリリース資産として付き、これはOpenSSF Signed-Releasesが実際に検査している対象そのものです。併せて`better-sqlite3`を13.0.3（SQLite 3.53.4）へ移行して依存のinstall scriptを無効化し、Node 26.7.0でのルートテストharness退行を修正し、read-onlyの公開デモを追加しました。

**前回レポートの数値2件に誤りがあったため、本レポートで訂正します。** Coverageは92.59%（line）と記載されていましたが、これは`src/`のみを対象にした測定値である一方、隣に併記されたCI gate（83/79/80）は**ツリー全体**を測ります。つまり読者がgateと突き合わせる数字が、gateの見ている数字ではありませんでした。本レポートでは両スコープを分けて記載します。Permission matrixは107件（HTTP route 96）と記載されていましたが、実際は105件（HTTP route 94）で、現在も105件です。どちらも判定を変えるものではありませんが、**リポジトリから再現できない数値を載せた品質レポートは役目を果たしません。**

実測coverageはツリー全体でline 84.08%、branch 80.12%、function 80.80%、CI gateは83/79/80です。この差の小ささは意図的で、P2-69が「実態を良く見せるのではなく実態に追随させる」ためにgateを引き上げた結果です。`src/`に限れば同じ実行で93.26 / 88.78 / 89.38。Test対source比率は103.1%。セキュリティモデルは不変で、permission matrixは105件（HTTP route 94 + MCP tool 11）を維持しています。

| 評価軸 | 結果 | 判定 |
|---|---:|---|
| OWASP ASVS Level 1 | 14領域中14領域が適合または緩和済み | 完全適合 |
| OpenSSF Scorecard | 推定約9.4/10 | 署名付き資産の公開によりSigned-Releasesを充足 |
| ISO/IEC 25010 | 平均9.1/10 | 高品質 |
| Node.js Best Practices | 47/50 | 優秀 |
| SonarQube相当gate | 合格、coverageはA | High以上のblockerなし |

## レビュー結果

### 前回レポート（PR #177基準）以降の変更

| PR | タイトル | 分類 |
|---:|---|---|
| #178 | PR #177後の品質レポート更新 | ドキュメント |
| #179 | better-sqlite3を13.0.3へ更新しinstall scriptを無効化 | 依存関係 |
| #180 | Dependabot: minor-and-patchグループ更新（4件） | 依存関係 |
| #181 | v1.8.0リリース準備 | リリース |
| #182 | Fly.ioデモ環境をread-only保護付きで追加 | 機能 |

### 主な改善点

- **初の署名付きリリース（v1.8.0）**: 登録済みKMS鍵でビルド・署名し、4つの資産（archive、checksum、detached signature、公開鍵）を公開しました。検証は**ローカルのビルド成果物ではなく、ダウンロードし直した公開物**に対して再実行しています — checksum一致、`openssl pkeyutl -verify`成功、公開鍵のfingerprintがtrust registryと一致。さらに改ざん検出を3通り（archive改ざん、checksumファイル改ざん、別鍵での検証）試し、いずれも**終了コード非0**であることを確認しました。検証器はメッセージではなく終了コードで失敗を通知するため、メッセージだけを読む確認では改ざん物を通してしまいます。
- **信頼起点の記述を正確化（本サイクル）**: fingerprintは`SECURITY.md`、`trusted-fingerprints.json`、project website、DNS TXTレコードにあります。従来の記述はこれを「4つの独立チャネル」と呼んでいましたが、**うち3つはこのリポジトリから生成される**ため、アカウントを1つ奪われれば同時に書き換わります。文書は、信頼を担う比較対象がDNSレコード（`_egressview-release.egressview.com`、別の認証情報で配信）であることを明示し、取得する`dig`コマンドを併記する形へ改めました。**同一ソースの写しを2つ突き合わせるよう案内することは、何も案内しないより悪い**（検証したつもりになるため）という判断です。
- **better-sqlite3 13.0.3（PR #179）**: 1.7.0で置いたpinを解除しました。当初のブロッカーは上流で解決済み — arm64 prebuildの要求が`GLIBC_2.38`から`GLIBC_2.34`へ下がり、aarch64のデプロイ先が提供する範囲に収まりました。**移行中に別のブロッカーが判明**しています: 13.xは`binding.gyp`を同梱しながら`install` scriptを持たず、npmは素の`binding.gyp`を暗黙の`node-gyp rebuild`として扱うため、prebuiltがあるのに毎回ソースビルドが走り、PythonとC++ツールチェーンの無いホストでは失敗します。上流は`"gypfile": false`の追加でこれをcloseしていますが、このフィールドはnpm 8以降が無視するため未解決のままです。install scriptの無効化で解消し、副次的に全依存のinstall時コード実行を止めました。`min-release-age=7`も追加し、Dependabotの7日cooldownをinstall時の解決にも適用しています。
- **Node 26.7.0のテストharness修正（PR #181）**: 12個のルートテストは素の`Readable`をHTTPリクエストとしてExpressへ渡しています。Expressが`http.IncomingMessage.prototype`を継承させるため、Node 26.7.0で`_destroy`が「内部フィールドを持たないオブジェクト」からabort listenerを外そうとして落ち、1ファイルあたり約20件が巻き込まれました。CIの`node-version: 26`はその時点の最新を引くため、**こちら側の変更なしに発生**します。製品コードは本物の`http.Server`下で動くため影響を受けません。
- **read-onlyの公開デモ（PR #182・#184）**: `DEMO_READ_ONLY`という独立したフラグで書き込み保護を強制し、訪問者を固定の匿名`viewer`として認証するためログイン画面も公開すべき資格情報も存在しません。有効化には`DEMO_MODE`も必要です — デモモードこそが「これは本番ではない」ことの保証（`NODE_ENV=production`で起動拒否、DB分離、ルーター収集停止）だからです。**書き込み系ルート53本はすべて`/api`配下**にあり、ミドルウェアのマウント位置と一致します。公開扱いの書き込みルートは許可リストの2本のみで、Socket.IOは受信イベントハンドラを登録していないためWebSocket経由の迂回もありません。ミドルウェアはfail-closedで、許可リストに完全一致しないものはすべて拒否します。

### 残余リスク

- **低・運用**: hardware/external service依存のintegration test 4ファイルはdefault CI workflowに含まれません。
- **低・ecosystem**: OpenAPI契約とOCI imageはありません。
- **低・保守性**: `public/js/ai-insights.js`（872行）と`src/history.js`（789行）が非poller最大のmoduleとして残りますが、今サイクルで成長していません。
- **低・supply chain**: `npm audit`はbetter-sqlite3のamalgamation内のSQLite CVEを検出できません。盲点は手動検証手順と共に文書化済み。同梱SQLiteは3.53.4で、上流の最新リリースです。
- **低・install面**: install scriptを無効化したため、installは**ホスト向けの同梱prebuiltバイナリが存在すること**に依存します。better-sqlite3はdarwin / linux / linuxmusl / win32のarm64・x64をカバーし、範囲外はツールチェーンと`--ignore-scripts=false`が必要です。`CONTRIBUTING.md`と日英の配布ガイドに記載済み。
- **低・デモ公開面**: 公開デモは訪問者全員を匿名の`viewer`として認証するため、合成デモデータは誰でも読めます（デモの目的そのもの）。**資格情報は一切公開していません** — 匿名アクセスの有効化には`DEMO_MODE`と`DEMO_READ_ONLY`の両方が必要で、その組み合わせでは内部のadmin tokenを起動ごとにランダム化します。書き込みはviewer権限とread-onlyミドルウェアの二重で拒否されます。

---

## 実測結果

| 検査 | 結果 |
|---|---|
| Coverage付きunit test | 1,966件成功、失敗0（464 suite） |
| V8 coverage（ツリー全体） | line 84.08%、branch 80.12%、function 80.80% |
| V8 coverage（`src/`のみ） | line 93.26%、branch 88.78%、function 89.38% |
| CI coverage下限 | line 83%、branch 79%、function 80% — 合格 |
| Parser fuzz test | 30件成功（3 suite） |
| Playwright browser smoke | 70件成功、1件skip |
| ESLint | 合格 |
| Frontend HTML挿入監査 | `innerHTML` / `insertAdjacentHTML` 0件 |
| Production依存監査 | 脆弱性0件 |
| Secret scan | 高確度secret・環境固有LAN IPなし |
| ASH（Automated Security Helper） | actionable finding 0件 |
| GitHub Actions SHA pinning | 19/19 pinned、0 unpinned |
| 公開リリースの検証 | ダウンロードした公開物で検証: checksum一致、署名検証成功、fingerprintがregistryと一致。改ざん3ケースはいずれも終了コード非0 |

### コードベースメトリクス

| メトリクス | 値 |
|---|---:|
| Source行数（server、mcp、src、public/js） | 31,482（31,435） |
| Test行数（unit、integration、smoke、fuzz、portability） | 32,450（32,214） |
| Test対source比率 | 103.1%（103.1%） |
| Unit test file | 141（140） |
| Integration test file | 4 |
| Fuzz test file | 3 |
| Browser smoke | 1 file（1,740行） |
| Portability test file | 1 |
| `src/` module | 114（113） |
| Poller module | 15 |
| Route module | 18 |
| HTTP route（permission matrix） | 94 |
| MCP tool | 11 |
| Permission matrix entries | 105 |
| ルートのaccess内訳 | permission 85、authenticated 1、public 8 |
| 公開API endpoint | login、admin-verify、auth-status、auth-methods、oidc-start、oidc-callback |
| 公開運用endpoint | `/healthz`、`/readyz`。固定最小responseのみ |
| 書き込み系ルート | 53本、すべて`/api`配下 |
| 定義済みpermission | 7 |
| ロール | 3（viewer、operator、admin） |
| Production依存package | 13 |
| `docs/`配下のドキュメント | 37（36） |
| Parameterized SQL preparation | 152 |
| Server-side `var` | 0 |
| `eval` / `new Function` | 0 |
| TODO/FIXME/HACK | 0 |
| `innerHTML` / `insertAdjacentHTML` | 0 |
| CI Node.jsバージョン | 22、24、26 |
| リリース署名鍵 | 1（KMS Ed25519）。v1.8.0の署名に使用 |

括弧内は前回レポートの値です（変化があった項目のみ）。permission matrixの行は変化ではありません — 前回の107件は同じ105件の数え誤りです。

---

## 1. OWASP ASVS Level 1

**判定: 完全適合（14領域中14領域が適合または緩和済み）。**

| 領域 | 状況 | 根拠 |
|---|---|---|
| 認証 | 合格 | scrypt（versioned KDF migration）、timing-safe比較、256bit session token、失敗遅延、IP単位lockout、Google OIDC + PKCE |
| Session管理 | 合格 | token hash保存、sliding expiry、revoke、password変更処理、定期prune、ロール付きsession |
| Access control | 合格 | HTTP route 94件のうち85件がpermission gate、1件がauthenticated、公開は8件（うち2件は`/healthz`・`/readyz`）。deny-by-default権限境界。WebSocket handshakeも同じ境界。permission matrix 105件 |
| 入力検証 | 合格 | JSON 64KB、17/18 endpoint moduleのstrict Zod、未知key拒否、文字列・範囲上限、outbound endpoint向けSSRF guard |
| 暗号 | 合格 | secret/correlationの`randomBytes`/UUID、session/TOFU/principalHashのSHA-256、timing-safe equality、MCPのRS256 JWT検証、リリース署名のKMS Ed25519 |
| Error処理 | 合格 | 汎用500、stack非公開、request ID付きserver log |
| Data保護 | 合格 | config/backup/TLS keyは0600、公開config/logからsecret除外、API identity hash-only storage |
| 通信 | 合格 | HTTPS/HSTS対応。OIDC callbackはsecure redirectを強制。MCP OAuthはHTTPS JWKS経由 |
| 悪意コード | 合格 | evalなし、frontend HTML挿入監査をCIで強制 |
| File処理 | 合格 | upload上限、backup名検証、traversal防止、restore/migration fail-closed |
| API security | 合格 | method別route、strict schema、response size/time上限、認証付きexport、MCP rate limiting |
| Configuration | 合格 | hard-coded credentialなし、example設定、secret scan、production demo拒否 |
| Business logic | 合格 | HttpOnly cookie + CSRF保護、API identity用explicit permission token、deny-by-default enforcement |
| 監査・ログ | 合格 | append-only audit_events（pseudonymous actorHash/principalHash）、24時間scheduleで180日retention適用、MCP専用audit store（keyed client address付き） |

---

## 2. OpenSSF Scorecard（推定）

**推定スコア: 9.4/10。**

| Check | Score | 根拠 |
|---|---:|---|
| Pinned dependencies | 10 | 全19 GitHub Actionをfull commit SHAへ固定 |
| Token permissions | 10 | 既定read-only。Pagesだけ必要権限を追加 |
| Dangerous workflow | 10 | `pull_request_target`なし |
| Binary artifacts | 10 | commit済みbinaryなし |
| Security policy | 10 | `SECURITY.md`とprivate vulnerability reporting |
| License | 10 | AGPL-3.0-only |
| SAST | 10 | ASH、secret scan、ESLint、frontend挿入監査、npm audit |
| Vulnerabilities | 10 | production `npm audit`をCI実行。本レビュー0件 |
| Dependency updates | 10 | npm/Actionsのweekly Dependabot、7日cooldown |
| CI tests | 10 | PRでunit/coverage、parser fuzz、browser smoke。Node 22/24/26 matrix |
| Maintained | 10 | PR #182まで継続的にrelease・改善（マージ済みPR 177件） |
| Code review | 8 | PRと必須checkを運用。RBACとpermission matrixがreview基準を強化 |
| Fuzzing | 5 | 信頼できないデバイス入力を読む19 parse関数をparser fuzzingで検証。time-budgetとshape assertion付き。依存なし、CI実行。ただしOSS-Fuzz等の継続fuzzing serviceには未登録 |
| Signed releases | 8 | **v1.8.0をdetached signature資産付きで公開済み。** このcheckが見るのはリリース資産の拡張子（`.sig` / `.asc` / `.minisig` / `.sigstore` / `.intoto.jsonl`）であり、gitタグ署名ではない。KMS Ed25519鍵はmulti-channelフィンガープリント公開とtrust registryテスト付きで登録済み。残り2点はSLSA provenance |

---

## 3. ISO/IEC 25010

| 品質特性 | Score | 強み | 残るgap |
|---|---:|---|---|
| 機能適合性 | 9 | 複数router、AI洞察（notification付き）、脅威調査、export、MCP + OAuth、検知種別ごとの通知粒度 | OpenAPIなし |
| 性能効率性 | 9 | WAL、batch、bounded summary、cache、worker分離backup、MCP concurrency cap | 重いbackup検証中はhost-levelの短い遅延が残り得る |
| 互換性 | 9 | Node 22/24/26、JA/EN、Yamaha/Cisco/ASUS/conntrack、Cognito compatibility profile、proxy配下の`/`とsubpath双方での正常動作 | CIのhardware確認はfixture中心 |
| 使用性 | 9 | Responsive UI、setup guide、自動検出、health診断、ロール表示、検知別通知スイッチ | One-click deployなし |
| 信頼性 | 9 | migration/restore/config/notes fail-closed、health、cancel、request ID、ASUS再接続、rate limiting、scheduled audit retention | 組み込みservice supervisorなし |
| Security | 10 | OIDC/PKCE、RBAC、deny-by-default permission、CSRF、HttpOnly cookie、API identity hash-only storage、MCP OAuth/JWKS、audit trail、rate limit、SSRF guard、KMSリリース署名（登録済みtrust registry） | -- |
| 保守性 | 9 | 114 module、強いtest（test対source比率103.1%）、route/poller/query分離、permission matrix、MCP責務分割済み、parser fuzz、native-dep盲点文書化 | `public/js/ai-insights.js`（872行）と`src/history.js`（789行）が大きいまま |
| 移植性 | 9 | Cloud非依存profile、KMS署名付きportable source、起動前feature policyを持つoffline mode、offline portability gate、version管理rollback、Node 22/24/26 CI | 正式OCI image/systemd unitなし |

**平均: 9.1/10。**

---

## 4. Node.js Best Practices

**準拠率: 47/50（94%）。**

- Domain、route、poller adapter、DB bootstrap、auth middleware、browser renderingの責務を分離しています。
- 外部async処理にtimeout/AbortSignal上限があり、backup pruneはworkerとsingle-flight jobで隔離され、ASUSポーリングはoverlapping cycleをcoalesceし、MCP requestはconcurrency capを適用しています。
- Loggerは`AsyncLocalStorage`で安全な`X-Request-Id`を付け、query stringは記録しません。
- Graceful shutdown、readiness、schema migration、config rollback、永続化失敗、permission enforcementをtestしています。
- ESLint、V8 coverage、Node 22/24/26、Playwright、parser fuzz、ASH、secret scan、dependency auditをPR gateにしています。
- 認証ロジックは専用moduleに分離し、single-responsibilityを遵守しています。
- 信頼できないデバイスからのparser入力をfuzzし、shape・time-budget assertionで検証しています。
- SSRF保護はoperator設定のoutbound endpointを名前解決し、link-local、metadata、multicast、broadcastの候補をすべて拒否したうえで、検査済みIPへ接続を固定してDNS rebindingを防ぎます。
- リリース整合性はKMS管理鍵と登録済みtrust registryで保証し、fingerprintは**リポジトリ外**（別の認証情報で配信されるDNS TXTレコード）にアンカーされています。
- Native依存のaudit盲点を手動検証手順と共に文書化しています。

Default hardware integration CI、正式process manager/OCI成果物、OpenAPIがないため満点とはしません。

---

## 5. SonarQube相当Quality Gate

| Metric | 結果 | Rating |
|---|---:|---|
| Reliability | Critical/Highの既知不具合なし | A |
| Security | 高確度secret・dependency findingなし。完全なRBAC、監査、SSRF保護、KMSリリース署名 | A |
| Maintainability | 新規hotspotなし。残る大きなmoduleはtestで境界化 | A |
| Coverage | ツリー全体 line 84.08% / branch 80.12% / function 80.80%、`src/`のみ 93.26 / 88.78 / 89.38 | A |
| Duplication | 手動・静的reviewで重大な新規重複なし | A（推定） |

**Quality gate: 合格。**

### 主な保守性hotspot

| File | 行数 | 評価 |
|---|---:|---|
| `public/js/ai-insights.js` | 872 | notification/insight renderingが同居 |
| `src/history.js` | 789 | query/cache/bootstrap抽出後もstore orchestrationが大きい |
| `server.js` | 730 | bootstrapとdependency wiring |
| `public/js/log.js` | 715 | pagination、filter、renderが同居 |
| `public/js/graph.js` | 675 | 抽出済みhelper/panel/rendererのorchestration |
| `src/devices.js` | 665 | device identity、persistence、merge lifecycle |
| `src/pollers/cisco.js` | 645 | parser/handshake抽出後のstateful SSH lifecycle |
| `src/mcp-publication-gate.js` | 639 | 公開判断、client release timing、diagnostics |
| `src/pollers/yamaha.js` | 614 | adapter parser周辺のstateful SSH lifecycle |
| `public/js/devices.js` | 593 | device UI orchestration |
| `mcp-server.js` | 570 | transport bootstrapとOAuth wiring |
| `src/device-identify.js` | 559 | device fingerprintingヒューリスティクス |
| `src/ai-provider.js` | 559 | multi-provider AI client（SSRF guard付き） |
| `src/db-migrate.js` | 557 | schema migration v1-v12 |

今サイクルでhotspotの成長はありません。

---

## 結論

現在のmainは、文書化されたself-hostedデプロイモデルに対して十分な多人数運用向けセキュリティ制御を備えています。自動品質ゲートは広く、データ変更操作はfail-closed、AI provider呼び出しは時間とcontextで制限され、deny-by-defaultのRBACが全面適用され、MCPはOAuth保護・rate limit・監査付きで、Critical/Highの問題は残っていません。

今サイクルでリリース署名のストーリーが、**意味のある形で**完了しました。v1.8.0を署名して公開し、**ローカルのビルド成果物ではなくダウンロードした公開物**に対して検証しています。失敗経路も実際に確認しました — archive改ざん、checksumファイル改ざん、別鍵での検証がいずれも終了コード非0になります。検証器はメッセージではなく終了コードで失敗を通知するため、ここが確認すべき性質です。

supply chain面の改善2件は、控えめに書くと実態を見誤ります。install scriptの無効化は、きっかけとなった1つのパッケージだけでなく**全依存のinstall時コード実行**を止めます。`min-release-age=7`は既存のDependabot cooldownをinstall時の解決にも広げます。どちらも「ネイティブモジュールのメジャー更新がそのままではデプロイできなかった」ことから採用されたものです。**依存のメジャー更新で問うべきはCIが緑かではなく、その成果物がホストで動くか、ツールチェーン無しでinstallできるか**である、という教訓を示しています。

Node 26.7.0の破損は、欠陥ではなくプロセス上の観測として記録する価値があります。リポジトリ側は何も変えていません。CIの`node-version: 26`はその時点の最新を引き、パッチリリースが内部のHTTP teardownを変えた結果、偽のリクエストオブジェクトが耐えられなくなりました。**ローカルの26.5.0では通るため、再現にはCIが引く版と同じパッチバージョンのコンテナが必要**でした。

CoverageはA評価を維持し、gateと突き合わせるべきツリー全体の数値を併記する形に是正しました。新たな保守性hotspotは発生していません。残る改善余地はSLSA provenance（Signed-Releasesの残り2点）、OSS-Fuzzによる継続fuzzing、OpenAPI契約、OCI配布で、いずれもリリースのblockerではなく需要駆動の拡張です。
