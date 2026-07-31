# EgressView コード品質レポート

- **評価日**: 2026-07-28
- **評価基準**: PR #140後のmain `fea7843`
- **バージョン**: 1.6.0
- **Node.js**: >=22（CI: 22 / 24）
- **評価方法**: 自動テスト、V8 coverage、静的解析、依存・secret scan、browser smoke、手動コードレビュー

> 本レポートは現在のmainを評価します。SonarQubeとOpenSSFのスコアはリポジトリ内容からの推定で、公式scannerは実行していません。penetration testとfuzzing campaignも対象外です。

---

## 総合評価

**総合グレード: A**

CriticalまたはHighの不具合は見つかりませんでした。前回レポート（PR #121基準）以降、17件のPR（#124--#140）がマージされました: AI event notifications、認証フル強化（Google OIDC + PKCE、HttpOnly cookie、CSRF保護）、deny-by-default権限境界（3ロール・7パーミッション）、scoped API identity、ブラウザセッションRBAC、MCP OAuth保護（RFC 9728メタデータ）、rate limiting、監査trailです。DBスキーマはv7からv12に進みました。Unit test数は1,477件から1,670件に、Playwright smokeは66件から69件に増加しました。

本コードベースはprivate networkとauthenticated multi-user双方に適した強固なsecurity postureを備えています: API 90件中84件が認証・権限gatingを要求し、permission matrixがHTTP routeとMCP tool全93件を分類し、deny-by-default middlewareが未分類routeを起動時に拒否し、API identityはhash-only storageと独立revocationを採用し、MCP accessはRS256 JWT検証（JWKS経由）とsubject単位rate limitで保護されています。

| 評価軸 | 結果 | 判定 |
|---|---:|---|
| OWASP ASVS Level 1 | 14領域中14領域が適合または緩和済み | 完全適合 |
| OpenSSF Scorecard | 推定約8.6/10 | 強いrepository hygiene |
| ISO/IEC 25010 | 平均8.8/10 | 高品質 |
| Node.js Best Practices | 46/50 | 優秀 |
| SonarQube相当gate | 合格、coverageはB | High以上のblockerなし |

## レビュー結果

### 前回レポート（PR #121基準）以降の変更

| PR | タイトル | 分類 |
|---:|---|---|
| #125 | AI event notifications | 機能追加 |
| #126 | Slack設定をGeneralタブへ移動 | UX |
| #127 | AI通知設定を保存前に確認 | UX |
| #128 | 認証強化 + 監査ログ（OIDC、PKCE、HttpOnly cookie、CSRF、rate limit、schema v9） | セキュリティ |
| #129 | auth audit用デフォルトDBパス修正 | バグ修正 |
| #130 | OIDCドメインallowlist警告 + v1.6.0 release（schema v9維持） | セキュリティ |
| #131 | Deny-by-default権限境界（7パーミッション、permission-matrix） | セキュリティ |
| #132 | OAuth認可サーバ評価ドキュメント | ドキュメント |
| #133 | Scoped API identities（schema v10） | セキュリティ |
| #134 | ブラウザセッションRBAC（viewer/operator/admin、schema v11） | セキュリティ |
| #135 | 安定audit principalHash（schema v12） | セキュリティ |
| #136 | 設定画面にセッションロール表示 | UX |
| #137 | リモートMCPのOAuth保護（JWKS、RFC 9728） | セキュリティ |
| #138 | Dependabot actions更新（checkout 7.0.1、setup-python 7.0.0） | 依存 |
| #139 | MCP scope-to-service-identity mapping | セキュリティ |
| #140 | MCP audit + rate limiting（rate limit、audit trail、concurrency cap） | セキュリティ |

### 主な改善点

- **認証**: Google OIDC + PKCEフロー、HttpOnly session cookie、CSRFトークン保護、IP単位lockout、ローカル復旧ログイン（TTY CLI）。Versioned KDF migrationによりpassword hashのダウンタイムなしアップグレードを実現。
- **認可**: deny-by-default権限境界。7パーミッション（network.read、notes.write、ai.run、settings.write、backup.restore、auth.admin、audit.read）と3ロール（viewer、operator、admin）をネスト定義。Permission matrixがHTTP route + MCP toolの93件を網羅し、未分類routeは起動時に拒否。
- **API identity**: スコープ付き、有効期限付きトークン。hash-only storageと独立revocationを採用。各identityは特定のpermission setに紐付け。
- **監査**: append-only audit_eventsテーブル。pseudonymous actorHash/principalHash、180日retention、専用audit.readパーミッション。
- **MCP OAuth**: RFC 9728 protected-resource metadata discovery、RS256 JWT検証（JWKSエンドポイント経由）、scope-to-service-identity mapping、rate limiting（60/min global、30/min subject/client、4 concurrent）、独立MCP audit store。
- **セッションRBAC**: ブラウザセッションがロール（viewer/operator/admin）を保持し、設定画面に表示。権限enforceはsessionとAPI identity双方に均一適用。

### 残余リスク

- **中・運用**: hardware/external service依存のintegration test 4ファイルはdefault CI workflowに含まれません。unitとbrowser smokeはfixture/demo modeで動きますが、Yamaha、ASUS、Slack、conntrackの確認には明示的な環境が必要です。
- **低・保守性**: `mcp-server.js`（891行）、`src/history.js`（789行）、`public/js/ai-insights.js`（783行）、`public/js/log.js`（715行）、`server.js`（690行）が大きな変更面です。重要pathにはtestがありますが、今後もhelper抽出の継続を推奨します。
- **低・ecosystem**: OpenAPI、署名付きrelease、継続fuzzing、OCI imageはありません。現時点では需要発生時のtaskで、release blockerではありません。

---

## 実測結果

| 検査 | 結果 |
|---|---|
| Coverage付きunit test | 1,670件成功、失敗0 |
| V8 coverage | line 81.23%、branch 78.27%、function 77.74% |
| CI coverage下限 | line 70%、branch 75%、function 65% — 合格 |
| Playwright browser smoke | 69件成功 |
| ESLint | 合格 |
| Frontend HTML挿入監査 | `innerHTML` / `insertAdjacentHTML` 0件 |
| Production依存監査 | 脆弱性0件 |
| Secret scan | 高確度secret・環境固有LAN IPなし |
| ASH（Automated Security Helper） | actionable finding 0件 |
| GitHub Actions SHA pinning | 15/15 pinned、0 unpinned |
| PR #140 GitHub CI | Node 22/24、release safety、ASH、browser smoke、Pages build成功 |

### コードベースメトリクス

| メトリクス | 値 |
|---|---:|
| Source行数（server、mcp、src、public/js） | 29,165 |
| Test行数（unit、integration、smoke） | 26,929 |
| Test対source比率 | 92.3% |
| Unit test file | 122 |
| Integration test file | 4 |
| Browser smoke | 1 file（1,681行） |
| `src/` module | 104 |
| Poller module | 15 |
| Route module | 17 |
| HTTP endpoint | 92（API 90 + health 2） |
| 認証・権限gating済みAPI endpoint | 84/90 |
| 公開API endpoint | login、admin-verify、auth-status、auth-methods、oidc-start、oidc-callback |
| 公開運用endpoint | `/healthz`、`/readyz`。固定最小responseのみ |
| strict Zod適用済みendpoint route module | 16/17（auth.jsはendpoint 0件） |
| Permission matrix entries | 93（HTTP route + MCP tool全分類） |
| 定義済みpermission | 7 |
| ロール | 3（viewer、operator、admin） |
| Production依存package | 13 |
| Parameterized SQL preparation | 150 |
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
| Access control | 合格 | API 90件中84件に`enforceApiPermissions`。deny-by-default権限境界。WebSocket handshakeも同じ境界。permission matrix 93件 |
| 入力検証 | 合格 | JSON 64KB、16/17 endpoint moduleのstrict Zod、未知key拒否、文字列・範囲上限 |
| 暗号 | 合格 | secret/correlationの`randomBytes`/UUID、session/TOFU/principalHashのSHA-256、timing-safe equality、MCPのRS256 JWT検証 |
| Error処理 | 合格 | 汎用500、stack非公開、request ID付きserver log |
| Data保護 | 合格 | config/backup/TLS keyは0600、公開config/logからsecret除外、API identity hash-only storage |
| 通信 | 合格 | HTTPS/HSTS対応。OIDC callbackはsecure redirectを強制。MCP OAuthはHTTPS JWKS経由 |
| 悪意コード | 合格 | evalなし、frontend HTML挿入監査をCIで強制 |
| File処理 | 合格 | upload上限、backup名検証、traversal防止、restore/migration fail-closed |
| API security | 合格 | method別route、strict schema、response size/time上限、認証付きexport、MCP rate limiting |
| Configuration | 合格 | hard-coded credentialなし、example設定、secret scan、production demo拒否 |
| Business logic | 合格 | HttpOnly cookie + CSRF保護、API identity用explicit permission token、deny-by-default enforcement |
| 監査・ログ | 合格 | append-only audit_events（pseudonymous actorHash/principalHash）、180日retention、MCP専用audit store |

Health endpointは意図的に未認証ですが、`no-store`付きの固定liveness/readinessのみを返し、router IP、credential、件数は公開しません。

---

## 2. OpenSSF Scorecard（推定）

**推定スコア: 8.6/10。**

| Check | Score | 根拠 |
|---|---:|---|
| Pinned dependencies | 10 | 全15 GitHub Actionをfull commit SHAへ固定 |
| Token permissions | 10 | 既定read-only。Pagesだけ必要権限を追加 |
| Dangerous workflow | 10 | `pull_request_target`なし |
| Binary artifacts | 10 | commit済みbinaryなし |
| Security policy | 10 | `SECURITY.md`とprivate vulnerability reporting |
| License | 10 | AGPL-3.0-only |
| SAST | 10 | ASH、secret scan、ESLint、frontend挿入監査、npm audit |
| Vulnerabilities | 10 | production `npm audit`をCI実行。本レビュー0件 |
| Dependency updates | 10 | npm/Actionsのweekly Dependabot、7日cooldown |
| CI tests | 9 | PRでunit/coverageとbrowser smoke。実機integrationは明示実行 |
| Maintained | 10 | PR #140まで継続的にrelease・改善 |
| Code review | 8 | PRと必須checkを運用。RBACとpermission matrixがreview基準を強化 |
| Fuzzing | 0 | Continuous fuzzingなし |
| Signed releases | 0 | GPG/Sigstore署名なし |

---

## 3. ISO/IEC 25010

| 品質特性 | Score | 強み | 残るgap |
|---|---:|---|---|
| 機能適合性 | 9 | 複数router、AI洞察（notification付き）、脅威調査、export、MCP + OAuth | OpenAPIなし |
| 性能効率性 | 9 | WAL、batch、bounded summary、cache、worker分離backup、MCP concurrency cap | 重いbackup検証中はhost-levelの短い遅延が残り得る |
| 互換性 | 8 | Node 22/24、JA/EN、Yamaha/Cisco/ASUS/conntrack | CIのhardware確認はfixture中心 |
| 使用性 | 9 | Responsive UI、setup guide、自動検出、health診断、ロール表示、通知設定確認 | One-click deployなし |
| 信頼性 | 9 | migration/restore/config/notes fail-closed、health、cancel、request ID、ASUS再接続、rate limiting | 組み込みservice supervisorなし |
| Security | 10 | OIDC/PKCE、RBAC、deny-by-default permission、CSRF、HttpOnly cookie、API identity hash-only storage、MCP OAuth/JWKS、audit trail、rate limit | -- |
| 保守性 | 9 | 104 module、強いtest、route/poller/query分離、permission matrix | 690-891行のorchestration moduleが残る |
| 移植性 | 9 | Cloud非依存profile、署名付きportable source、offline runtime gate、version管理rollback | 正式OCI image/systemd unitなし |

**平均: 9.0/10。**

---

## 4. Node.js Best Practices

**準拠率: 46/50（92%）。**

- Domain、route、poller adapter、DB bootstrap、auth middleware、browser renderingの責務を分離しています。
- 外部async処理にtimeout/AbortSignal上限があり、backup pruneはworkerとsingle-flight jobで隔離され、ASUSポーリングはoverlapping cycleをcoalesceし、MCP requestはconcurrency capを適用しています。
- Loggerは`AsyncLocalStorage`で安全な`X-Request-Id`を付け、query stringは記録しません。
- Graceful shutdown、readiness、schema migration、config rollback、永続化失敗、permission enforcementをtestしています。
- ESLint、V8 coverage、Node 22/24、Playwright、ASH、secret scan、dependency auditをPR gateにしています。
- 認証ロジックは専用module（auth-middleware、auth-cookies、auth-audit、oidc-google）に分離し、single-responsibilityを遵守しています。

Default hardware integration CI、正式process manager/OCI成果物、OpenAPI、continuous fuzzingがないため満点とはしません。

---

## 5. SonarQube相当Quality Gate

| Metric | 結果 | Rating |
|---|---:|---|
| Reliability | Critical/Highの既知不具合なし | A |
| Security | 高確度secret・dependency findingなし。完全なRBACと監査 | A |
| Maintainability | 大きなmoduleはあるがtestと抽出済みhelperで境界化 | A |
| Coverage | line 81.23% / branch 78.27% / function 77.74% | B |
| Duplication | 手動・静的reviewで重大な新規重複なし | A（推定） |

**Quality gate: 合格。**

### 主な保守性hotspot

| File | 行数 | 評価 |
|---|---:|---|
| `mcp-server.js` | 891 | OAuth、rate-limit、audit責務追加で大幅に成長 |
| `src/history.js` | 789 | query/cache/bootstrap抽出後もstore orchestrationが大きい |
| `public/js/ai-insights.js` | 783 | notification/insight renderingが同居 |
| `public/js/log.js` | 715 | pagination、filter、renderが同居 |
| `server.js` | 690 | bootstrapとdependency wiring |
| `public/js/graph.js` | 675 | 抽出済みhelper/panel/rendererのorchestration |
| `src/devices.js` | 665 | device identity、persistence、merge lifecycle |
| `src/pollers/cisco.js` | 645 | parser/handshake抽出後のstateful SSH lifecycle |
| `src/pollers/yamaha.js` | 614 | adapter parser周辺のstateful SSH lifecycle |
| `public/js/devices.js` | 593 | device UI orchestration |
| `src/db-migrate.js` | 557 | schema migration v1-v12 |

いずれも将来の段階的refactor候補で、現在のrelease blockerではありません。変更はbehaviorを維持し、小さなPRで行うべきです。

---

## 結論

現在のmainは、文書化されたself-hosted運用モデルに加え、強固なmulti-user security controlを備えた品質です。自動gateは広く、data変更処理はfail-closedで、AI provider呼び出しは時間制限・コンテキスト上限付きで、完全なRBACとdeny-by-default permissionが適用され、MCP accessはOAuth保護・rate limiting・監査を受け、Critical/Highの既知問題は残っていません。前回レポート以降、OIDC認証、セッションRBAC、scoped API identity、包括的な監査ログを通じてsecurity postureが大幅に強化され、testのカバレッジと件数も比例して増加しています。OpenAPI、continuous fuzzing、OCI配布は需要に応じて着手します。
