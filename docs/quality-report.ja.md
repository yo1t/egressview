# EgressView コード品質レポート

- **評価日**: 2026-08-12
- **評価基準**: `30e7bce`（前回レポート）。本サイクルは `e5835a4` までを評価
- **バージョン**: 1.9.0
- **Node.js**: >=22（CI: 22 / 24 / 26）
- **評価方法**: 自動テスト、V8 coverage、静的解析、依存・secret scan、browser smoke、parser fuzzing、手動コードレビュー

> 本レポートは現在のmainを評価します。SonarQubeとOpenSSFのスコアはリポジトリ内容からの推定で、公式scannerは実行していません。penetration testも対象外です。

---

## 総合評価

**総合グレード: A**

CriticalまたはHighの不具合は見つかりませんでした。今回は大きなサイクルで、27件のPR（#186--#212）がマージされ、**v1.9.0が署名付きで公開されました**。目玉は新しい収集経路 — **macOS Hub-Agent** です。エンドポイント上でプロセス単位の外向き接続を観測し、認証付きの取り込み（ingest）APIでHubへ送信し、Hub側で冪等に保存・ルーター観測との相関付け・同じ脅威フィードとの照合を行います。周辺では、**共有の収集ソース選択**が全ビューを特定のルーター/エージェントにスコープするようになり、サーバ全体をフリーズさせ得た**通知ログのフリーズ**を根本原因（インデックス）で修正したうえでevent-loop watchdogで二重化し、macOSエージェントが**インストール可能な署名済み成果物**になりました。

このingest表面は最もセキュリティに関わる変更ですが、システムの他部分と同じ流儀で作られています — permission matrix上の独立した`agent`アクセス種別として扱い、専用の`agent.ingest`権限でgateします。各エージェントはbearer secretで認証し、その値はpepper付きHMAC-SHA256の**ハッシュのみ**で保存されるため、DBのコピーからは使える資格情報を得られません。enrollmentはセルフサービスの識別子ではなく**管理者承認を要する「申請」**を生成し、短い可読コードには試行回数制限を設けています。観測は二重に検証され — 入口でZod、SQLite側でCHECK制約 — さらに`(agentId, observationId)`で重複排除されるため、バッチを再送しても状態は変わりません。

**前回レポートからの実質的な変更が1点あります: coverageを単一スコープで報告します。** 前回はCI gateとの不一致を訂正する目的で、ツリー全体の数値と、より高い`src/`のみの数値を併記していました。しかし`src/`のみの数値は`npm run test:coverage`が出力する値でもgateが検査する値でもないため、是正したはずの問題を再導入していました。本レポートではコマンドが出力しgateが強制する唯一の数値を示します: **line 84.95%、branch 80.07%、function 81.70%**（計測対象は計装されたサーバサイドツリー）、CI gateは83/79/80です。この差の小ささは意図的で、実態を良く見せるのではなく実態に追随させるためのものです。Test対source比率は100.3%。permission matrixはエージェント表面の追加で119件（HTTP route 108 + MCP tool 11）へ増えました。

| 評価軸 | 結果 | 判定 |
|---|---:|---|
| OWASP ASVS Level 1 | 14領域中14領域が適合または緩和済み | 完全適合 |
| OpenSSF Scorecard | 推定約9.4/10 | 署名付き資産の公開によりSigned-Releasesを充足 |
| ISO/IEC 25010 | 平均9.1/10 | 高品質 |
| Node.js Best Practices | 47/50 | 優秀 |
| SonarQube相当gate | 合格、coverageはA | High以上のblockerなし |

## レビュー結果

### 前回レポート（`30e7bce`基準）以降の変更

27件のPR（#186--#212）がマージされました。平坦な一覧ではなく、いくつかのテーマに整理できます:

| テーマ | 内容 | PR |
|---|---|---|
| macOS Hub-Agent | 収集spike、host + system extension、接続履歴UI、secure enrollment identity、冪等ingest storage、opt-in Hub sender、live配信のhardening、エージェント/ルーター相関、エージェント報告フローの脅威照合、アドレス単位のcapacity、capability negotiation | #187--#197, #204, #207, #210--#212 |
| 承認によるenrollment | 短い可読コードが、長いtokenの書き写しではなく管理者承認付きの申請を生成 | #201 |
| 収集ソースscope | 全ビューへ適用する共有ソース選択、AI会話のソースscope保持、SSH promptからのルーター名検出 | #198 |
| 信頼性 | 通知ログのagent-scopeフリーズをcomposite indexで修正し、event-loop watchdogで二重化 | #202 |
| macOSエージェント配布 | インストール可能な署名済みDMG化、履歴コントロール、launch-at-login、メニューバーアイコン | #199, #200, #203, #205 |
| リリース・依存 | v1.9.0を署名付き資産で公開、Dependabot minor-and-patch、demo/outbound安全性のhardening | #186, #191, #209 |
| ドキュメント | README再構成、エージェントを含むアーキテクチャ文書、dotenvの抑制、エージェント単独導入の範囲を訂正 | #206, #208 |

### 主な改善点

- **新しい収集経路を、システムの他部分と同じように守る。** macOSエージェントは新しい`agent`アクセス種別の3ルート（ingest、token rotation、capability discovery）を追加します。いずれもsessionやAPI identityからは到達できません。エージェントは`egva_`接頭辞の256bit bearer secretで認証し、その値はpepper付きHMAC-SHA256の**ハッシュのみ**で保存されるため、DBのコピーからは使える資格情報を得られません。ingestは冪等で、バッチと観測はクライアント生成のIDを持ち、再送されたバッチは重複として数えられ再挿入されません。全フィールドはルートでZod、SQLiteのCHECK制約で再度検証され、64bitのバイトカウンタも十進文字列として範囲検査されるため、入口検証をすり抜けて範囲外の値を紛れ込ませることはできません。
- **書き写しではなく、承認によるenrollment。** enrollmentコードは長い書き写しtokenから可読6文字へ縮小され、それ単体では10分の有効窓内で推測可能です。**これは意図的に最後の防衛線ではありません** — 正しいコードは「保留中の申請」を生成し、それを起票していない管理者が承認して初めてエージェントになり、その間は試行カウンタが窓を閉じます。オンボーディングにもdeny-by-defaultを適用した形です。
- **通知ログのフリーズを根本原因で修正し、柵で囲う。** agent-scopeの通知ログクエリは`(agentId, localAddress, ...)`で絞った`agent_observations`に対し相関`EXISTS`を実行していました。先頭にそれらの列を持つcomposite indexが無いと、プランナはagentIdのみのindexへ退避し、通知行ごとにそのエージェントの全観測を再走査します — 同期的かつ非有界のスキャンで、event loopをブロックし`/healthz`が応答を止め、proxyが504を返すまで固まります。`(agentId, localAddress, remoteAddress, remotePort)`のindexにより、この参照はseekになります。`better-sqlite3`は同期的なので単一の病的クエリがプロセス全体のリスクになります。そこで**event-loop watchdog**を追加しました: worker threadがメインスレッドの毎tickの心拍を監視し、しきい値（既定120秒、`EGRESSVIEW_WATCHDOG_STALL_MS`）を超えて停滞したらプロセスを強制終了（ブロック不能なSIGKILL）します。service managerが数秒で再起動します。watchdogは完全にunref済みで、タイマー1本と軽量スレッド1本を足すだけです。
- **収集ソースscopeを製品全体へ。** 共有selectorにより、運用者は全ビュー（devices、connections、history、AI会話）を1つのルーターまたは1つのエージェントにスコープできます。scopeはペア（kindとidは同時に来る）として検証され、有効なルーターと失効していないエージェントの実集合と突き合わされるため、古い・偽装されたsource idはクエリを黙って広げるのではなく400で拒否されます。AIメッセージはソースscopeをappend-onlyの別表に保持し、メッセージ本文を不変に保ちつつ会話の対象を記憶します。
- **引き継がれた署名パイプライン。** v1.8.0は本プロジェクト初の署名付きリリースで、**ダウンロードし直した公開物**で検証されました — checksum、`openssl pkeyutl -verify`、trust registryとのfingerprint一致、そして改ざん3ケースがいずれも終了コード非0。このパイプラインはv1.9.0へ引き継がれ、同じ4資産（archive、checksum、detached signature、公開鍵）とインストール可能なmacOSエージェントと共に公開されています。信頼起点は依然としてDNS TXTレコード`_egressview-release.egressview.com`（リポジトリとは別の認証情報で配信）で、これこそ信頼を担う比較対象です — `SECURITY.md`・`trusted-fingerprints.json`・websiteの写しはアカウントを1つ奪われれば同時に書き換わります。

### 残余リスク

- **低・新規攻撃面**: エージェントのingest APIは新しい認証付き書き込み経路です。permission gate、二重検証、冪等、global limiterによるrate制限を備えますが、エージェントがHubへ到達するネットワークに露出するため、APIの他部分と同じ transport 保護の内側に置くべきです。
- **低・運用**: hardware/external service依存のintegration test 4ファイルはdefault CI workflowに含まれません。
- **低・信頼性の監督**: event-loop watchdogは固まったプロセスを強制終了しますが、復帰は外部のservice manager（`Restart=on-failure`）に依存します。リポジトリ内に正式なservice unitはまだありません。
- **低・ecosystem**: OpenAPI契約はなく、正式な本番向けOCI imageもありません（唯一追跡されるDockerfileはread-onlyデモ用）。
- **低・保守性**: エージェント作業でいくつかのmoduleが成長しました（hotspot参照）。`public/js/ai-insights.js`（892行）と`src/history.js`（847行）が最大で、`src/db-migrate.js`はmigration v1--v16を抱えて755行になりました。
- **低・supply chain**: `npm audit`はbetter-sqlite3のamalgamation内のSQLite CVEを検出できません。盲点は手動検証手順と共に文書化済み。同梱SQLiteは上流の最新リリースに追随します。install scriptは無効のままで、installはホスト向けの同梱prebuiltバイナリの存在に依存します。
- **低・デモ公開面**: 公開デモは訪問者全員を匿名の`viewer`として認証します（デモの目的そのもの）。資格情報は一切公開していません — 匿名アクセスには`DEMO_MODE`と`DEMO_READ_ONLY`の両方が必要で、その組み合わせでは内部のadmin tokenを起動ごとにランダム化し、書き込みはviewer権限とread-onlyミドルウェアの二重で拒否されます。

---

## 実測結果

| 検査 | 結果 |
|---|---|
| Coverage付きunit test | 2,088件成功、失敗0（485 suite） |
| V8 coverage（`npm run test:coverage`、計装されたサーバサイドツリー） | line 84.95%、branch 80.07%、function 81.70% |
| CI coverage下限 | line 83%、branch 79%、function 80% — 合格 |
| Parser fuzz test | 30件成功（3 suite） |
| Playwright browser smoke | CI gate合格（単一spec、1,901行） |
| ESLint | 合格 |
| Frontend HTML挿入監査 | `innerHTML` / `insertAdjacentHTML` 0件 |
| Production依存監査 | 脆弱性0件 |
| Secret scan | 高確度secret・環境固有LAN IPなし |
| ASH（Automated Security Helper） | actionable finding 0件（suppressed 36、tool 3.5.7） |
| GitHub Actions SHA pinning | 20/20 pinned、0 unpinned |
| 公開リリースの検証 | v1.9.0はdetached signature資産付きで公開。ダウンロード検証手順（改ざん3ケース含む）はv1.8.0資産で実施済み |

### コードベースメトリクス

| メトリクス | 値 |
|---|---:|
| Source行数（server、mcp、src、public/js） | 34,890（31,482） |
| Test行数（unit、integration、smoke、fuzz、portability） | 35,011（32,450） |
| Test対source比率 | 100.3%（103.1%） |
| Unit test file | 151（141） |
| Integration test file | 4 |
| Fuzz test file | 2（3）、3 suite |
| Browser smoke | 1 file（1,901行） |
| Portability test file | 1 |
| `src/` module | 124（114） |
| Poller module | 16（15） |
| Route module | 19（18） |
| HTTP route（permission matrix） | 108（94） |
| MCP tool | 11 |
| Permission matrix entries | 119（105） |
| ルートのaccess内訳 | permission 94、authenticated 1、agent 3、public 10 |
| Agent認証ルート | ingest、token rotation、capability discovery |
| 書き込み系ルート | `/api`配下（demo read-onlyミドルウェアのマウント位置） |
| 定義済みpermission | 8（7） |
| ロール | 3（viewer、operator、admin） |
| Production依存package | 13 |
| `docs/`配下のドキュメント | 47（37） |
| DB schemaバージョン | 16（12） |
| Parameterized SQL preparation | 196（152） |
| Server-side `var` | 0 |
| `eval` / `new Function` | 0 |
| TODO/FIXME/HACK | 0 |
| `innerHTML` / `insertAdjacentHTML` | 0 |
| CI Node.jsバージョン | 22、24、26 |
| リリース署名鍵 | 1（KMS Ed25519）。v1.8.0・v1.9.0を署名・公開 |

括弧内は前回レポートの値です（変化があった項目のみ）。

---

## 1. OWASP ASVS Level 1

**判定: 完全適合（14領域中14領域が適合または緩和済み）。**

| 領域 | 状況 | 根拠 |
|---|---|---|
| 認証 | 合格 | scrypt（versioned KDF migration）、timing-safe比較、256bit session token、失敗遅延、IP単位lockout、Google OIDC + PKCE。エージェントのbearer secretはpepper付きHMAC-SHA256でハッシュ化 |
| Session管理 | 合格 | token hash保存、sliding expiry、revoke、password変更処理、定期prune、ロール付きsession |
| Access control | 合格 | HTTP route 108件のうち94件がpermission gate、1件がauthenticated、3件がagent認証、公開は10件（`/healthz`・`/readyz`含む）。deny-by-default権限境界。WebSocket handshakeも同じ境界。permission matrix 119件。エージェントenrollmentは管理者承認が必要 |
| 入力検証 | 合格 | JSON 64KB、endpoint moduleのstrict Zod、未知key拒否、文字列・範囲上限、outbound endpoint向けSSRF guard。エージェント観測はZodとSQLite CHECK制約で二重検証（64bitバイトカウンタの十進文字列範囲検査を含む） |
| 暗号 | 合格 | secret/correlationの`randomBytes`/UUID、session/TOFU/principalHashのSHA-256、エージェント資格情報のHMAC-SHA256、timing-safe equality、MCPのRS256 JWT検証、リリース署名のKMS Ed25519 |
| Error処理 | 合格 | 汎用500、stack非公開、request ID付きserver log |
| Data保護 | 合格 | config/backup/TLS keyは0600、公開config/logからsecret除外、API identityとエージェント資格情報はhash-only保存 |
| 通信 | 合格 | HTTPS/HSTS対応。OIDC callbackはsecure redirectを強制。MCP OAuthはHTTPS JWKS経由 |
| 悪意コード | 合格 | evalなし、frontend HTML挿入監査をCIで強制 |
| File処理 | 合格 | upload上限、backup名検証、traversal防止、restore/migration fail-closed |
| API security | 合格 | method別route、strict schema、response size/time上限、認証付きexport、MCP rate limiting、冪等なエージェントingest |
| Configuration | 合格 | hard-coded credentialなし、example設定、secret scan、production demo拒否 |
| Business logic | 合格 | HttpOnly cookie + CSRF保護、API identity用explicit permission token、試行制限付きの管理者承認enrollment、deny-by-default enforcement |
| 監査・ログ | 合格 | append-only audit_events（pseudonymous actorHash/principalHash）、24時間scheduleで180日retention適用、MCP専用audit store（keyed client address付き） |

---

## 2. OpenSSF Scorecard（推定）

**推定スコア: 9.4/10。**

| Check | Score | 根拠 |
|---|---:|---|
| Pinned dependencies | 10 | 全20 GitHub Actionをfull commit SHAへ固定 |
| Token permissions | 10 | 既定read-only。Pagesだけ必要権限を追加 |
| Dangerous workflow | 10 | `pull_request_target`なし |
| Binary artifacts | 10 | commit済みbinaryなし |
| Security policy | 10 | `SECURITY.md`とprivate vulnerability reporting |
| License | 10 | AGPL-3.0-only |
| SAST | 10 | ASH、secret scan、ESLint、frontend挿入監査、npm audit |
| Vulnerabilities | 10 | production `npm audit`をCI実行。本レビュー0件 |
| Dependency updates | 10 | npm/Actionsのweekly Dependabot、7日cooldown |
| CI tests | 10 | PRでunit/coverage、parser fuzz、browser smoke。Node 22/24/26 matrix。macOSエージェント専用workflowも有り |
| Maintained | 10 | PR #212まで継続的にrelease・改善 |
| Code review | 8 | PRと必須checkを運用。RBACとpermission matrixがreview基準を強化 |
| Fuzzing | 5 | 信頼できないデバイス入力を読む関数をparser fuzzingで検証。time-budgetとshape assertion付き。依存なし、CI実行。ただしOSS-Fuzz等の継続fuzzing serviceには未登録 |
| Signed releases | 8 | **v1.8.0・v1.9.0をdetached signature資産付きで公開済み。** このcheckが見るのはリリース資産の拡張子（`.sig` / `.asc` / `.minisig` / `.sigstore` / `.intoto.jsonl`）であり、gitタグ署名ではない。KMS Ed25519鍵はmulti-channelフィンガープリント公開とtrust registryテスト付きで登録済み。残り2点はSLSA provenance |

---

## 3. ISO/IEC 25010

| 品質特性 | Score | 強み | 残るgap |
|---|---:|---|---|
| 機能適合性 | 9 | 複数router収集、プロセス単位で帰属できるmacOSエンドポイントエージェント、エージェント/ルーター相関、AI洞察（notification付き）、脅威調査、export、MCP + OAuth | OpenAPIなし |
| 性能効率性 | 9 | WAL、batch、bounded summary、cache、worker分離backup、MCP concurrency cap、indexされたagent-scope参照 | 重いbackup検証中はhost-levelの短い遅延が残り得る |
| 互換性 | 9 | Node 22/24/26、JA/EN、Yamaha/Cisco/ASUS/conntrackとmacOSエージェント、Cognito compatibility profile、proxy配下の`/`とsubpath双方での正常動作 | CIのhardware確認はfixture中心 |
| 使用性 | 9 | Responsive UI、setup guide、自動検出、health診断、ロール表示、検知別通知スイッチ、共有の収集ソース選択、インストール可能なmacOSエージェント、read-only公開デモ | router側設定（SSHユーザ、syslog転送）が依然として実際のオンボーディングコスト |
| 信頼性 | 9 | migration/restore/config/notes fail-closed、health、cancel、request ID、ASUS再接続、rate limiting、scheduled audit retention、同期停滞に対するevent-loop watchdog | watchdogの復帰は外部service managerに依存 |
| Security | 10 | OIDC/PKCE、RBAC、独立したagent種別を含むdeny-by-default permission、CSRF、HttpOnly cookie、hash-onlyのAPI identity・エージェント資格情報、管理者承認enrollment、MCP OAuth/JWKS、audit trail、rate limit、SSRF guard、署名され独立検証されたリリース、install script無効化 | -- |
| 保守性 | 9 | 124 module、強いtest（test対source比率100.3%）、route/poller/query分離、permission matrix、MCP責務分割済み、parser fuzz、native-dep盲点文書化 | エージェント作業で複数moduleが成長。`public/js/ai-insights.js`と`src/history.js`が大きいまま |
| 移植性 | 9 | Cloud非依存profile、KMS署名付きportable source、起動前feature policyを持つoffline mode、offline portability gate、version管理rollback、Node 22/24/26 CI | 正式な本番OCI image/systemd unitなし |

**平均: 9.1/10。**

---

## 4. Node.js Best Practices

**準拠率: 47/50（94%）。**

- Domain、route、poller adapter、エージェントのingest/相関module、DB bootstrap、auth middleware、browser renderingの責務を分離しています。
- 外部async処理にtimeout/AbortSignal上限があり、backup pruneはworkerとsingle-flight jobで隔離され、ASUSポーリングはoverlapping cycleをcoalesceし、MCP requestはconcurrency capを適用しています。
- 同期的なDB呼び出しはプロセス全体をブロックし得るため、worker thread上のevent-loop watchdogが固まったプロセスを強制再起動し、そのきっかけとなった病的クエリはindexレベルで修正しました。
- Loggerは`AsyncLocalStorage`で安全な`X-Request-Id`を付け、query stringは記録しません。
- Graceful shutdown、readiness、schema migration、config rollback、永続化失敗、permission enforcementをtestしています。
- ESLint、V8 coverage、Node 22/24/26、Playwright、parser fuzz、ASH、secret scan、dependency auditをPR gateにし、macOSエージェントは専用workflowを持ちます。
- 認証ロジックとエージェントidentityロジックは専用moduleに分離し、single-responsibilityを遵守しています。
- 信頼できない入力を多層で検証します: エージェント観測は入口でZod、保存時にSQLite CHECK制約を通り、信頼できないデバイスからのparser入力はshape・time-budget assertionでfuzzします。
- SSRF保護はoperator設定のoutbound endpointを名前解決し、link-local、metadata、multicast、broadcastの候補をすべて拒否したうえで、検査済みIPへ接続を固定してDNS rebindingを防ぎます。
- リリース整合性はKMS管理鍵と登録済みtrust registryで保証し、fingerprintは**リポジトリ外**（別の認証情報で配信されるDNS TXTレコード）にアンカーされています。
- 依存のinstall scriptを無効化しているため、installでコードを実行する依存はなく、ネイティブモジュールは同梱prebuiltバイナリから供給されます。native依存のaudit盲点は手動検証手順と共に文書化しています。

Default hardware integration CI、正式process manager/OCI成果物、OpenAPIがないため満点とはしません。

---

## 5. SonarQube相当Quality Gate

| Metric | 結果 | Rating |
|---|---:|---|
| Reliability | Critical/Highの既知不具合なし。通知ログのフリーズは修正・二重化済み | A |
| Security | 高確度secret・dependency findingなし。独立したagent種別を含む完全なRBAC、監査、SSRF保護、KMSリリース署名 | A |
| Maintainability | エージェント機能で複数moduleが成長したが、いずれもtestで境界化 | A |
| Coverage | line 84.95% / branch 80.07% / function 81.70%（CI gateが検査するスコープ） | A |
| Duplication | 手動・静的reviewで重大な新規重複なし | A（推定） |

**Quality gate: 合格。**

### 主な保守性hotspot

| File | 行数 | 評価 |
|---|---:|---|
| `public/js/ai-insights.js` | 892 | notification/insight renderingが同居 |
| `src/history.js` | 847 | query/cache/bootstrap抽出後もstore orchestrationが大きい |
| `server.js` | 811 | bootstrapとdependency wiring。エージェント・watchdog起動で成長 |
| `src/db-migrate.js` | 755 | schema migration v1--v16 |
| `public/js/log.js` | 734 | pagination、filter、renderが同居 |
| `public/js/graph.js` | 679 | 抽出済みhelper/panel/rendererのorchestration |
| `src/devices.js` | 665 | device identity、persistence、merge lifecycle |
| `src/pollers/cisco.js` | 661 | parser/handshake抽出後のstateful SSH lifecycle |
| `src/mcp-publication-gate.js` | 639 | 公開判断、client release timing、diagnostics |
| `src/pollers/yamaha.js` | 627 | adapter parser周辺のstateful SSH lifecycle |
| `public/js/devices.js` | 594 | device UI orchestration |
| `public/js/auth-socket.js` | 575 | auth対応のsocket bootstrapと再接続 |
| `mcp-server.js` | 570 | transport bootstrapとOAuth wiring |
| `src/routes/agents.js` | 569 | エージェントのenrollment、承認、ingest、capabilityルート |
| `src/ai-provider.js` | 563 | multi-provider AI client（SSRF guard付き） |
| `src/device-identify.js` | 559 | device fingerprintingヒューリスティクス |

今サイクルの成長はHub-Agentが触れたmodule — `db-migrate.js`（新規migration 4件）、`history.js`、`server.js`、新規の`routes/agents.js` — に集中しています。いずれも手に負えない域には達しておらず、それぞれのtest coverageの範囲内に留まっています。

---

## 結論

現在のmainは、文書化されたself-hostedデプロイモデルに対して十分な多人数運用向けセキュリティ制御を備えています。自動品質ゲートは広く、データ変更操作はfail-closed、AI provider呼び出しは時間とcontextで制限され、deny-by-defaultのRBACが全面適用され、MCPはOAuth保護・rate limit・監査付きで、Critical/Highの問題は残っていません。

今サイクルを定義づけたのはmacOS Hub-Agentであり、注目すべきは**セキュリティモデルを緩めずに新しいingest表面を追加した**ことです。エージェントは使い回しのsessionではなく独自のアクセス種別を持ち、資格情報はhash-only保存、enrollmentはセルフサービスtokenではなく管理者承認で終わり、観測は二重検証・冪等保存されます。新しい認証付き書き込み経路は往々にして手を抜きがちな箇所ですが、ここは抜いていません。

信頼性はもう1つの筋です。単一のagent-scopeクエリが同期的なDBドライバを十分長くブロックすると、504の背後でプロセス全体が固まり得ます — 遅いページというより障害に見える種類の失敗です。これはあるべき場所（スキャンをseekに変えるindex）で修正し、さらにevent-loop watchdogで囲うことで、将来の病的クエリがハングではなく高速な再起動に劣化するようにしました。watchdogは復帰を外部service managerに依存しており、それが単一プロセス設計の正直な限界です。

CoverageはA評価を維持し、コマンドが出力しgateが強制する単一スコープで報告することで、前回レポートが抱えていた二重数値の曖昧さを解消しました。保守性は大型機能として想定どおりの方向へ動きました — 複数moduleが成長し、いずれも過度ではなく、成長は新機能のある場所に集中しています。残る改善余地は種類として不変で、SLSA provenance（Signed-Releasesの残り2点）、OSS-Fuzzによる継続fuzzing、OpenAPI契約、正式なOCI/serviceの成果物 — いずれもリリースのblockerではなく需要駆動の拡張です。
