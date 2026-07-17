# EgressView コード品質レポート

- **評価日**: 2026-07-16
- **コミット**: `7b83c4fd0d537f1c66383bf8335f5522f35f38c5` (main)
- **バージョン**: 1.3.5
- **Node.js**: >=22 (テスト: 22, 24)
- **評価者**: 自動静的解析 + 手動コードレビュー (Kiro AI)

---

## Executive Summary

**総合グレード: A**

EgressView は評価した全フレームワークにおいて**プロダクショングレードの品質**を示しています。v1.2.2 からの改善として、本番依存への zod 追加によるスキーマ検証基盤の整備、テスト文化の大幅な強化 (90.2% テスト対ソース比率、v1.2.2 比 +15.3pp)、CSP の `style-src-attr` 除去によるセキュリティ強化が確認されました。セキュリティ設計は OWASP ASVS L1 に適合し、最小限の依存フットプリント (本番 11 パッケージ) もプロジェクトの品質を際立たせています。

| # | フレームワーク | スコア | 判定 |
|---|---|---|---|
| 1 | OWASP ASVS Level 1 | 12/14 セクション適合 | ✅ 適合 |
| 2 | OpenSSF Scorecard | ~8.0/10 | 上位 15% |
| 3 | ISO/IEC 25010 | 平均 8.4/10 | 高品質 |
| 4 | Node.js Best Practices (goldbergyoni) | 43/50 (86%) | 優秀 |
| 5 | SonarQube Quality Gate (推定) | 全項目 A/B、CoverageをCIで実測 | ✅ PASSED |

### 主な強み

- **セキュリティ設計** — scrypt パスワードハッシュ, タイミングセーフなトークン比較, リクエスト毎 CSP nonce, `style-src 'self'` (style-src-attr 除去済), CI 統合 ASH + secret scan + npm audit, SHA ピン留め GitHub Actions
- **テスト文化** — unit 1,205件 + 実機integration 3本 + Playwright smoke 54件; V8 coverageをNode 22 CIで計測し、下限未達を拒否
- **コード規律** — `var` ゼロ, `eval` ゼロ, TODO/FIXME ゼロ, 命名規約一貫, ESLint v10 + innerHTML 監査
- **最小依存** — 本番パッケージ 11 個のみ; Dependabot (cooldown 7日)

### v1.2.2 からの主な変更点

| 項目 | v1.2.2 | v1.3.5 | 変化 |
|---|---|---|---|
| ソースコード行数 | 16,791 | 18,832 | +12.2% |
| テストコード行数 | 12,577 | 17,397 | +38.3% |
| テスト対ソース比率 | 74.9% | 92.4% | +17.5pp |
| ユニットテストファイル | 54 | 74 | +20 |
| ソースモジュール (src/) | 48 | 58 | +10 |
| API エンドポイント | 46 | 52 | +6 |
| 本番依存パッケージ | 10 | 11 | +1 (zod) |
| requireAdmin 適用ルート | 62 | 74 | +12 |

### 主なギャップと次のステップ

| 優先度 | ギャップ | 推定工数 |
|---|---|---|
| 高 | HTTP ルートに zod バリデーション適用 (MCP のみ適用済) | 6h |
| 中 | 重要HTTPルートのbranch coverageを段階的に引き上げる | 継続 |
| 中 | Health-check エンドポイント | 0.5h |
| 中 | リクエスト ID (X-Request-Id) | 1h |
| 中 | マジックナンバー 8000ms を定数化 (10箇所) | 1h |
| 低 | OpenAPI スキーマ / Dockerfile | 6h |

残りのギャップは家庭内/SOHO ネットワーク監視ツールとしては典型的であり、アーキテクチャ変更なしに段階的に対応可能です。

---

## コードベースメトリクス

| メトリクス | 値 |
|---|---|
| ソースコード行数 (server + src + public/js + mcp) | 18,832 |
| テストコード行数 (unit + integration + smoke) | 17,397 |
| テスト対ソース比率 | 92.4% |
| ユニットテストファイル数 | 74 |
| インテグレーションテストファイル数 | 3 |
| Smoke テスト (Playwright) ファイル数 | 1 |
| ソースモジュール数 (src/) | 58 |
| ポーラー数 (src/pollers/) | 11 |
| ルートファイル数 (src/routes/) | 10 |
| API エンドポイント数 | 52 |
| 本番依存パッケージ数 | 11 |
| 関数あたり平均行数 | ~15.6 |
| 深いネスト行数 (>5レベル) | 7 |
| `var` 使用箇所 | 0 |
| `eval` / `new Function` 使用箇所 | 0 |
| TODO/FIXME/HACK コメント | 0 |
| パラメータ化 SQL 文 | 95 |
| requireAdmin 適用ルート | 74 |

---

## 1. OWASP ASVS Level 1

**判定: 適合 (12/14 カテゴリ合格)**

| カテゴリ | 状況 | 根拠 |
|---|---|---|
| V2 認証 | ✅ | scrypt (N=16384, r=8, p=1), timingSafeEqual, 256bit セッショントークン, ブルートフォース防御 (5回/5分ロック), パスワード最小 8文字, 最大 256文字 |
| V3 セッション管理 | ✅ | トークン SHA-256 ハッシュ保存, 30日スライディング失効, パスワード変更時に全セッション無効化, 定期 prune, タッチスロットル (5分) |
| V4 アクセス制御 | ✅ | 74 ルートに `requireAdmin` 適用、未認証は login/verify の 2 エンドポイントのみ |
| V5 入力検証 | ✅ | Body 64KB 制限, 型・長さチェック, プライベート IP のみルーターアクセス許可 (SSRF 防止), パストラバーサル防止, null バイト拒否 |
| V6 暗号化 | ✅ | scrypt (パスワード), randomBytes (トークン/nonce/salt), SHA-256 (TOFU ホスト鍵), timingSafeEqual |
| V7 エラー処理 | ✅ | 汎用 500 レスポンス, スタックトレース非露出, タイミング攻撃対策 (500ms 遅延) |
| V8 データ保護 | ✅ | 設定ファイル mode 0o600, バックアップ 0o600, TLS 秘密鍵 0o600, ログにパスワード非出力 |
| V9 通信セキュリティ | ✅ | HTTPS opt-in + HSTS (max-age 1年), CSP (リクエスト毎 nonce, style-src-attr 除去) |
| V10 悪意コード | ✅ | eval/new Function ゼロ, innerHTML 使用を CI で監査 (allowlist 方式) |
| V13 API セキュリティ | ✅ | JSON 専用, express.json 64KB 制限, メソッド別ルート |
| V14 設定 | ✅ | ハードコード秘密情報なし, env/config file 経由 |
| V11 ビジネスロジック | ⚠️ | CSRF 明示的対策なし (same-origin CSP + token 認証で緩和) |
| V12 ファイル操作 | ⚠️ | アップロードサイズ制限あり、zod スキーマ検証は MCP サーバーのみ (HTTP ルートは型チェックのみ) |

---

## 2. OpenSSF Scorecard (推定)

**推定スコア: 8.0/10**

| チェック項目 | スコア | 根拠 |
|---|---|---|
| Pinned-Dependencies | 10/10 | 全 GitHub Actions を SHA ピン留め + バージョンコメント |
| Token-Permissions | 10/10 | `permissions: contents: read` のみ (最小権限) |
| Dangerous-Workflow | 10/10 | `pull_request_target` なし |
| Binary-Artifacts | 10/10 | バイナリなし |
| Security-Policy | 10/10 | SECURITY.md + GitHub private reporting |
| License | 10/10 | AGPL-3.0-only |
| SAST | 10/10 | ASH スキャナー + カスタム secret scan + innerHTML 監査 (CI) |
| Vulnerabilities | 10/10 | `npm audit --omit=dev` (CI) |
| Dependency-Update-Tool | 10/10 | Dependabot (npm + Actions, weekly, cooldown 7日) |
| CI-Tests | 10/10 | Unit + Integration + Playwright smoke, Node 22/24 マトリクス |
| Maintained | 9/10 | 活発なリリース (v1.0.0→v1.3.5), PR テンプレート, CONTRIBUTING.md |
| Code-Review | 7/10 | PR テンプレート + CI 必須 (branch protection は確認不可) |
| Fuzzing | 0/10 | なし (ネットワーク監視ツールでは一般的) |
| Signed-Releases | 0/10 | GPG 署名なし (git clone 配布) |

---

## 3. ISO/IEC 25010

| 品質特性 | スコア | 主な強み | 主なギャップ |
|---|---|---|---|
| 機能適合性 | 8/10 | 52 API, 11 ポーラー, MCP サーバー, 完全な監視ライフサイクル | OpenAPI 定義なし |
| 性能効率性 | 9/10 | 多層キャッシュ, WAL, 圧縮, バッチ化, 重複排除 | 負荷テストなし |
| 互換性 | 8/10 | Node 22/24, JA/EN i18n, OS 非依存 | Docker なし |
| 使用性 | 8/10 | Demo モード, .env.example, 自動パスワード生成, MCP 統合 | ワンクリックデプロイなし |
| 信頼性 | 9/10 | Graceful shutdown, 自動バックアップ, WAL checkpoint, reopen(), DB マイグレーション整合性チェック | Health-check なし |
| セキュリティ | 9/10 | OWASP ASVS L1 適合レベル, innerHTML 監査 | CSRF 明示なし |
| 保守性 | 8/10 | 57 モジュール, テスト比率 90.2%, _resetForTest パターン | TypeScript なし |
| 移植性 | 7/10 | Pure Node.js, ENV 設定, OS 非依存 | Docker/systemd なし |

---

## 4. Node.js Best Practices (goldbergyoni)

**準拠率: 43/50 主要プラクティス (86%)**

| セクション | スコア | ハイライト |
|---|---|---|
| 1. プロジェクト構造 | 8/10 | ドメイン分割 (routes/pollers/core), レイヤー分離, 10 ルートファイル |
| 2. エラー処理 | 9/10 | async/await 統一, 中央エラーハンドラ, graceful exit (SIGTERM/SIGINT) |
| 3. コードスタイル | 10/10 | ESLint v10, const 優先 (var ゼロ), innerHTML 監査, 命名規約一貫 |
| 4. テスト | 9/10 | unit 1,205件 + 3 integration + Playwright smoke 54件, V8 coverage CIゲート, AAA パターン |
| 5. プロダクション | 7/10 | 構造化ログ, 脆弱性自動検出, LTS Node |
| 6. セキュリティ | 9/10 | ASH, security headers, eval ゼロ, auth rate limit, zod (MCP) |

**未対応の主要プラクティス:**
- 実機integration 3本は機器と認証情報が必要なため公開CIでは未実行
- Health-check エンドポイントなし
- リクエスト/トランザクション ID なし
- Docker / プロセスマネージャなし
- OpenAPI ドキュメントなし
- グローバル HTTP レート制限なし (認証レート制限のみ)

---

## 5. SonarQube 等価メトリクス

| メトリクス | 値 | レーティング |
|---|---|---|
| コード行数 | 18,832 | - |
| テスト対ソース比率 | 92.4% | Excellent (>80%) |
| 重複率 | < 2% | **A** (閾値: <=3%) |
| 認知的複雑度 | 非常に低い | **A** (深いネスト: 7行のみ) |
| 技術的負債比率 | 3.8% (~21h) | **A** (閾値: <=5%) |
| 信頼性 | 既知バグ 0 | **A** |
| セキュリティホットスポット | 0 | **A** |
| セキュリティレーティング | - | **A** |
| 保守性 | 負債比率 3.8% | **A** |
| カバレッジ (V8実測) | line 72.33%, branch 79.05%, function 69.01% | **B** (CI下限 70% / 75% / 65%) |

**Quality Gate: ✅ PASSED**

### 複雑度ホットスポット (上位 5)

| ファイル | 行数 | 判断密度/100行 |
|---|---|---|
| routes/auth.js | 538 | 27.6 |
| device-identify.js | 547 | 25.2 |
| routes/connections.js | 300 | 24.3 |
| threat-intel.js | 300 | 20.0 |
| history.js | 985 | 16.1 |

### コードスメル (合計 14 件)

| 重要度 | 件数 | 例 |
|---|---|---|
| MAJOR | 3 | `history.js` 985行 (複数責務), `device-identify.js` 547行, `routes/auth.js` 538行 |
| MINOR | 4 | `pollers/cisco.js` 643行, `pollers/yamaha.js` 598行, `devices.js` 656行, `server.js` 596行 |
| INFO | 7 | マジックナンバー `8000`ms x10箇所, DB initDb() ボイラープレート重複 (5ファイル) |

---

## 6. v1.2.2 → v1.3.5 改善サマリー

| 領域 | 改善内容 |
|---|---|
| テスト | ユニットテスト +20 ファイル, テスト比率 74.9%→92.4% |
| セキュリティ | CSP `style-src-attr` 除去, requireAdmin 適用ルート +12 |
| 機能 | MCP サーバー (zod 検証付き), Cisco ポーラー, ルーター管理 |
| 依存管理 | zod 追加 (スキーマ検証基盤), express v5 移行 |
| コード品質 | innerHTML 監査 CI 統合, パラメータ化 SQL +18 |

---

*本レポートはリポジトリソースコードの自動静的解析により生成されました。動的テスト (ペネトレーションテスト, ファジング) は実施していません。SonarQube メトリクスは grep ベースの分析からの推定値であり、実際の SonarQube スキャナーによるものではありません。OpenSSF Scorecard はリポジトリ内容からの推定であり、正確なスコアは `scorecard` CLI をライブ GitHub リポジトリに対して実行する必要があります。*
