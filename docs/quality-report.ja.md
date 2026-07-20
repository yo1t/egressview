# EgressView コード品質レポート

- **評価日**: 2026-07-20
- **評価基準**: PR #111後のmain `e4dd97c`。本レビューでのメモ永続化修正を含む
- **バージョン**: 1.5.1
- **Node.js**: >=22（CI: 22 / 24）
- **評価方法**: 自動テスト、V8 coverage、静的解析、依存・secret scan、browser smoke、手動コードレビュー

> 本レポートは現在のmainを評価します。SonarQubeとOpenSSFのスコアはリポジトリ内容からの推定で、公式scannerは実行していません。penetration testとfuzzing campaignも対象外です。

---

## 総合評価

**総合グレード: A**

CriticalまたはHighの不具合は見つかりませんでした。中程度の信頼性問題を1件発見し、本レビューで修正しました。端末メモのファイル保存に失敗した場合、手動保存、自動調査、端末統合の各経路で未保存のruntime状態が残る可能性がありました。現在は全3経路をfail-closedにし、直前のメモ状態へrollbackし、成功通知を抑止し、関連する端末統合も開始しない実装です。

SOHO向けself-hosted network monitorとして、自動品質管理は強固です。endpointを持つ全route moduleでstrict Zodを利用し、API 71件中69件を認証で保護し、DB migration/restoreはfail-closed、HTTP logはrequest IDで相関でき、backup検証はmain event loopから分離されています。主な残余リスクは、実機依存integrationが通常CI対象外であること、複数の大きなorchestration module、Internetへ直接公開する場合の追加境界防御です。

| 評価軸 | 結果 | 判定 |
|---|---:|---|
| OWASP ASVS Level 1 | 14領域中13領域が適合または緩和済み | private network前提で適合 |
| OpenSSF Scorecard | 推定約8.4/10 | 強いrepository hygiene |
| ISO/IEC 25010 | 平均8.6/10 | 高品質 |
| Node.js Best Practices | 45/50 | 優秀 |
| SonarQube相当gate | 合格、coverageはB | High以上のblockerなし |

## レビュー結果

### 本レビューで修正

**中: 端末メモ保存がfail-open。** `src/notes.js`がfilesystem errorを握り潰し、手動保存、自動調査、端末統合の各経路で未保存のmemory変更が残る可能性がありました。再起動時のメモ消失に加え、メモ移行失敗後に端末統合が進む不整合も起こり得ました。現在は全経路で変更前snapshotを取得し、保存失敗時にruntime状態を復元し、成功通知を抑止し、端末統合を開始しません。HTTP 500、rollback、通知抑止、DB変更抑止をunit testで固定しました。

### 残余リスク

- **中・運用**: hardware/external service依存のintegration test 4ファイルはdefault CI workflowに含まれません。unitとbrowser smokeはfixture/demo modeで動きますが、Yamaha、ASUS、Slack、conntrackの確認には明示的な環境が必要です。
- **低・保守性**: `history.js`（761行）、`public/js/log.js`（715行）、`public/js/graph.js`（675行）、`devices.js`（665行）、Cisco/Yamaha pollerは引き続き大きな変更面です。重要parserとdata pathにはtestがありますが、今後も既存の段階的抽出を維持すべきです。
- **低・条件付きsecurity**: 現行設計はVPN/private networkとheader token/session認証が前提です。Internetへ直接公開、またはmulti-user化する場合は、信頼できるTLS reverse proxy、IP allowlist、proxy側global rate limit、監査可能なclient IP処理を先に追加します（P2-41）。
- **低・ecosystem**: OpenAPI、署名付きrelease、継続fuzzing、OCI imageはありません。現時点では需要発生時のtaskで、release blockerではありません。

---

## 実測結果

| 検査 | 結果 |
|---|---|
| Coverage付きunit test | 1,465件成功、失敗0 |
| V8 coverage | line 79.36%、branch 79.40%、function 75.94% |
| CI coverage下限 | line 70%、branch 75%、function 65% - 合格 |
| Playwright browser smoke | 64件成功、条件付き1件skip |
| ESLint | 合格 |
| Frontend HTML挿入監査 | `innerHTML` / `insertAdjacentHTML` 0件 |
| Production依存監査 | 脆弱性0件 |
| Secret scan | 高確度secret・環境固有LAN IPなし |
| Package dry-run | 成功、178 entries |
| PR #111 GitHub CI | Node 22/24、release safety、ASH、browser smoke、Pages build成功 |

### コードベースメトリクス

| メトリクス | 値 |
|---|---:|
| Source行数（server、mcp、src、public/js） | 24,271 |
| Test行数（unit、integration、smoke） | 22,465 |
| Test対source比率 | 92.6% |
| Unit test file | 102 |
| Integration test file | 4 |
| Browser smoke | 1 file（1,497行） |
| `src/` module | 85 |
| Poller module | 15 |
| Route module | 14 |
| HTTP endpoint | 73（API 71 + health 2） |
| 認証済みAPI endpoint | 69/71 |
| 公開API endpoint | login、admin token verify |
| 公開運用endpoint | `/healthz`、`/readyz`。固定最小responseのみ |
| strict Zod適用済みendpoint route module | 13/13 |
| Production依存package | 12 |
| Parameterized SQL preparation | 117 |
| Server-side `var` | 0 |
| `eval` / `new Function` | 0 |
| TODO/FIXME/HACK | 0 |

---

## 1. OWASP ASVS Level 1

**判定: 文書化されたprivate network前提で適合（14領域中13領域が適合または緩和済み）。**

| 領域 | 状況 | 根拠 |
|---|---|---|
| 認証 | 合格 | scrypt、timing-safe比較、256bit session token、失敗遅延、IP単位lockout |
| Session管理 | 合格 | token hash保存、sliding expiry、revoke、password変更処理、定期prune |
| Access control | 合格 | API 71件中69件に`requireAdmin`。WebSocket handshakeも同じ認証境界 |
| 入力検証 | 合格 | JSON 64KB、13/13 endpoint moduleのstrict Zod、未知key拒否、文字列・範囲上限 |
| 暗号 | 合格 | secret/correlationの`randomBytes`/UUID、session/TOFUのSHA-256、timing-safe equality |
| Error処理 | 合格 | 汎用500、stack非公開、request ID付きserver log |
| Data保護 | 合格 | config/backup/TLS keyは0600、公開config/logからsecret除外 |
| 通信 | 条件付き合格 | HTTPS/HSTS対応。既定はprivate network/VPN運用 |
| 悪意コード | 合格 | evalなし、frontend HTML挿入監査をCIで強制 |
| File処理 | 合格 | upload上限、backup名検証、traversal防止、restore/migration fail-closed |
| API security | 合格 | method別route、strict schema、response size/time上限、認証付きexport |
| Configuration | 合格 | hard-coded credentialなし、example設定、secret scan、production demo拒否 |
| Business logic | 緩和済み | cookie認証を使わず明示header tokenを使用。cookie authやInternet直接公開時は再評価 |

Health endpointは意図的に未認証ですが、`no-store`付きの固定liveness/readinessのみを返し、router IP、credential、件数は公開しません。

---

## 2. OpenSSF Scorecard（推定）

**推定スコア: 8.4/10。**

| Check | Score | 根拠 |
|---|---:|---|
| Pinned dependencies | 10 | 全GitHub Actionをfull commit SHAへ固定 |
| Token permissions | 10 | 既定read-only。Pagesだけ必要権限を追加 |
| Dangerous workflow | 10 | `pull_request_target`なし |
| Binary artifacts | 10 | commit済みbinaryなし |
| Security policy | 10 | `SECURITY.md`とprivate vulnerability reporting |
| License | 10 | AGPL-3.0-only |
| SAST | 10 | ASH、secret scan、ESLint、frontend挿入監査 |
| Vulnerabilities | 10 | production `npm audit`をCI実行。本レビュー0件 |
| Dependency updates | 10 | npm/Actionsのweekly Dependabot、7日cooldown |
| CI tests | 9 | PRでunit/coverageとbrowser smoke。実機integrationは明示実行 |
| Maintained | 10 | PR #111まで継続的にrelease・改善 |
| Code review | 7 | PRと必須checkを運用。branch protection policyは独立検証していない |
| Fuzzing | 0 | Continuous fuzzingなし |
| Signed releases | 0 | GPG/Sigstore署名なし |

---

## 3. ISO/IEC 25010

| 品質特性 | Score | 強み | 残るgap |
|---|---:|---|---|
| 機能適合性 | 9 | 複数router、AI洞察、脅威調査、export、MCP | OpenAPIなし |
| 性能効率性 | 9 | WAL、batch、bounded summary、cache、backup worker | 重いbackup検証中はhost-levelの短い遅延が残り得る |
| 互換性 | 8 | Node 22/24、JA/EN、Yamaha/Cisco/ASUS/conntrack | CIのhardware確認はfixture中心 |
| 使用性 | 9 | Responsive UI、setup guide、自動検出、health診断 | One-click deployなし |
| 信頼性 | 9 | migration/restore/config/notes fail-closed、health、cancel、request ID | 組み込みservice supervisorなし |
| Security | 9 | strict schema、CSP、secret管理、ASH、provider上限 | Internet境界防御は条件付き |
| 保守性 | 9 | 85 module、強いtest、route/poller/query分離 | 600-760行のorchestration moduleが残る |
| 移植性 | 7 | Pure Node runtime、環境設定 | 正式OCI image/systemd unitなし |

**平均: 8.6/10。**

---

## 4. Node.js Best Practices

**準拠率: 45/50（90%）。**

- Domain、route、poller adapter、DB bootstrap、browser renderingの責務を分離しています。
- 外部async処理にtimeout/AbortSignal上限があり、backup pruneはworkerとsingle-flight jobで隔離されています。
- Loggerは`AsyncLocalStorage`で安全な`X-Request-Id`を付け、query stringは記録しません。
- Graceful shutdown、readiness、schema migration、config rollback、永続化失敗をtestしています。
- ESLint、V8 coverage、Node 22/24、Playwright、ASH、secret scan、dependency auditをPR gateにしています。

Default hardware integration CI、process manager/container成果物、OpenAPI、Internet向けglobal edge rate limitがないため満点とはしません。

---

## 5. SonarQube相当Quality Gate

| Metric | 結果 | Rating |
|---|---:|---|
| Reliability | Critical/Highの既知不具合なし。中のメモ保存問題は修正済み | A |
| Security | 高確度secret・dependency findingなし | A |
| Maintainability | 大きなmoduleはあるがtestと抽出済みhelperで境界化 | A |
| Coverage | line 79.36% / branch 79.40% / function 75.94% | B |
| Duplication | 手動・静的reviewで重大な新規重複なし | A（推定） |

**Quality gate: 合格。**

### 主な保守性hotspot

| File | 行数 | 評価 |
|---|---:|---|
| `src/history.js` | 761 | query/cache/bootstrap抽出後もstore orchestrationが大きい |
| `public/js/log.js` | 715 | pagination、filter、renderが同居 |
| `public/js/graph.js` | 675 | 抽出済みhelper/panel/rendererのorchestration |
| `src/devices.js` | 665 | device identity、persistence、merge lifecycle |
| `src/pollers/cisco.js` | 645 | parser/handshake抽出後のstateful SSH lifecycle |
| `server.js` | 632 | bootstrapとdependency wiring |
| `src/pollers/yamaha.js` | 614 | adapter parser周辺のstateful SSH lifecycle |

いずれも将来の段階的refactor候補で、現在のrelease blockerではありません。変更はbehaviorを維持し、小さなPRで行うべきです。

---

## 結論

現在のmainは、文書化されたself-hosted/private network運用に適した品質です。自動gateは広く、data変更処理はfail-closedで、本レビュー後にCritical/Highの既知問題は残っていません。次の費用対効果が高い作業はP2-8第二段階の実利用判断です。OpenAPI、Internet境界強化、conntrack実機拡大、OCI配布は需要に応じて着手します。
