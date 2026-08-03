# EgressView コード品質レポート

- **評価日**: 2026-08-03
- **評価基準**: PR #165後 `dadc545`（parser fuzz test追加）
- **バージョン**: 1.7.0
- **Node.js**: >=22（CI: 22 / 24）
- **評価方法**: 自動テスト、V8 coverage、静的解析、依存・secret scan、browser smoke、parser fuzzing、手動コードレビュー

> 本レポートは現在のmainを評価します。SonarQubeとOpenSSFのスコアはリポジトリ内容からの推定で、公式scannerは実行していません。penetration testも対象外です。

---

## 総合評価

**総合グレード: A**

CriticalまたはHighの不具合は見つかりませんでした。前回レポート（v1.7.0リリース準備、PR #157基準）以降、8件のPR（#158--#165）がマージされました。今回のサイクルではリリースレポートで指摘した2件の中リスクを解消しています: MCP面を責務単位の単一モジュールに分割し（PR #163）`mcp-server.js`を1,076行から570行に削減、parser fuzzingをCIに追加し（PR #165）署名以外で唯一ゼロスコアだったOpenSSFチェックを埋めました。併せてSSRF保護をlink-local/metadata IPへ拡張、検知種別ごとの通知スイッチで運用者に細粒度の制御を提供、MCP audit retention scheduleを修正し、coverage gateを70/75/65から83/79/80に引き上げてセキュリティパスの重点テストによりcoverageを82.74%から92.83%（line）に向上させました。

セキュリティモデルはリリースレポートと同一で、運用による裏付けも変わりません。Permission matrixは93件から106件（HTTP route 95 + MCP tool 11）に増加しており、検知通知routeの追加によるものです。新規endpointはすべてpermission-gatedです。

| 評価軸 | 結果 | 判定 |
|---|---:|---|
| OWASP ASVS Level 1 | 14領域中14領域が適合または緩和済み | 完全適合 |
| OpenSSF Scorecard | 推定約9.0/10 | 強いrepository hygiene |
| ISO/IEC 25010 | 平均9.1/10 | 高品質 |
| Node.js Best Practices | 47/50 | 優秀 |
| SonarQube相当gate | 合格、coverageはA | High以上のblockerなし |

## レビュー結果

### 前回レポート（PR #157基準）以降の変更

| PR | タイトル | 分類 |
|---:|---|---|
| #158 | v1.7.0リリース準備 | ドキュメント |
| #159 | v1.7.0 changelog日付設定 | ドキュメント |
| #160 | operator設定endpointのlink-local/metadata IP遮断 | セキュリティ |
| #161 | 検知種別ごとの通知スイッチ（P2-76） | UX |
| #162 | MCP audit retentionのschedule適用（P2-73） | バグ修正 |
| #163 | MCP面の責務分割（P2-68） | リファクタリング |
| #164 | coverage gateの現実値への引き上げ（P2-69） | テスト |
| #165 | 信頼できないデバイス出力を読むparserのfuzz（P2-71） | テスト |

### 主な改善点

- **MCP分割（P2-68）**: 前回レポートの最上位保守性リスクを解消。`mcp-server.js`を`src/mcp-tools.js`（tool定義とserver factory）、`src/mcp-http-middleware.js`（auth、scope、context、rate limit、audit）、`src/mcp-publication-constants.js`、`src/mcp-publication-evidence.js`に分割しました。ファイルは1,076行から570行に、`src/mcp-publication-gate.js`は868行から639行に縮小。tool定義が再び複数ファイルに分散した場合にfailするテストassertionも追加し、permission matrix scanの弱体化を防止しています。
- **Parser fuzzing（P2-71）**: conntrack、Cisco、Yamaha、ASUS、3つのsyslog readerにまたがる19のparse関数を依存ライブラリなしの生成入力でfuzzします。各入力に対して3つの性質をassert: throwしない、time budget内に返る（catastrophic backtracking防止）、宣言済みの型。短いcampaign（300 iteration）をCIで実行し、50,000 iterationの長期runをon-demandで利用可能です。fuzz harnessはthrow/wrong shape/timeoutの各欠陥クラスを検出できることを自己テストで証明しています。署名以外で唯一ゼロだったOpenSSFチェックを埋めました。
- **SSRF guard（PR #160）**: operator設定のoutbound endpoint（Ollama、内部DNS/PTR）がlink-local（169.254/16）、metadata（fd00:ec2::254）、multicast、broadcastアドレスへの到達を遮断。IPv4-mapped IPv6も展開して再チェックします。loopbackとRFC 1918はself-hostedサービス用に引き続き許可。
- **Coverage gate（P2-69）**: CI下限を70/75/65から83/79/80に引き上げ。branch-heavyなセキュリティパス（OIDCトークン偽造、IP単位lockout、KDF migration rollback、AI通知拒否、role導出）を重点的にテストしてgapを埋めました。
- **MCP audit retention（P2-73）**: `mcpAudit.prune()`がapplication側auditと同様に24時間間隔のunref'd scheduleで実行されるようになり、長時間稼働プロセスでも文書化された180日window が適用されます。
- **検知通知スイッチ（P2-76）**: threat検知とnew-node検知がそれぞれ独立したSlack/historyトグルを持ち、`detectionNotifications` configセクションに永続化されます。

### 残余リスク

- **低・運用**: hardware/external service依存のintegration test 4ファイルはdefault CI workflowに含まれません。unitとbrowser smokeはfixture/demo modeで動きますが、Yamaha、ASUS、Slack、conntrackの確認には明示的な環境が必要です。
- **低・ecosystem**: OpenAPI、OCI image、GPG署名tagはありません。現時点では需要発生時のtaskで、release blockerではありません。
- **低・保守性**: `public/js/ai-insights.js`（872行）と`src/history.js`（789行）が非poller最大のmoduleとして残りますが、今サイクルで成長しておらずtestで境界化されています。

---

## 実測結果

| 検査 | 結果 |
|---|---|
| Coverage付きunit test | 1,938件成功、失敗0（456 suite） |
| V8 coverage | line 92.83%、branch 88.56%、function 89.17% |
| CI coverage下限 | line 83%、branch 79%、function 80% — 合格 |
| Parser fuzz test | 30件成功（3 suite、default 300 iteration） |
| Playwright browser smoke | 70件成功、1件skip |
| ESLint | 合格 |
| Frontend HTML挿入監査 | `innerHTML` / `insertAdjacentHTML` 0件 |
| Production依存監査 | 脆弱性0件 |
| Secret scan | 高確度secret・環境固有LAN IPなし |
| ASH（Automated Security Helper） | actionable finding 0件 |
| GitHub Actions SHA pinning | 19/19 pinned、0 unpinned |
| PR #165 GitHub CI | Node 22/24、release safety、ASH、fuzz、browser smoke、Pages build成功 |

### コードベースメトリクス

括弧内は変化があった項目のv1.7.0リリース（PR #157）時点の値です。

| メトリクス | 値 |
|---|---:|
| Source行数（server、mcp、src、public/js） | 31,435（30,984） |
| Test行数（unit、integration、smoke、fuzz、portability） | 31,851（29,347） |
| Test対source比率 | 101.3%（94.7%） |
| Unit test file | 138（128） |
| Integration test file | 4 |
| Fuzz test file | 3（新規） |
| Browser smoke | 1 file（1,740行） |
| Portability test file | 1 |
| `src/` module | 113（107） |
| Poller module | 15 |
| Route module | 18（17） |
| HTTP route（permission matrix） | 95（92） |
| MCP tool | 11 |
| Permission matrix entries | 106（93） |
| 認証・権限gating済みAPI endpoint | 87/93（84/90） |
| 公開API endpoint | login、admin-verify、auth-status、auth-methods、oidc-start、oidc-callback |
| 公開運用endpoint | `/healthz`、`/readyz`。固定最小responseのみ |
| strict Zod適用済みendpoint route module | 17/18（16/17） |
| 定義済みpermission | 7 |
| ロール | 3（viewer、operator、admin） |
| Production依存package | 13 |
| `docs/`配下のドキュメント | 36 |
| Parameterized SQL preparation | 152 |
| Server-side `var` | 0 |
| `eval` / `new Function` | 0 |
| TODO/FIXME/HACK | 0 |
| `innerHTML` / `insertAdjacentHTML` | 0 |

---

## 1. OWASP ASVS Level 1

**判定: 完全適合（14領域中14領域が適合または緩和済み）。**

| 領域 | 状況 | 根拠 |
|---|---|---|
| 認証 | 合格 | scrypt（versioned KDF migration）、timing-safe比較、256bit session token、失敗遅延、IP単位lockout、Google OIDC + PKCE |
| Session管理 | 合格 | token hash保存、sliding expiry、revoke、password変更処理、定期prune、ロール付きsession |
| Access control | 合格 | API 93件中87件に`enforceApiPermissions`。deny-by-default権限境界。WebSocket handshakeも同じ境界。permission matrix 106件 |
| 入力検証 | 合格 | JSON 64KB、17/18 endpoint moduleのstrict Zod、未知key拒否、文字列・範囲上限、outbound endpoint向けSSRF guard |
| 暗号 | 合格 | secret/correlationの`randomBytes`/UUID、session/TOFU/principalHashのSHA-256、timing-safe equality、MCPのRS256 JWT検証 |
| Error処理 | 合格 | 汎用500、stack非公開、request ID付きserver log |
| Data保護 | 合格 | config/backup/TLS keyは0600、公開config/logからsecret除外、API identity hash-only storage |
| 通信 | 合格 | HTTPS/HSTS対応。OIDC callbackはsecure redirectを強制。MCP OAuthはHTTPS JWKS経由 |
| 悪意コード | 合格 | evalなし、frontend HTML挿入監査をCIで強制 |
| File処理 | 合格 | upload上限、backup名検証、traversal防止、restore/migration fail-closed |
| API security | 合格 | method別route、strict schema、response size/time上限、認証付きexport、MCP rate limiting |
| Configuration | 合格 | hard-coded credentialなし、example設定、secret scan、production demo拒否 |
| Business logic | 合格 | HttpOnly cookie + CSRF保護、API identity用explicit permission token、deny-by-default enforcement |
| 監査・ログ | 合格 | append-only audit_events（pseudonymous actorHash/principalHash）、24時間scheduleで180日retention適用、MCP専用audit store（keyed client address付き） |

Health endpointは意図的に未認証ですが、`no-store`付きの固定liveness/readinessのみを返し、router IP、credential、件数は公開しません。

---

## 2. OpenSSF Scorecard（推定）

**推定スコア: 9.0/10。**

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
| CI tests | 10 | PRでunit/coverage、parser fuzz、browser smoke。実機integrationは明示実行 |
| Maintained | 10 | PR #165まで継続的にrelease・改善（マージ済みPR 161件） |
| Code review | 8 | PRと必須checkを運用。RBACとpermission matrixがreview基準を強化 |
| Fuzzing | 5 | 信頼できないデバイス入力を読む19 parse関数をparser fuzzingで検証。time-budgetとshape assertion付き。依存なし、CI実行。ただしOSS-Fuzz等の継続fuzzing serviceには未登録 |
| Signed releases | 2 | 仕組みと手順書は存在し、releaseパスはCycloneDX SBOM付きの署名付きportable source distributionを生成できます。**ただし実際に署名されたreleaseは存在しません。** `release-signing/trusted-fingerprints.json`に登録鍵はなく、v1.7.0は未署名で配布。加点は仕組みに対するもの。buildは`<artifact>.sig`を生成するため、鍵を用意して資産を添付すれば署名band（8点）に到達。残り2点はSLSA provenance（`*.intoto.jsonl`）を各releaseへ添付する条件 |

---

## 3. ISO/IEC 25010

| 品質特性 | Score | 強み | 残るgap |
|---|---:|---|---|
| 機能適合性 | 9 | 複数router、AI洞察（notification付き）、脅威調査、export、MCP + OAuth、検知種別ごとの通知粒度 | OpenAPIなし |
| 性能効率性 | 9 | WAL、batch、bounded summary、cache、worker分離backup、MCP concurrency cap | 重いbackup検証中はhost-levelの短い遅延が残り得る |
| 互換性 | 9 | Node 22/24、JA/EN、Yamaha/Cisco/ASUS/conntrack、Cognito compatibility profile、proxy配下の`/`とsubpath双方での正常動作 | CIのhardware確認はfixture中心 |
| 使用性 | 9 | Responsive UI、setup guide、自動検出、health診断、ロール表示、検知別通知スイッチ | One-click deployなし |
| 信頼性 | 9 | migration/restore/config/notes fail-closed、health、cancel、request ID、ASUS再接続、rate limiting、scheduled audit retention | 組み込みservice supervisorなし |
| Security | 10 | OIDC/PKCE、RBAC、deny-by-default permission、CSRF、HttpOnly cookie、API identity hash-only storage、MCP OAuth/JWKS、audit trail、rate limit、outbound endpoint向けSSRF guard | -- |
| 保守性 | 9 | 113 module、強いtest（test対source比率101.3%）、route/poller/query分離、permission matrix、MCP責務分割済み、parser fuzz coverage | `public/js/ai-insights.js`（872行）と`src/history.js`（789行）が大きいまま |
| 移植性 | 9 | Cloud非依存profile、署名付きportable source、起動前feature policyを持つoffline mode、host/container向けoffline portability gate、version管理rollback | 正式OCI image/systemd unitなし |

**平均: 9.1/10。**

---

## 4. Node.js Best Practices

**準拠率: 47/50（94%）。**

- Domain、route、poller adapter、DB bootstrap、auth middleware、browser renderingの責務を分離しています。
- 外部async処理にtimeout/AbortSignal上限があり、backup pruneはworkerとsingle-flight jobで隔離され、ASUSポーリングはoverlapping cycleをcoalesceし、MCP requestはconcurrency capを適用しています。
- Loggerは`AsyncLocalStorage`で安全な`X-Request-Id`を付け、query stringは記録しません。
- Graceful shutdown、readiness、schema migration、config rollback、永続化失敗、permission enforcementをtestしています。
- ESLint、V8 coverage、Node 22/24、Playwright、parser fuzz、ASH、secret scan、dependency auditをPR gateにしています。
- 認証ロジックは専用module（auth-middleware、auth-cookies、auth-audit、oidc-google）に分離し、single-responsibilityを遵守しています。
- 信頼できないデバイスからのparser入力をfuzzし、shape・time-budget assertionで検証しています。
- SSRF保護がoperator設定のoutbound endpointをlink-local、metadata、multicast、broadcastから遮断します。

Default hardware integration CI、正式process manager/OCI成果物、OpenAPIがないため満点とはしません。

---

## 5. SonarQube相当Quality Gate

| Metric | 結果 | Rating |
|---|---:|---|
| Reliability | Critical/Highの既知不具合なし | A |
| Security | 高確度secret・dependency findingなし。完全なRBAC、監査、SSRF保護 | A |
| Maintainability | MCP分割でトップリスク解消。残る大きなmoduleはtestで境界化 | A |
| Coverage | line 92.83% / branch 88.56% / function 89.17% | A |
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
| `src/mcp-publication-gate.js` | 639 | 公開判断、client release timing、diagnostics（868行から縮小） |
| `src/pollers/yamaha.js` | 614 | adapter parser周辺のstateful SSH lifecycle |
| `public/js/devices.js` | 593 | device UI orchestration |
| `mcp-server.js` | 570 | transport bootstrapとOAuth wiring（1,076行から縮小） |
| `src/device-identify.js` | 559 | device fingerprintingヒューリスティクス |
| `src/ai-provider.js` | 559 | multi-provider AI client（SSRF guard付き） |
| `src/db-migrate.js` | 557 | schema migration v1-v12 |

MCP面は前回の最大hotspotから分割解消済み。残りは段階的refactor候補で、現在のrelease blockerではありません。

---

## 結論

現在のmainは、文書化されたself-hosted運用モデルに加え、強固なmulti-user security controlを備えた品質です。自動gateは広く、data変更処理はfail-closedで、AI provider呼び出しは時間制限・コンテキスト上限付きで、完全なRBACとdeny-by-default permissionが適用され、MCP accessはOAuth保護・rate limiting・監査を受け、Critical/Highの既知問題は残っていません。

今回の評価サイクルではv1.7.0リリースレポートで指摘した2件の中リスクを解消しました。MCP面を2つの過負荷module（1,076 + 868行）から責務単位の単一モジュール群（570 + 639 + 抽出4 module）に分割し、parser fuzzingをCI導入 — 信頼できないデバイス出力を読む19関数をthrow・shape・time-budget assertionで検証しています。Coverage gateは70/75/65から83/79/80に引き締められ、branch-heavyなセキュリティパスの重点テストによりcoverageは82.74%から92.83%（line）に上昇しました（branch 88.56%、function 89.17%）。Test対source比率は初めて100%を超えました。

新たなSSRF保護がoperator設定endpointをlink-local・cloud metadata IPから遮断し、検知種別ごとの通知スイッチが運用者に細粒度の制御を提供し、MCP audit retention scheduleが起動時のみでなく継続的に180日windowを適用するようになりました。

残る最大の負債はリスクではなく構造の見た目です: frontendのview module（`ai-insights.js` 872行、`log.js` 715行）と`src/history.js`（789行）は大きいものの安定しており、testで境界化され、今サイクルで成長していません。OpenAPI、OSS-Fuzz経由のcontinuous fuzzing、GPG署名tag、OCI配布は需要に応じて着手します。
