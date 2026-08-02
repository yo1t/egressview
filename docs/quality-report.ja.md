# EgressView コード品質レポート

- **評価日**: 2026-08-02
- **評価基準**: PR #157後のv1.7.0リリース準備 `fd54a9e`
- **バージョン**: 1.7.0
- **Node.js**: >=22（CI: 22 / 24）
- **評価方法**: 自動テスト、V8 coverage、静的解析、依存・secret scan、browser smoke、手動コードレビュー

> 本レポートは現在のmainを評価します。SonarQubeとOpenSSFのスコアはリポジトリ内容からの推定で、公式scannerは実行していません。penetration testとfuzzing campaignも対象外です。

---

## 総合評価

**総合グレード: A**

CriticalまたはHighの不具合は見つかりませんでした。前回レポート（v1.6.0、PR #140基準）以降、17件のPR（#141--#157）がマージされました。今回のサイクルはセキュリティモデルの「構築」から「運用」へ移行しています: リモートMCPエンドポイントにpublication gate、Cognito compatibility profile、監査強化が加わり、offline mode・portability gate・署名付きoffline-runtime distributionでP2-65が完了し、reverse proxy配下のHSTS・cookie path・root/subpathアクセスに関する一連の本番不具合を修正しました。DBスキーマはv12のまま変更なし（migration不要）です。Unit test数は1,670件から1,775件に、Playwright smokeは69件から70件（1 skip）に増加しました。

v1.6.0で確立したセキュリティモデルは変更されておらず、運用による裏付けが加わりました: API 90件中84件が認証・権限gatingを要求し、permission matrixがHTTP routeとMCP tool全93件を分類し、deny-by-default middlewareが未分類routeを起動時に拒否し、API identityはhash-only storageと独立revocationを採用し、MCP accessはRS256 JWT検証（JWKS経由）、subject単位rate limit、専用のappend-only audit storeで保護されています。

| 評価軸 | 結果 | 判定 |
|---|---:|---|
| OWASP ASVS Level 1 | 14領域中14領域が適合または緩和済み | 完全適合 |
| OpenSSF Scorecard | 推定約8.7/10 | 強いrepository hygiene |
| ISO/IEC 25010 | 平均9.1/10 | 高品質 |
| Node.js Best Practices | 46/50 | 優秀 |
| SonarQube相当gate | 合格、coverageはB | High以上のblockerなし |

## レビュー結果

### 前回レポート（PR #140基準）以降の変更

| PR | タイトル | 分類 |
|---:|---|---|
| #141 | P2-60 PR 5: リモートMCP publication gate | セキュリティ |
| #142 | v1.6.0向け品質レポート更新 | ドキュメント |
| #143 | Dual-era MCPとportable deployment profile | 移植性 |
| #144 | Private MCPデプロイの強化 | セキュリティ |
| #145 | P2-65 Phase 2: offline modeとself-hosted map asset | 移植性 |
| #146 | P2-65 Phase 3: offline portability gate | 移植性 |
| #147 | P2-65 Phase 4: 署名付きoffline-runtime distribution | サプライチェーン |
| #148 | P2-62: 通知設定の統合とrelease署名の準備 | UX / サプライチェーン |
| #149 | Cognito MCP compatibility profile | 相互運用性 |
| #150 | MCP publication gateのclient release policy修正 | バグ修正 |
| #151 | 信頼済みreverse proxy配下のHSTS修正 | セキュリティ |
| #152 | Proxy配下のrootおよびsubpathアクセス修正 | バグ修正 |
| #153 | root/subpathアクセス向けブラウザcookie path修正 | バグ修正 |
| #154 | 認証済みブラウザの起動順序修正 | バグ修正 |
| #155 | 公開MCP audit diagnosticsの強化 | セキュリティ |
| #156 | MCP toolをhandler完了時点で監査 | セキュリティ |
| #157 | 公開MCP auditへのkeyed client address記録 | セキュリティ |

### 主な改善点

- **Offline mode**: `EGRESSVIEW_OFFLINE_MODE`が起動前に明示的なfeature policyを解決するため、インターネット依存機能は「実行してtimeout」ではなく理由付きで拒否されます。クラウドproviderのSDK clientも生成しません。D3、TopoJSON、world-atlasは固定バージョンでself-hostされ、CSPは外部originを一切許可しません。
- **移植性**: offline portability gateがLinux hostと汎用containerを対象にし、releaseパスはCycloneDX SBOM付きの署名付きportable source distributionを生成できます。署名の仕組みは整備済みですが、プロジェクト鍵は未登録でv1.7.0自体は未署名で配布します（第2節のSigned releases行を参照）。
- **MCP監査の完全性**: tool呼び出しはdispatch時点ではなくhandler完了時点で監査されるため、streaming responseやrequest deadline timeoutでも正確なoutcome行がちょうど1件記録されます。監査storeはclient addressのkeyed pseudonym（`clientIpHash`）を記録し、これによりALB・WAF・Cognito側のログを有効化しなくても同等の証跡が得られます。
- **MCP publication gate**: リモート公開は運用者の明示的判断でgateされ、client release timingをgateから分離したため、公開を取り消しても稼働中clientが取り残されません。
- **Reverse proxy整合性**: 信頼済みproxy配下でもHSTSが正しく付与され、ブラウザcookieはrequest base pathにscopeされるため、同一プロセスで公開ホストの`/`とプライベートsubpathを同時に提供できます。
- **相互運用性**: `registration_endpoint`を公開しない認可サーバ向けにCognito compatibility profileを追加し、dynamic client registrationの代わりに事前登録`client_id`を利用できます。

### 残余リスク

- **中・運用**: hardware/external service依存のintegration test 4ファイルはdefault CI workflowに含まれません。unitとbrowser smokeはfixture/demo modeで動きますが、Yamaha、ASUS、Slack、conntrackの確認には明示的な環境が必要です。
- **中・保守性**: `mcp-server.js`が891行から1,076行に達し、`src/mcp-publication-gate.js`（868行）が新たにhotspot入りしました。MCP面はリポジトリ最大の変更面となっており、OAuth、rate limit、gate、監査の責務は次の成長前に分離すべきです。
- **低・ecosystem**: OpenAPI、継続fuzzing、OCI imageはありません。現時点では需要発生時のtaskで、release blockerではありません。

---

## 実測結果

| 検査 | 結果 |
|---|---|
| Coverage付きunit test | 1,775件成功、失敗0（422 suite） |
| V8 coverage | line 82.74%、branch 78.53%、function 79.77% |
| CI coverage下限 | line 70%、branch 75%、function 65% — 合格 |
| Playwright browser smoke | 70件成功、1件skip |
| ESLint | 合格 |
| Frontend HTML挿入監査 | `innerHTML` / `insertAdjacentHTML` 0件 |
| Production依存監査 | 脆弱性0件 |
| Secret scan | 高確度secret・環境固有LAN IPなし |
| ASH（Automated Security Helper） | actionable finding 0件 |
| GitHub Actions SHA pinning | 19/19 pinned、0 unpinned |
| PR #157 GitHub CI | Node 22/24、release safety、ASH、browser smoke、Pages build成功 |

### コードベースメトリクス

括弧内は変化があった項目のv1.6.0時点の値です。

| メトリクス | 値 |
|---|---:|
| Source行数（server、mcp、src、public/js） | 30,984（29,165） |
| Test行数（unit、integration、smoke） | 29,347（26,929） |
| Test対source比率 | 94.7%（92.3%） |
| Unit test file | 128（122） |
| Integration test file | 4 |
| Browser smoke | 1 file（1,740行） |
| `src/` module | 107（104） |
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
| `docs/`配下のドキュメント | 36（34） |
| Parameterized SQL preparation | 152（150） |
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

**推定スコア: 8.7/10。**

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
| CI tests | 9 | PRでunit/coverageとbrowser smoke。実機integrationは明示実行 |
| Maintained | 10 | PR #157まで継続的にrelease・改善（マージ済みPR 153件） |
| Code review | 8 | PRと必須checkを運用。RBACとpermission matrixがreview基準を強化 |
| Fuzzing | 0 | Continuous fuzzingなし |
| Signed releases | 2 | 仕組みと手順書は存在し、releaseパスはCycloneDX SBOM付きの署名付きportable source distributionを生成できます。**ただし実際に署名されたreleaseは存在しません。** `release-signing/trusted-fingerprints.json`に登録鍵はなく、v1.7.0は決定により未署名で配布し、git tagもGPG署名されておらず、Sigstore/`cosign` attestationもありません。ここでの加点は仕組みに対するものであり、署名済み成果物に対するものではありません。 |

---

## 3. ISO/IEC 25010

| 品質特性 | Score | 強み | 残るgap |
|---|---:|---|---|
| 機能適合性 | 9 | 複数router、AI洞察（notification付き）、脅威調査、export、MCP + OAuth | OpenAPIなし |
| 性能効率性 | 9 | WAL、batch、bounded summary、cache、worker分離backup、MCP concurrency cap | 重いbackup検証中はhost-levelの短い遅延が残り得る |
| 互換性 | 9 | Node 22/24、JA/EN、Yamaha/Cisco/ASUS/conntrack、dynamic client registration非対応の認可サーバ向けCognito compatibility profile、proxy配下の`/`とsubpath双方での正常動作 | CIのhardware確認はfixture中心 |
| 使用性 | 9 | Responsive UI、setup guide、自動検出、health診断、ロール表示、通知設定確認 | One-click deployなし |
| 信頼性 | 9 | migration/restore/config/notes fail-closed、health、cancel、request ID、ASUS再接続、rate limiting | 組み込みservice supervisorなし |
| Security | 10 | OIDC/PKCE、RBAC、deny-by-default permission、CSRF、HttpOnly cookie、API identity hash-only storage、MCP OAuth/JWKS、audit trail、rate limit | -- |
| 保守性 | 9 | 107 module、強いtest（test対source比率94.7%）、route/poller/query分離、permission matrix | MCP面の成長が分割より速く、`mcp-server.js`は1,076行に到達 |
| 移植性 | 9 | Cloud非依存profile、署名付きportable source、起動前feature policyを持つoffline mode、host/container向けoffline portability gate、version管理rollback | 正式OCI image/systemd unitなし |

**平均: 9.1/10。**

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
| Coverage | line 82.74% / branch 78.53% / function 79.77% | B |
| Duplication | 手動・静的reviewで重大な新規重複なし | A（推定） |

**Quality gate: 合格。**

### 主な保守性hotspot

| File | 行数 | 評価 |
|---|---:|---|
| `mcp-server.js` | 1,076 | リポジトリ最大。OAuth、rate limit、deadline、監査が同居しており分離が必要 |
| `public/js/ai-insights.js` | 872 | notification/insight renderingが同居 |
| `src/mcp-publication-gate.js` | 868 | 今サイクルで新規hotspot入り。公開判断、client release timing、diagnosticsが同居 |
| `src/history.js` | 789 | query/cache/bootstrap抽出後もstore orchestrationが大きい |
| `server.js` | 725 | bootstrapとdependency wiring |
| `public/js/log.js` | 715 | pagination、filter、renderが同居 |
| `public/js/graph.js` | 675 | 抽出済みhelper/panel/rendererのorchestration |
| `src/devices.js` | 665 | device identity、persistence、merge lifecycle |
| `src/pollers/cisco.js` | 645 | parser/handshake抽出後のstateful SSH lifecycle |
| `src/pollers/yamaha.js` | 614 | adapter parser周辺のstateful SSH lifecycle |
| `public/js/devices.js` | 593 | device UI orchestration |
| `src/db-migrate.js` | 557 | schema migration v1-v12 |

いずれも将来の段階的refactor候補で、現在のrelease blockerではありません。変更はbehaviorを維持し、小さなPRで行うべきです。

---

## 結論

現在のmainは、文書化されたself-hosted運用モデルに加え、強固なmulti-user security controlを備えた品質です。自動gateは広く、data変更処理はfail-closedで、AI provider呼び出しは時間制限・コンテキスト上限付きで、完全なRBACとdeny-by-default permissionが適用され、MCP accessはOAuth保護・rate limiting・監査を受け、Critical/Highの既知問題は残っていません。

v1.6.0がセキュリティモデルを導入したのに対し、v1.7.0はそれを実際にインターネット公開したMCPデプロイで検証し、運用してはじめて表面化する欠陥を塞ぎました: 二重記録または未記録になっていた監査行、同一プロセスで公開ホストとプライベートsubpathを提供した際に壊れるcookie path、信頼済みproxy配下で抑止されていたHSTS、`registration_endpoint`を公開しない認可サーバへの対応です。Offline modeと署名付きportable distributionにより移植性のトラックも完了しました。Source行数が1,819行増加する中でcoverageは81.23%から82.74%（line）に上昇しており、testはコードの成長に追随しています。

残る最大の負債は挙動ではなく構造です: MCP面（`mcp-server.js` 1,076行と868行のpublication gate）はリポジトリ内で最大のロジック集中箇所であり、次の機能を載せる前に分割すべきです。OpenAPI、continuous fuzzing、GPG署名tag、OCI配布は需要に応じて着手します。
