# EgressView コード品質レポート

- **評価日**: 2026-08-05
- **評価基準**: PR #177後 `f8c9116`（KMSリリース署名鍵登録）
- **バージョン**: 1.7.0
- **Node.js**: >=22（CI: 22 / 24 / 26）
- **評価方法**: 自動テスト、V8 coverage、静的解析、依存・secret scan、browser smoke、parser fuzzing、手動コードレビュー

> 本レポートは現在のmainを評価します。SonarQubeとOpenSSFのスコアはリポジトリ内容からの推定で、公式scannerは実行していません。penetration testも対象外です。

---

## 総合評価

**総合グレード: A**

CriticalまたはHighの不具合は見つかりませんでした。前回レポート（PR #165基準）以降、12件のPR（#166--#177）がマージされました。今回のサイクルではリリース署名のストーリーを完了しています: AWS KMS非対称Ed25519鍵を登録し、公開検証鍵とフィンガープリントを4つの独立チャネル（リポジトリ、SECURITY.md、プロジェクトサイト、DNS TXTレコード）で公開し、オフラインバンドルツールが検証側を変更することなくKMSで署名可能になりました。併せて、production依存の脆弱性をoverridesで解消し（socket.io-parserメモリ枯渇、hono ReDoS）、better-sqlite3をglibcの理由を文書化した上で12に意図的にpin止めし、rate-limitのwindow境界テストflakeを排除し、CIをNode 26に拡張し、native依存のaudit盲点を文書化しました。

Coverageは引き続きA評価（line 92.59%、branch 88.61%、function 89.12%）、CI gateは83/79/80。Test対source比率は102.5%に上昇しました。セキュリティモデルは不変です。Permission matrixは106件から107件（HTTP route 96 + MCP tool 11）に増加しました。

| 評価軸 | 結果 | 判定 |
|---|---:|---|
| OWASP ASVS Level 1 | 14領域中14領域が適合または緩和済み | 完全適合 |
| OpenSSF Scorecard | 推定約9.2/10 | 強いrepository hygiene |
| ISO/IEC 25010 | 平均9.1/10 | 高品質 |
| Node.js Best Practices | 47/50 | 優秀 |
| SonarQube相当gate | 合格、coverageはA | High以上のblockerなし |

## レビュー結果

### 前回レポート（PR #165基準）以降の変更

| PR | タイトル | 分類 |
|---:|---|---|
| #166 | PR #165後の品質レポート更新 | ドキュメント |
| #167 | Dependabot: minor-and-patchグループ更新（5件） | 依存関係 |
| #168 | Dependabot: better-sqlite3 12→13 | 依存関係 |
| #169 | honoとsocket.io-parserのパッチ版をpin止めしaudit gate解消 | セキュリティ |
| #170 | rate-limitテストがfixed-window境界を跨ぐ問題の修正 | テスト |
| #171 | better-sqlite3を12にpin — arm64 prebuildがホストにないglibcを要求 | 修正 |
| #172 | Dependabot: AWS SDK minor更新 | 依存関係 |
| #173 | better-sqlite3が12に留まる本当の理由を修正 | ドキュメント |
| #174 | npm auditがbundled Cライブラリを検出できない点を記録 | ドキュメント |
| #175 | Node 26でもunit testを実行 | CI |
| #176 | AWS KMSでオフライン配布物に署名（P2-70） | セキュリティ |
| #177 | リリース署名鍵を登録しフィンガープリントを公開（P2-70） | セキュリティ |

### 主な改善点

- **KMSリリース署名（P2-70）**: リリース鍵がKMS非対称鍵（`ECC_NIST_EDWARDS25519`）になり、秘密半分はexport不可。検証側は不変 — checksumファイルに対する生のEd25519署名で、`openssl`とcommit済み`.pub.pem`のみで検証可能です。フィンガープリントは`SECURITY.md`、両サイトページ、両配布ガイド、DNS TXTレコードで公開。trust registryにはcommit済み鍵から全登録フィンガープリントを再計算するテスト、private key material拒否テスト、single-active-keyルール維持テストがあります。
- **脆弱性overrides（PR #169）**: `socket.io-parser` ≤4.2.6（high、メモリ枯渇）と`hono` <4.12.34（moderate、ReDoS）を`overrides`で修正。親パッケージに修正版がないため。Socket.IOとMCPトランスポートをoverride後に動作確認。
- **better-sqlite3 pin（PR #171, #173）**: `^12.11.1`にpin。実際のblockerはコンパイルではなくarm64 prebuildがglibc 2.38を要求すること（Amazon Linux 2023はglibc 2.34）。CIはx64で通るが本番は壊れる。Dependabotのignoreと理由をconfigに記載。
- **Native依存audit盲点（PR #174）**: `npm audit`がbundled Cライブラリ（SQLite）を検出できないことを文書化。バージョン確認方法、compile options確認方法、ABIトラップを記載。
- **Node 26 CI（PR #175）**: matrixが22, 24, 26に拡張。Node 26は2026-10-28にLTS化。`engines`は`>=22`のまま。
- **Rate-limit flake修正（PR #170）**: limiterのinjectable clockでwindow境界の挙動を決定的にpin。HTTP境界テストは分境界に近い場合のみwaitを追加。

### 残余リスク

- **低・運用**: hardware/external service依存のintegration test 4ファイルはdefault CI workflowに含まれません。
- **低・ecosystem**: OpenAPI、OCI image、GPG署名git tagはありません。
- **低・保守性**: `public/js/ai-insights.js`（872行）と`src/history.js`（789行）が非poller最大のmoduleとして残りますが、今サイクルで成長していません。
- **低・supply chain**: `npm audit`はbetter-sqlite3のamalgamation内のSQLite CVEを検出できません。盲点は手動検証手順と共に文書化済み。

---

## 実測結果

| 検査 | 結果 |
|---|---|
| Coverage付きunit test | 1,961件成功、失敗0（463 suite） |
| V8 coverage | line 92.59%、branch 88.61%、function 89.12% |
| CI coverage下限 | line 83%、branch 79%、function 80% — 合格 |
| Parser fuzz test | 30件成功（3 suite、default 300 iteration） |
| Playwright browser smoke | 70件成功、1件skip |
| ESLint | 合格 |
| Frontend HTML挿入監査 | `innerHTML` / `insertAdjacentHTML` 0件 |
| Production依存監査 | 脆弱性0件 |
| Secret scan | 高確度secret・環境固有LAN IPなし |
| ASH（Automated Security Helper） | actionable finding 0件 |
| GitHub Actions SHA pinning | 19/19 pinned、0 unpinned |

### コードベースメトリクス

括弧内は変化があった項目のPR #165時点の値です。

| メトリクス | 値 |
|---|---:|
| Source行数（server、mcp、src、public/js） | 31,435 |
| Test行数（unit、integration、smoke、fuzz、portability） | 32,214（31,851） |
| Test対source比率 | 102.5%（101.3%） |
| Unit test file | 140（138） |
| Integration test file | 4 |
| Fuzz test file | 3 |
| Browser smoke | 1 file（1,740行） |
| Portability test file | 1 |
| `src/` module | 113 |
| Poller module | 15 |
| Route module | 18 |
| HTTP route（permission matrix） | 96（95） |
| MCP tool | 11 |
| Permission matrix entries | 107（106） |
| 認証・権限gating済みAPI endpoint | 88/94（87/93） |
| 公開API endpoint | login、admin-verify、auth-status、auth-methods、oidc-start、oidc-callback |
| 公開運用endpoint | `/healthz`、`/readyz`。固定最小responseのみ |
| strict Zod適用済みendpoint route module | 17/18 |
| 定義済みpermission | 7 |
| ロール | 3（viewer、operator、admin） |
| Production依存package | 13 |
| `docs/`配下のドキュメント | 36 |
| Parameterized SQL preparation | 152 |
| Server-side `var` | 0 |
| `eval` / `new Function` | 0 |
| TODO/FIXME/HACK | 0 |
| `innerHTML` / `insertAdjacentHTML` | 0 |
| CI Node.jsバージョン | 22、24、26 |
| リリース署名鍵 | 1（KMS Ed25519、trusted-fingerprints.jsonに登録済み） |

---

## 1. OWASP ASVS Level 1

**判定: 完全適合（14領域中14領域が適合または緩和済み）。**

| 領域 | 状況 | 根拠 |
|---|---|---|
| 認証 | 合格 | scrypt（versioned KDF migration）、timing-safe比較、256bit session token、失敗遅延、IP単位lockout、Google OIDC + PKCE |
| Session管理 | 合格 | token hash保存、sliding expiry、revoke、password変更処理、定期prune、ロール付きsession |
| Access control | 合格 | API 94件中88件に`enforceApiPermissions`。deny-by-default権限境界。WebSocket handshakeも同じ境界。permission matrix 107件 |
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

**推定スコア: 9.2/10。**

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
| Maintained | 10 | PR #177まで継続的にrelease・改善（マージ済みPR 173件） |
| Code review | 8 | PRと必須checkを運用。RBACとpermission matrixがreview基準を強化 |
| Fuzzing | 5 | 信頼できないデバイス入力を読む19 parse関数をparser fuzzingで検証。time-budgetとshape assertion付き。依存なし、CI実行。ただしOSS-Fuzz等の継続fuzzing serviceには未登録 |
| Signed releases | 6 | KMS Ed25519署名鍵がmulti-channelフィンガープリント公開と共に登録済み。ツールは署名付きportable source distributionを生成可能。**v1.7.0自体は未署名** — 鍵の登録はリリース後。加点は登録済み鍵、仕組み、trust registryテストに対するもの。8点到達にはGitHub releaseへの`.sig`資産添付が必要。残り2点はSLSA provenance |

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
| 保守性 | 9 | 113 module、強いtest（test対source比率102.5%）、route/poller/query分離、permission matrix、MCP責務分割済み、parser fuzz、native-dep盲点文書化 | `public/js/ai-insights.js`（872行）と`src/history.js`（789行）が大きいまま |
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
- SSRF保護がoperator設定のoutbound endpointをlink-local、metadata、multicast、broadcastから遮断します。
- リリース整合性はKMS管理鍵と登録済みtrust registry・multi-channelフィンガープリント公開で保証します。
- Native依存のaudit盲点を手動検証手順と共に文書化しています。

Default hardware integration CI、正式process manager/OCI成果物、OpenAPIがないため満点とはしません。

---

## 5. SonarQube相当Quality Gate

| Metric | 結果 | Rating |
|---|---:|---|
| Reliability | Critical/Highの既知不具合なし | A |
| Security | 高確度secret・dependency findingなし。完全なRBAC、監査、SSRF保護、KMSリリース署名 | A |
| Maintainability | 新規hotspotなし。残る大きなmoduleはtestで境界化 | A |
| Coverage | line 92.59% / branch 88.61% / function 89.12% | A |
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

現在のmainは、文書化されたself-hosted運用モデルに加え、強固なmulti-user security controlを備えた品質です。自動gateは広く、data変更処理はfail-closedで、AI provider呼び出しは時間制限・コンテキスト上限付きで、完全なRBACとdeny-by-default permissionが適用され、MCP accessはOAuth保護・rate limiting・監査を受け、Critical/Highの既知問題は残っていません。

今回の評価サイクルではリリース署名のストーリーを完了しました。署名鍵はKMS内に存在し秘密半分はexport不可 — v1.7.0リリース準備で特定した単独メンテナの鍵管理リスクを排除しています。Trust registryには登録済み全フィンガープリントを再計算するテスト、private key material拒否テスト、single-active-keyルール維持テストがあります。フィンガープリントは4つの独立チャネルで公開され、ソース間の一致がtrust anchorを確立します。検証側は不変: `openssl`とcommit済み公開鍵で十分です。

Production依存の脆弱性は迅速に解消し（socket.io-parserメモリ枯渇は公開数時間内に対応）、better-sqlite3のpinは誤解を招く「ソースからコンパイル」の説明ではなく実際のglibc blockerを文書化し、native依存のaudit盲点を文書化して「未知のgap」ではなく「管理されたgap」にしました。

Coverageは引き続きA評価でtest対source比率は102.5%。CI matrixは次期LTS 26を含む3つのNode.jsバージョンをカバーしています。新たな保守性hotspotは出現しませんでした。

残る最も明確な改善はGitHub releaseへの`.sig`資産添付（OpenSSF band 8到達）、OSS-Fuzz経由のcontinuous fuzzing、OpenAPI、OCI配布です — いずれも需要に応じて着手する機能強化であり、release blockerではありません。
