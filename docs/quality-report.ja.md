# EgressView コード品質レポート

- **評価日**: 2026-07-16
- **コミット**: `65de1486080473afc1eaa12fdf0bea87429215e5` (main)
- **バージョン**: 1.3.5
- **Node.js**: >=22 (テスト: 22, 24)
- **評価者**: 自動静的解析 + 手動コードレビュー (Kiro AI)

---

## Executive Summary

**総合グレード: A**

EgressView は評価した全フレームワークにおいて**プロダクショングレードの品質**を示しています。前回評価 (v1.2.2) からの大幅な改善点として、テスト対ソース比率 94.1% (+19.2pp)、HTTP ルートへの zod スキーマ検証展開 (5/13 ルートファイル適用済)、history.js の分割リファクタリング (985→718行)、conntrack ポーラーおよび手動脅威調査機能の追加が確認されました。セキュリティ設計は引き続き OWASP ASVS L1 に適合し、最小限の依存フットプリント (本番 11 パッケージ) も維持されています。

| # | フレームワーク | スコア | 判定 |
|---|---|---|---|
| 1 | OWASP ASVS Level 1 | 13/14 セクション適合 | ✅ 適合 |
| 2 | OpenSSF Scorecard | ~8.2/10 | 上位 15% |
| 3 | ISO/IEC 25010 | 平均 8.6/10 | 高品質 |
| 4 | Node.js Best Practices (goldbergyoni) | 44/50 (88%) | 優秀 |
| 5 | SonarQube Quality Gate (推定) | 全項目 A (Coverage 除く) | ✅ PASSED |

### 主な強み

- **セキュリティ設計** — scrypt パスワードハッシュ, タイミングセーフなトークン比較, リクエスト毎 CSP nonce, `style-src 'self'` (style-src-attr 除去済), CI 統合 ASH + secret scan + npm audit, SHA ピン留め GitHub Actions (2 ワークフロー)
- **テスト文化** — 84 unit + 4 integration + Playwright smoke (1,163行); テスト対ソース比率 94.1%; 全ドメインモジュールで `_resetForTest()` パターン
- **コード規律** — サーバーサイド `var` ゼロ, `eval` ゼロ, TODO/FIXME ゼロ, 命名規約一貫, ESLint v10 + innerHTML 監査
- **入力検証** — HTTP ルートに zod スキーマ検証を段階展開 (5/13 ルートファイル, `http-validation.js` ヘルパー)
- **最小依存** — 本番パッケージ 11 個のみ; Dependabot (cooldown 7日)
- **アーキテクチャ改善** — history.js 分割 (history-queries.js), auth.js 分割 (auth-sessions + router-setup), AbortSignal 対応

### v1.2.2 からの主な変更点

| 項目 | v1.2.2 | v1.3.5 (現在) | 変化 |
|---|---|---|---|
| ソースコード行数 | 16,791 | 19,975 | +19.0% |
| テストコード行数 | 12,577 | 18,793 | +49.4% |
| テスト対ソース比率 | 74.9% | 94.1% | +19.2pp |
| ユニットテストファイル | 54 | 84 | +30 |
| インテグレーションテスト | 3 | 4 | +1 |
| ソースモジュール (src/) | 48 | 69 | +21 |
| ポーラー (src/pollers/) | 11 | 15 | +4 |
| ルートファイル (src/routes/) | 10 | 13 | +3 |
| API エンドポイント | 46 | 56 | +10 |
| 本番依存パッケージ | 10 | 11 | +1 (zod) |
| requireAdmin 適用ルート | 62 | 79 | +17 |
| zod 検証適用ルート | 0/10 | 5/13 | +5 |
| ドキュメント (docs/*.md) | 14 | 22 | +8 |

### 主なギャップと次のステップ

| 優先度 | ギャップ | 推定工数 |
|---|---|---|
| 高 | コードカバレッジ計測 (c8) | 2h |
| 高 | 残り 8 ルートファイルへの zod 検証展開 | 4h |
| 中 | Health-check エンドポイント | 0.5h |
| 中 | リクエスト ID (X-Request-Id) | 1h |
| 中 | マジックナンバー 8000ms を定数化 (10箇所) | 1h |
| 低 | OpenAPI スキーマ / Dockerfile | 6h |

残りのギャップは家庭内/SOHO ネットワーク監視ツールとしては典型的であり、アーキテクチャ変更なしに段階的に対応可能です。

---

## コードベースメトリクス

| メトリクス | 値 |
|---|---|
| ソースコード行数 (server + src + public/js + mcp) | 19,975 |
| テストコード行数 (unit + integration + smoke) | 18,793 |
| テスト対ソース比率 | 94.1% |
| ユニットテストファイル数 | 84 |
| インテグレーションテストファイル数 | 4 |
| Smoke テスト (Playwright) ファイル数 | 1 |
| ソースモジュール数 (src/) | 69 |
| ポーラー数 (src/pollers/) | 15 |
| ルートファイル数 (src/routes/) | 13 |
| API エンドポイント数 | 56 |
| 本番依存パッケージ数 | 11 |
| 関数あたり平均行数 | ~15.4 |
| 深いネスト行数 (>5レベル) | 7 |
| `var` 使用箇所 (サーバーサイド) | 0 |
| `eval` / `new Function` 使用箇所 | 0 |
| TODO/FIXME/HACK コメント | 0 |
| パラメータ化 SQL 文 | 99 |
| requireAdmin 適用ルート | 79 |
| zod スキーマ定義 (HTTP ルート) | 39 |

---

## 1. OWASP ASVS Level 1

**判定: 適合 (13/14 カテゴリ合格)**

| カテゴリ | 状況 | 根拠 |
|---|---|---|
| V2 認証 | ✅ | scrypt (N=16384, r=8, p=1), timingSafeEqual, 256bit セッショントークン, ブルートフォース防御 (5回/5分ロック), パスワード 8-256文字, zod スキーマ検証 |
| V3 セッション管理 | ✅ | トークン SHA-256 ハッシュ保存, 30日スライディング失効, パスワード変更時に全セッション無効化, 定期 prune, タッチスロットル (5分) |
| V4 アクセス制御 | ✅ | 79 ルートに `requireAdmin` 適用、未認証は login/verify の 2 エンドポイントのみ |
| V5 入力検証 | ✅ | Body 64KB 制限, zod スキーマ検証 (5/13 ルート, `http-validation.js` ヘルパー), プライベート IP のみルーターアクセス許可 (SSRF 防止), パストラバーサル防止, null バイト拒否 |
| V6 暗号化 | ✅ | scrypt (パスワード), randomBytes (トークン/nonce/salt), SHA-256 (TOFU ホスト鍵/セッション), timingSafeEqual |
| V7 エラー処理 | ✅ | 汎用 500 レスポンス, スタックトレース非露出, タイミング攻撃対策 (500ms 遅延) |
| V8 データ保護 | ✅ | 設定ファイル mode 0o600, バックアップ 0o600, TLS 秘密鍵 0o600, ログにパスワード非出力 |
| V9 通信セキュリティ | ✅ | HTTPS opt-in + HSTS (max-age 1年), CSP (リクエスト毎 nonce, style-src 'self') |
| V10 悪意コード | ✅ | eval/new Function ゼロ, innerHTML 使用を CI で監査 (allowlist 方式) |
| V12 ファイル操作 | ✅ | アップロードサイズ制限, バックアップ名 zod 検証 (1-255文字), パストラバーサル防止 |
| V13 API セキュリティ | ✅ | JSON 専用, express.json 64KB 制限, メソッド別ルート, zod `.strict()` で不明フィールド拒否 |
| V14 設定 | ✅ | ハードコード秘密情報なし, env/config file 経由, CI secret scan |
| V11 ビジネスロジック | ⚠️ | CSRF 明示的対策なし (same-origin CSP + token 認証で緩和) |

**v1.2.2 からの改善:** V5 (入力検証) が zod 展開により実質的に強化、V12 (ファイル操作) が zod バックアップ名検証により PASS に昇格。

---

## 2. OpenSSF Scorecard (推定)

**推定スコア: 8.2/10**

| チェック項目 | スコア | 根拠 |
|---|---|---|
| Pinned-Dependencies | 10/10 | 全 GitHub Actions を SHA ピン留め + バージョンコメント (ci.yml + pages.yml) |
| Token-Permissions | 10/10 | `permissions: contents: read` (最小権限), pages は `pages: write` + `id-token: write` のみ |
| Dangerous-Workflow | 10/10 | `pull_request_target` なし |
| Binary-Artifacts | 10/10 | バイナリなし |
| Security-Policy | 10/10 | SECURITY.md + GitHub private reporting |
| License | 10/10 | AGPL-3.0-only |
| SAST | 10/10 | ASH スキャナー + カスタム secret scan + innerHTML 監査 (CI) |
| Vulnerabilities | 10/10 | `npm audit --omit=dev` (CI) |
| Dependency-Update-Tool | 10/10 | Dependabot (npm + Actions, weekly, cooldown 7日) |
| CI-Tests | 10/10 | Unit + Integration + Playwright smoke, Node 22/24 マトリクス |
| Maintained | 9/10 | 活発なリリース (v1.0.0→v1.3.5, 71 PR merged), PR テンプレート, CONTRIBUTING.md |
| Code-Review | 7/10 | PR テンプレート + CI 必須 (branch protection は確認不可) |
| Fuzzing | 0/10 | なし (ネットワーク監視ツールでは一般的) |
| Signed-Releases | 0/10 | GPG 署名なし (git clone 配布) |

---

## 3. ISO/IEC 25010

| 品質特性 | スコア | 主な強み | 主なギャップ |
|---|---|---|---|
| 機能適合性 | 9/10 | 56 API, 15 ポーラー (conntrack 追加), MCP サーバー, 手動脅威調査, CSV エクスポート | OpenAPI 定義なし |
| 性能効率性 | 9/10 | 多層キャッシュ (history-cache), WAL, 圧縮, バッチ化, 重複排除, bounded summaries | 負荷テストなし |
| 互換性 | 8/10 | Node 22/24, JA/EN i18n, OS 非依存, Linux conntrack 対応 | Docker なし |
| 使用性 | 9/10 | Demo モード, .env.example, 自動パスワード生成, MCP 統合, API/アーキテクチャドキュメント (JA/EN) | ワンクリックデプロイなし |
| 信頼性 | 9/10 | Graceful shutdown, 自動バックアップ, WAL checkpoint, reopen(), DB マイグレーション v5, AbortSignal 対応 | Health-check なし |
| セキュリティ | 9/10 | OWASP ASVS L1 適合 (13/14), innerHTML 監査, zod 段階展開 | CSRF 明示なし |
| 保守性 | 9/10 | 69 モジュール, テスト比率 94.1%, 分割リファクタ (history, auth), http-validation ヘルパー | TypeScript なし |
| 移植性 | 7/10 | Pure Node.js, ENV 設定, OS 非依存 | Docker/systemd なし |

---

## 4. Node.js Best Practices (goldbergyoni)

**準拠率: 44/50 主要プラクティス (88%)**

| セクション | スコア | ハイライト |
|---|---|---|
| 1. プロジェクト構造 | 9/10 | ドメイン分割 (routes/pollers/core), レイヤー分離, 13 ルートファイル, history 分割リファクタ |
| 2. エラー処理 | 9/10 | async/await 統一, 中央エラーハンドラ, graceful exit (SIGTERM/SIGINT), AbortSignal |
| 3. コードスタイル | 10/10 | ESLint v10, const 優先 (var ゼロ), innerHTML 監査, 命名規約一貫 |
| 4. テスト | 9/10 | 84 unit + 4 integration + Playwright smoke, AAA パターン, 分離初期化, 94.1% テスト比率 |
| 5. プロダクション | 7/10 | 構造化ログ, 脆弱性自動検出, LTS Node, GitHub Pages ドキュメント |
| 6. セキュリティ | 9/10 | ASH, security headers, eval ゼロ, auth rate limit, zod (HTTP + MCP) |

**未対応の主要プラクティス:**
- コードカバレッジ計測ツール (c8/nyc) なし
- Health-check エンドポイントなし
- リクエスト/トランザクション ID なし
- Docker / プロセスマネージャなし
- OpenAPI ドキュメントなし (API リファレンスは Markdown で提供)
- グローバル HTTP レート制限なし (認証レート制限のみ)

---

## 5. SonarQube 等価メトリクス

| メトリクス | 値 | レーティング |
|---|---|---|
| コード行数 | 19,975 | - |
| テスト対ソース比率 | 94.1% | Excellent (>80%) |
| 重複率 | < 2% | **A** (閾値: <=3%) |
| 認知的複雑度 | 非常に低い | **A** (深いネスト: 7行のみ) |
| 技術的負債比率 | 3.5% (~20h) | **A** (閾値: <=5%) |
| 信頼性 | 既知バグ 0 | **A** |
| セキュリティホットスポット | 0 | **A** |
| セキュリティレーティング | - | **A** |
| 保守性 | 負債比率 3.5% | **A** |
| カバレッジ (推定) | ~70-80% | **B** (計測ツールなし) |

**Quality Gate: ✅ PASSED**

### 複雑度ホットスポット (上位 5)

| ファイル | 行数 | 判断密度/100行 |
|---|---|---|
| device-identify.js | 547 | 25.2 |
| routes/connections.js | 329 | 25.5 |
| db-migrate.js | 353 | 19.3 |
| pollers/cisco.js | 643 | 17.0 |
| devices.js | 656 | 16.8 |

### コードスメル (合計 12 件)

| 重要度 | 件数 | 例 |
|---|---|---|
| MAJOR | 2 | `history.js` 718行 (分割後も多責務), `devices.js` 656行 |
| MINOR | 4 | `pollers/cisco.js` 643行, `pollers/yamaha.js` 598行, `device-identify.js` 547行, `server.js` 600行 |
| INFO | 6 | マジックナンバー `8000`ms x10箇所, DB initDb() ボイラープレート重複 (5ファイル) |

---

## 6. 前回評価 (v1.2.2) → 現在 (v1.3.5) 改善サマリー

| 領域 | 改善内容 |
|---|---|
| テスト | ユニットテスト +30 ファイル (54→84), インテグレーション +1, テスト比率 74.9%→94.1% |
| セキュリティ | zod スキーマ検証を HTTP ルートに段階展開 (5/13), `http-validation.js` ヘルパー, requireAdmin +17 |
| アーキテクチャ | `history.js` 分割 (history-queries.js 300行分離), `auth.js` 分割 (auth-sessions + router-setup), AbortSignal 対応 |
| 機能 | conntrack ポーラー, 手動脅威調査 (AbuseIPDB/VirusTotal/OTX), CSV エクスポート, history-cache, schema v5 migration |
| CI/CD | GitHub Pages ワークフロー追加 (SHA pinned), soak 安定性修正 |
| ドキュメント | API リファレンス (JA/EN), アーキテクチャ (JA/EN), conntrack セットアップ (JA/EN), 手動脅威調査 (JA/EN) |
| 依存管理 | zod v4 追加 (スキーマ検証基盤), express v5 維持 |
| コード品質 | `history.js` 985→718行 (-27%), MAJOR コードスメル 3→2件, パラメータ化 SQL 77→99 |

---

*本レポートはリポジトリソースコードの自動静的解析により生成されました。動的テスト (ペネトレーションテスト, ファジング) は実施していません。SonarQube メトリクスは grep ベースの分析からの推定値であり、実際の SonarQube スキャナーによるものではありません。OpenSSF Scorecard はリポジトリ内容からの推定であり、正確なスコアは `scorecard` CLI をライブ GitHub リポジトリに対して実行する必要があります。*
