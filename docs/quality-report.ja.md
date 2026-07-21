# EgressView コード品質レポート

- **評価日**: 2026-07-21
- **評価基準**: PR #121後のmain `cee5f5f`
- **バージョン**: 1.5.1
- **Node.js**: >=22（CI: 22 / 24）
- **評価方法**: 自動テスト、V8 coverage、静的解析、依存・secret scan、browser smoke、手動コードレビュー

> 本レポートは現在のmainを評価します。SonarQubeとOpenSSFのスコアはリポジトリ内容からの推定で、公式scannerは実行していません。penetration testとfuzzing campaignも対象外です。

---

## 総合評価

**総合グレード: A**

CriticalまたはHighの不具合は見つかりませんでした。前回レビューで発見し修正した中程度の端末メモ永続化問題（PR #112）は引き続き修正済みです。以降10件のPR（#112〜#121）がマージされました: AIチャット信頼性修正3件、ASUSブートストラップ再接続、AI洞察への端末コンテキスト追加、価格カバレッジ診断、デモDB隔離、および依存関係メンテナンスです。全変更にregression testが含まれ、unit test数は1,465件から1,477件に増加しました。

SOHO向けself-hosted network monitorとして、自動品質管理は引き続き強固です。endpointを持つ全route moduleでstrict Zodを利用し、API 73件中71件を認証で保護し、DB migration/restoreはfail-closed、HTTP logはrequest IDで相関でき、AI provider呼び出しはAbortSignalで時間制限され、ASUSポーリングのoverlap coalescingでトークン更新の重複を防止し、backup検証はmain event loopから分離されています。

| 評価軸 | 結果 | 判定 |
|---|---:|---|
| OWASP ASVS Level 1 | 14領域中13領域が適合または緩和済み | private network前提で適合 |
| OpenSSF Scorecard | 推定約8.4/10 | 強いrepository hygiene |
| ISO/IEC 25010 | 平均8.6/10 | 高品質 |
| Node.js Best Practices | 45/50 | 優秀 |
| SonarQube相当gate | 合格、coverageはB | High以上のblockerなし |

## レビュー結果

### 前回レポート（PR #111基準）以降の変更

| PR | タイトル | 分類 |
|---:|---|---|
| #112 | 端末メモ保存のfail-closed化 | 信頼性修正 |
| #113 | AI chat質問消失の防止 | AI信頼性 |
| #114 | AI provider変更後の新規chat開始 | AI信頼性 |
| #115 | サーバ再起動後のASUSポーリング復元 | ブートストラップ修正 |
| #116 | AI洞察へ端末コンテキスト追加 | 機能追加 |
| #117 | GPT-5.5利用価格の追加 | 機能追加 |
| #118 | AI価格カバレッジ診断の改善 | 機能追加 |
| #119 | デモDB runtime成果物の隔離 | 衛生 |
| #120 | actionsグループ更新（setup-node 7、configure-pages 6、upload-pages-artifact 5、deploy-pages 5） | 依存 |
| #121 | bonjour-service 1.4.3、eslint 10.7.0 | 依存 |

### 主な改善点

- **AIチャット耐障害性**: inference失敗時にconversation IDを保持。pre-persistence network障害時は未送信の質問を入力欄に復元。provider/model変更時はHTTP 409を返さず自動的に新規conversationを開始。
- **ASUSブートストラップ**: 保存済みASUS認証情報がserver起動時に復元され、overlap-coalescedなpoll cycleでトークン更新の重複を防止。
- **AIコンテキスト境界**: 端末インベントリ（最大30台、合計48KiB）をAI分析に含めつつ、credential、メモ、生ログ、アーカイブ端末、管理アドレスを除外。
- **価格診断**: pricing dataが不完全な場合に月額AI費用をpartialと表示。発見済み・手動登録モデルのカバレッジ指標を表示。
- **デモ隔離**: runtime DBとbackupを1つのignore対象ディレクトリに集約し、schema v7 snapshot health checkを追加。

### 残余リスク

- **中・運用**: hardware/external service依存のintegration test 4ファイルはdefault CI workflowに含まれません。unitとbrowser smokeはfixture/demo modeで動きますが、Yamaha、ASUS、Slack、conntrackの確認には明示的な環境が必要です。
- **低・保守性**: `history.js`（763行）、`public/js/log.js`（715行）、`public/js/graph.js`（675行）、`devices.js`（665行）、Cisco/Yamaha pollerは引き続き大きな変更面です。重要parserとdata pathにはtestがありますが、今後も既存の段階的抽出を維持すべきです。
- **低・条件付きsecurity**: 現行設計はVPN/private networkとheader token/session認証が前提です。Internetへ直接公開、またはmulti-user化する場合は、信頼できるTLS reverse proxy、IP allowlist、proxy側global rate limit、監査可能なclient IP処理を先に追加します（P2-41）。
- **低・ecosystem**: OpenAPI、署名付きrelease、継続fuzzing、OCI imageはありません。現時点では需要発生時のtaskで、release blockerではありません。

---

## 実測結果

| 検査 | 結果 |
|---|---|
| Coverage付きunit test | 1,477件成功、失敗0 |
| V8 coverage | line 79.36%、branch 79.40%、function 75.94% |
| CI coverage下限 | line 70%、branch 75%、function 65% — 合格 |
| Playwright browser smoke | 66件成功、条件付き1件skip |
| ESLint | 合格 |
| Frontend HTML挿入監査 | `innerHTML` / `insertAdjacentHTML` 0件 |
| Production依存監査 | 脆弱性0件 |
| Secret scan | 高確度secret・環境固有LAN IPなし |
| Package dry-run | 成功 |
| PR #121 GitHub CI | Node 22/24、release safety、ASH、browser smoke、Pages build成功 |

### コードベースメトリクス

| メトリクス | 値 |
|---|---:|
| Source行数（server、mcp、src、public/js） | 24,739 |
| Test行数（unit、integration、smoke） | 22,999 |
| Test対source比率 | 93.0% |
| Unit test file | 104 |
| Integration test file | 4 |
| Browser smoke | 1 file（1,558行） |
| `src/` module | 85 |
| Poller module | 15 |
| Route module | 14 |
| HTTP endpoint | 75（API 73 + health 2） |
| 認証済みAPI endpoint | 71/73 |
| 公開API endpoint | login、admin token verify |
| 公開運用endpoint | `/healthz`、`/readyz`。固定最小responseのみ |
| strict Zod適用済みendpoint route module | 13/13 |
| Production依存package | 12 |
| Parameterized SQL preparation | 119 |
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
| Access control | 合格 | API 73件中71件に`requireAdmin`。WebSocket handshakeも同じ認証境界 |
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
| Maintained | 10 | PR #121まで継続的にrelease・改善 |
| Code review | 7 | PRと必須checkを運用。branch protection policyは独立検証していない |
| Fuzzing | 0 | Continuous fuzzingなし |
| Signed releases | 0 | GPG/Sigstore署名なし |

---

## 3. ISO/IEC 25010

| 品質特性 | Score | 強み | 残るgap |
|---|---:|---|---|
| 機能適合性 | 9 | 複数router、AI洞察（端末コンテキスト付き）、脅威調査、export、MCP | OpenAPIなし |
| 性能効率性 | 9 | WAL、batch、bounded summary、cache、backup worker | 重いbackup検証中はhost-levelの短い遅延が残り得る |
| 互換性 | 8 | Node 22/24、JA/EN、Yamaha/Cisco/ASUS/conntrack | CIのhardware確認はfixture中心 |
| 使用性 | 9 | Responsive UI、setup guide、自動検出、health診断、AI価格カバレッジ表示 | One-click deployなし |
| 信頼性 | 9 | migration/restore/config/notes fail-closed、health、cancel、request ID、ASUS自動再接続 | 組み込みservice supervisorなし |
| Security | 9 | strict schema、CSP、secret管理、ASH、bounded AI context（48KiB上限、credential除外） | Internet境界防御は条件付き |
| 保守性 | 9 | 85 module、強いtest、route/poller/query分離 | 600-763行のorchestration moduleが残る |
| 移植性 | 7 | Pure Node runtime、環境設定 | 正式OCI image/systemd unitなし |

**平均: 8.6/10。**

---

## 4. Node.js Best Practices

**準拠率: 45/50（90%）。**

- Domain、route、poller adapter、DB bootstrap、browser renderingの責務を分離しています。
- 外部async処理にtimeout/AbortSignal上限があり、backup pruneはworkerとsingle-flight jobで隔離され、ASUSポーリングはoverlapping cycleをcoalesceします。
- Loggerは`AsyncLocalStorage`で安全な`X-Request-Id`を付け、query stringは記録しません。
- Graceful shutdown、readiness、schema migration、config rollback、永続化失敗をtestしています。
- ESLint、V8 coverage、Node 22/24、Playwright、ASH、secret scan、dependency auditをPR gateにしています。

Default hardware integration CI、process manager/container成果物、OpenAPI、Internet向けglobal edge rate limitがないため満点とはしません。

---

## 5. SonarQube相当Quality Gate

| Metric | 結果 | Rating |
|---|---:|---|
| Reliability | Critical/Highの既知不具合なし。前回の中メモ保存問題は修正済み | A |
| Security | 高確度secret・dependency findingなし | A |
| Maintainability | 大きなmoduleはあるがtestと抽出済みhelperで境界化 | A |
| Coverage | line 79.36% / branch 79.40% / function 75.94% | B |
| Duplication | 手動・静的reviewで重大な新規重複なし | A（推定） |

**Quality gate: 合格。**

### 主な保守性hotspot

| File | 行数 | 評価 |
|---|---:|---|
| `src/history.js` | 763 | query/cache/bootstrap抽出後もstore orchestrationが大きい |
| `public/js/log.js` | 715 | pagination、filter、renderが同居 |
| `public/js/graph.js` | 675 | 抽出済みhelper/panel/rendererのorchestration |
| `src/devices.js` | 665 | device identity、persistence、merge lifecycle |
| `src/pollers/cisco.js` | 645 | parser/handshake抽出後のstateful SSH lifecycle |
| `server.js` | 638 | bootstrapとdependency wiring |
| `src/pollers/yamaha.js` | 614 | adapter parser周辺のstateful SSH lifecycle |

いずれも将来の段階的refactor候補で、現在のrelease blockerではありません。変更はbehaviorを維持し、小さなPRで行うべきです。

---

## 結論

現在のmainは、文書化されたself-hosted/private network運用に適した品質です。自動gateは広く、data変更処理はfail-closedで、AI provider呼び出しは時間制限・コンテキスト上限付きで、本レビュー後にCritical/Highの既知問題は残っていません。前回レポート以降、AIチャット耐障害性、ASUSブートストラップ信頼性、価格可観測性が向上し、新たな不具合やregressionは導入されていません。次の費用対効果が高い作業はP2-8第二段階の実利用判断です。OpenAPI、Internet境界強化、conntrack実機拡大、OCI配布は需要に応じて着手します。
