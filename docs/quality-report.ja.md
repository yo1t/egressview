# EgressView コード品質レポート

- **評価日**: 2026-09-19
- **評価基準**: 前回レポートは `8caee36`。本サイクルは `95e4ef0` までを評価（150コミット）
- **バージョン**: Hub 1.10.0 ・ Agent for Mac 0.5.81 ・ Agent for Windows（3プロジェクト、MSI、CIゲート済み）・ EgressView pack 2.0.3 + `[Unreleased]`
- **Node.js**: >=22（CI: 22 / 24 / 26）。**macOSエージェント**: Swift 6 toolchain、最小 macOS 13。**Windowsエージェント**: .NET 10（C#）、WPF tray UI、Windowsサービス
- **評価方法**: 自動テスト、V8 coverage、静的解析、依存・secret scan、browser smoke、parser fuzzing、手動コードレビュー。各クライアントは*それぞれのプラットフォーム*の基準で評価します: macOSエージェントはMacアプリ品質フレームワーク（§6）、WindowsエージェントはWindowsアプリ品質フレームワーク（§7）

> 本レポートは現在のmainを評価します。SonarQubeとOpenSSFのスコアはリポジトリ内容からの推定で、公式scannerは実行していません。penetration testも対象外です。macOS/Windowsエージェントはプラットフォーム固有ビルド（Network Extension / ETW、keychain / Credential Manager、コード署名）のため、ネイティブ群と署名パイプラインは実行ではなくソースとCIの証跡から評価しています — ただしmacOSエージェントのSwiftテスト群は本レビューのためmacOS上で実行しました。Windows側のテスト、MSIビルド、Authenticode署名は `windows-latest` のCIでのみ実行されます。

---

## 総合評価

**総合グレード: A**

CriticalまたはHighの不具合は見つかりませんでした。今回は*クライアントエージェント*のサイクルです。大きな筋は、**macOSエージェント**が「行を吐くだけのヘッドレス収集器」から**第一級のMacアプリ**へ成熟したこと — globe・Sankey・timeline・mapを備えたメニューバーアプリ、フィルタ可能な接続ログ、CSVエクスポート、ローカルでの脅威照合、署名済みインストーラーパッケージ、アプリ内自己更新、記録が止まったら警告を上げるヘルスチェック、そして機械可読なプライバシーマニフェストです。並行して、**Windowsエージェント**（`apps/agent-windows`、.NET 10）がvertical sliceから実体あるアプリへ育ちました: C#は約2,568行から**14,447行**へ、`Core`/`Service`/`Ui` の3プロジェクト、`LocalService` で動くサービス、ACL付き名前付きパイプ、WPF tray UI、**per-machine MSI**、そして独自の6つのCIチェック。ただし配布チェーンは未完で、MSIは無署名です（§7）。Hub自体は1度だけ（1.10.0へ）動き、エージェント向けの読み取り専用エンドポイントを提供し、*リリースと署名を1つの行為*にしました。それ以外のほぼすべては `apps/` の内側で起きています。

そのため本レポートは、各クライアントを1つに混ぜたチェックリストではなく、*それぞれのプラットフォーム*の基準で2つのフレームワーク（§6 Mac、§7 Windows）に分けて評価します。両者が守る境界は異なり — macOSはサンドボックス・entitlement・公証、WindowsはサービスID・ローカルIPC面・インストーラー — 一方を他方の問いで採点すれば、各々が実際に正しくできている点も誤っている点も見落とします。

macOS作業を定義づけるのは「**Macから何を外へ出さないか**についての抑制」です。エージェントは**pass-only（通過専用）のNetwork Extension content filter**で外向き接続を観測し、トラフィックを一切ブロックせず、既定では接続の中身を何も読みません。宛先名はmacOSから無償で得られ、唯一「読む」ことを頼めるもの — 接続冒頭のTLS ClientHello内のサーバ名 — は明示的なopt-inで、境界検査済み、上限4KB、Macの外へは決して出ません。QUICは**意図的に復号しません**: udp/443から名前が取れるか調べるためにデコーダを作るのではなく、それらのコールバックを構造的に分類して**数える**だけで、バイト列・アドレス・プロセスidを保持しません。脅威インテリジェンスも同じ原則です — 指標セット全体をHub（またはopt-inで同じ公開フィードを直接）から取得し**ローカルで**照合するため、「このアドレスは危険か？」を誰かに尋ねません。0.5.29からはアプリとその拡張の双方が `PrivacyInfo.xcprivacy` を同梱し、**トラッキングなし・収集データ一覧は空**を宣言します。これはプライバシー関連APIを宣言なしに使うとビルドを失敗させるリポジトリテストで裏打ちされています。

第二の筋は、**サンドボックス化された自己更新Macアプリ**と、**署名を忘れられないリリース工程**を誠実に作り込んだことです。一連の修正（P3-24、続くP3-31）は実在の制約と格闘しました: macOSはサンドボックスアプリが書いたものすべてを検疫し、そのような場所から取り出したアプリの**起動を拒否**します。ゆえにディスクイメージのアプリ内更新は成立しませんが、インストーラー**パッケージ**なら成立します（`installd` が `.pkg` をインストールするのは「起動」ではない）。いまエージェントは更新をダウンロードし、埋め込みEd25519鍵で署名されたマニフェストを（JSON解析の**前に**）検証し、パッケージのTeam IDを実行中ビルドと（サンドボックスで失敗する `spctl` ではなく）プロセス内で照合し、黙って入れ替えず検証済みパッケージで止まります。Hub側では2.0.3がリリースと署名を1コマンド（`npm run release:publish`）にしました: dirtyなツリーでは起動を拒み、改ざん3ケースの失敗を証明し、鍵fingerprintをDNSアンカーとregistryの双方に照合し、**draft**へアップロードし、資産を*リリースページからダウンロードした形*で検証し、そうして初めて公開します — 2.0.0–2.0.2が署名資産なしで公開されていた（署名が別工程で誰かの記憶頼みだった）ことが判明した後の対応です。

**Coverageはコマンドが出力する単一スコープで報告します。** `npm run test:coverage` は計装されたサーバサイドツリー全体で**line 84.59%、branch 80.11%、function 81.96%**を出力し、CI gate（83/79/80）に対する差はわずかです。そしてこれが実際の値です: 前回レポートは 92.40/88.45/89.55 と記載していましたが、本レビューで同じコマンドを実行しても再現できませんでした。ここに載せるのはgateが強制する値であり、gateとの差は「祝う」より「注視する」べき幅です。permission matrixは**122件**（HTTP route 111 + MCP tool 11）で、`agent` アクセス種別は**6ルート**、macOSとWindowsのエージェントがプラットフォームごとに複製せず共有します。

| 評価軸 | 結果 | 判定 |
|---|---:|---|
| OWASP ASVS Level 1 | 14領域中14領域が適合または緩和済み | 完全適合 |
| OpenSSF Scorecard | 推定約9.6/10 | Signed-Releases充足、継続fuzzing追加 |
| ISO/IEC 25010 | 平均9.1/10 | 高品質 |
| Node.js Best Practices | 47/50 | 優秀 |
| Macアプリ品質（Appleプラットフォーム） | 推定9.2/10 | 良好なプラットフォーム市民 |
| Windowsアプリ品質（Microsoftプラットフォーム） | 推定8.3/10 | サービス設計は健全、配布チェーンが未完 |
| SonarQube相当gate | 合格、coverageはA | High以上のblockerなし |

## レビュー結果

### 前回レポート（`8caee36`基準）以降の変更

100件を優に超えるPR（#214以降）がマージされました。作業はほぼすべてクライアントエージェントで、いくつかのテーマに整理できます:

| テーマ | 内容 | Roadmap |
|---|---|---|
| 見られるMacアプリとしてのmacOSエージェント | 大圏弧のglobe、Sankey、timelineを共有期間で表示。ソート/フィルタ可能な接続ログ。CSVエクスポート。国別カバレッジ。「実際に見ていた割合」 | P3-15/16/18 |
| macOSローカル脅威インテリジェンス | 指標セット全体を登録済みエージェントへ渡しローカル照合（アドレスがMacから出ない）。公開フィードのopt-in直接ダウンロード、3条件フォールバック、Hub同等のconfidence採点、フィードの応答/未応答表示 | P3-30/P3-19/P3-53/P3-54 |
| macOS署名インストーラー + アプリ内更新 | 署名付きリリース公開、検証済みパッケージで止まるスケジュール更新、`.pkg` でのサンドボックス自己更新解決、relaunch失敗時のインストールログ | P3-24/P3-31 |
| macOS宛先の命名 | アプリが要求した名前（macOS提供 + opt-inのTLS ClientHello SNI）をローカルのみで。QUICはデコードせず可否を数える | P3-14/P3-29/P3-33 |
| macOS信頼性・コスト・privacy manifest | 「記録停止」の検知・告知、keychain処理のメインスレッド外移動、App Nap、cooldownと日次上限付きの通知種別、アプリ/拡張の `PrivacyInfo.xcprivacy`（リポジトリテストで強制） | P3-23 |
| Windowsエージェント: sliceからアプリへ | `LocalService` サービスでのETW収集、DB障害でfail-closedする永続化、ACL付き名前付きパイプIPC、チャート/render check/render-cost budgetを備えたWPF tray UI、Credential Manager保管、**per-machine WiX MSI**（プラットフォーム障害復旧とdev→MSI移行付き）、Mac文言とのテストによる共通語彙固定。C#は約2,568行から**14,447行**へ | P3-2 |
| Hub: リリース・脅威フィード・整備 | リリースと署名を1つの行為に（draft→検証）、オフラインバンドルがLinuxで展開可能に（拡張属性修正）、脅威指標の再起動越え永続化、起動時整合性報告、肥大2モジュールの分割 | P2-88/P2-96/P2-97, 2.0.3 |
| ダウンロードサイト・ドキュメント | `dl.egressview.com` の玄関口、`docs/agent-privacy.md`、roadmap/README更新 | — |

### 主な改善点

- **邪魔をせずに見張るMacエンドポイント。** 観測は**pass-only**で動く `NEFilterDataProvider` です。すべてのフロー判定はreporting付き `.allow()` で、フローが閉じるときにバイト総量が届くだけで、トラフィックを保持・ブロックしません。プロセス帰属（pid→名前）は `libbsm` を薄くブリッジしたCで解決します。接続の中身で読み取りを頼める唯一のものは冒頭のTLS ClientHelloで、運用者がopt-inしたときだけ。parserは完全に境界検査され、妥当でないホスト名を拒否し、読み取りを4KBで打ち切ります。この拡張はopt-inを起動時に一度ではなく**フロー単位**で読みます。
- **Macから出ない問い、そして機械が読める約束。** エージェントの脅威照合はHubと完全に同じ3段の順序、いまや同じconfidence採点も辿り、ダウンロードした指標セットに対しローカルで実行します。画面はHub / キャッシュ / 公開フィードのどれが応答したかを名指しします。`PrivacyInfo.xcprivacy` はトラッキングなし・トラッキングドメインなし・収集データ一覧は空を宣言し、プライバシー関連APIを宣言なしに使うとビルドを失敗させるリポジトリテストがコードとの乖離を防ぎます。
- **自己更新できるサンドボックスアプリと、署名を忘れられないリリース。** アプリ内更新は出荷し、実機で4回連続で壊れ（いずれもテスト通過）、動くまで直しました。解決策 — `installd` は起動できないものをインストールできるため公証済み `.pkg` を配る — は理由とともにコードに記録されています。更新整合性は多層です: DNSアンカー付きfingerprintの埋め込みEd25519鍵、JSON解析前の署名検証、ダウングレード拒否、size + SHA-256、独立したTeam-ID照合。Hubでは `release:publish` がリリースと署名を統合し、資産を*ダウンロードした形*で検証し、失敗時はdraftを残します — 署名なしリリースを3回出してしまった隙を塞ぐものです。
- **静かになったら白状し、再起動できなければ痕跡を残すエージェント。** あるMacはヘルスチェックが約800回「healthy」と報告する間、13.5時間何も記録しませんでした。いまはmacOSが「正常」と言うのに何も届かない状態を検知し、起きていた時間だけを数え、状態をメニューバーに明記し、通知します — 監視アラートは**通知の日次上限から除外**されます。更新のrelaunchが失敗すると、インストーラーは `/var/log/egressview-agent-install.log` に2回の時間差チェックを書き、「一度も起動していない」と「起動して即死した」を区別できます。
- **Windowsに実在する境界を守るWindowsエージェント。** 新しい面を開くのではなくHubの既存 `agent` enrollment/ingest境界を再利用し、クライアント側では急ぎの移植が取り違えがちな選択を正しく取っています: サービスは `LocalSystem` ではなく **`NT AUTHORITY\LocalService`** でインストール。名前付きパイプは **Network SIDを明示的にDeny**してから `LocalSystem` と特定SID1つだけを許可します（既定のままのパイプはSMB経由で到達可能なため）。Hubのbearerはサービスが書くファイルではなく **Credential Manager** へ。MSIは `perMachine` で実体ある `ServiceInstall`、Windows自身の障害復旧、そして手で入れたサービスを影として残さず除去する移行を持ちます。CIには独自の6チェックがあり、チャートの**render-cost budget**まで含みます。未完なのは配布チェーンです — §7を参照。
- **非公開アドレスが、どちらのエージェントからも出なくなりました。** macOSエージェントの第三者位置情報照会がローカルネットワークを問い合わせていました: あるMacでインストール数分後に実測して、**その日の500件のうち400件**がルーター・プライベートサブネット・link-local・multicastに費やされていました。Hubは最初の地理照会の時点からこれらを拒否していたので、エージェントも同じIANAレンジ表を使い、そうしたアドレスを待ち行列に入れず誰にも（Hubにも）尋ねず、既に並んでいた分を掃除し、引けなかった照会を1週間記憶して毎回の再送をやめます。

### 残余リスク

- **中・Windows MSIが未署名**: CIの手順名は文字どおり「Build unsigned Windows MSI」で、Authenticode署名・タイムスタンプ・署名検証がなく、Windows向けの更新マニフェストもありません。したがってWindowsの利用者はSmartScreen警告を受け、出所を検証する手段がありません — Macの利用者が公証・staple済みパッケージを得るのとは対照的です。本レポートで唯一Lowを超える評価の項目であり、次に着手すべき最も明確な作業です（§7）。
- **低・Windowsのテスト厳格さが他に届いていない**: ソース14,447行に対しテスト2,906行で、テストフレームワークではなく約450アサーションの素の `Program.cs` が実行します — テストごとの分離がなく、失敗一覧も出ず、最初の失敗で実行が終わります。
- **低・プラットフォーム専用の検証**: Windowsのビルド・MSI・署名は `windows-latest` でのみ実行されるため、§7は実行ではなくソースとCIから評価しています。macOSエージェントのSwiftテスト群は本レビューのためmacOS上で**実行しました**（730件）。
- **低・App Store非経由の配布**: macOSエージェントはDeveloper ID署名・公証されたDMG/PKGとして出荷し `dl.egressview.com` から自己更新するため、ストアの仕組みを継承せず独自の更新整合性チェーンを持ちます。
- **低・運用**: hardware/external service依存のintegration testはdefault CI workflowに含まれません。
- **低・信頼性の監督**: Hubのevent-loop watchdogは固まったプロセスを強制終了しますが、復帰は外部service managerに依存します。正式なservice unitはまだありません。
- **低・ecosystem**: OpenAPI契約はなく、正式な本番向けOCI imageもありません。
- **低・保守性**: 今サイクルで2モジュールが1,000行を超えました。`src/db-migrate.js`（1,202行、migration v1--v24）と `public/js/log.js`（1,050行）で、`src/devices.js`（891行）も34%伸びています。
- **低・supply chain**: `npm audit`はbetter-sqlite3のamalgamation内SQLite CVEを検出できません。盲点は手動検証手順と共に文書化済み。install scriptは無効のまま。

---

## 実測結果

| 検査 | 結果 |
|---|---|
| Hub unit test | **2,654件成功、失敗0**（576 suite）。本レビューで実行 |
| macOSエージェントテスト | **730件成功、失敗0**（skip 2）。本レビューのためmacOS上で `swift test` を実行 |
| Windowsエージェントテスト | 単一のコンソールランナーに約450アサーション。`windows-latest` のCIでのみ実行。永続化、上限付きドロップ、プライバシー安全な診断、Mac文言との共通語彙を検証 |
| V8 coverage（`npm run test:coverage`、計装されたサーバサイドツリー） | **line 84.59%、branch 80.11%、function 81.96%** |
| CI coverage下限 | line 83%、branch 79%、function 80% — 合格（差は 1.6 / 1.1 / 2.0 ポイント） |
| Parser fuzz test | **32件成功、失敗0**（短campaign。加えて6時間ごとに20分の継続campaignが走り、発見入力をcorpusにcommit） |
| Playwright browser smoke | CI gate合格 |
| ESLint + Frontend HTML挿入監査 | 合格。`innerHTML` / `insertAdjacentHTML` 0件 |
| Production依存監査 | **脆弱性0件** |
| Secret scan | 高確度secret・環境固有LAN IPなし。追跡DB・追跡symlinkの検査も合格 |
| ASH（Automated Security Helper） | **actionable finding 0件**（suppressed 134） |
| GitHub Actions SHA pinning | **39/39**をfull commit SHAへpinned、0 unpinned |
| macOSエージェントCI | `macos-agent.yml`（macOS）: `swift test`、app + System Extension の無署名 `xcodebuild`、System Extension identity gate |
| WindowsエージェントCI | `windows-latest`: solutionの `dotnet build`、**無署名MSIビルド**、全スクリプトのPowerShell構文検査、コアテストランナー、チャートのrender check、**render-cost budget** |
| リリース検証 | `release-gate.yml` が公開時・編集時・週次で公開リリースを検査。`release:publish` は資産をダウンロードした形で検証し失敗時はdraftを残す。macOSエージェントリリースはDeveloper ID署名・公証・staple済み |

### コードベースメトリクス

| メトリクス | 値 |
|---|---:|
| Hub source行数（server、mcp、src、public/js） | 39,497（37,617） |
| Hub test行数（unit、integration、smoke、fuzz、portability） | 44,116（40,587） |
| macOSエージェント source行数（Swift、`Sources` + `Xcode`） | 25,587（19,243） |
| macOSエージェント test行数 / file | 12,379 / 80（8,645 / 53） |
| **Windowsエージェント source行数（C#）** | **14,447行 / 72ファイル**（約2,568） |
| **Windowsエージェント test行数（C#）** | **2,906** |
| Windowsエージェント XAML / PowerShell行数 | 572 / 375 |
| Windowsエージェント プロジェクト数 | 3（`Core`、`Service`、`Ui`）+ render tool 2 + テスト1 |
| Unit test file（Hub） | 218（193） |
| `src/` module | 134（132） |
| HTTP route（permission matrix） | 111 |
| MCP tool | 11 |
| Permission matrix entries | 122 |
| ルートのaccess内訳 | permission 94、authenticated 1、agent 6、public 10 |
| Agent認証ルート | ingest、token rotation、registration revoke、capabilities、geo-cache、threat-intel |
| 定義済みpermission | 8 |
| ロール | 3（viewer、operator、admin） |
| Production依存package | 13 |
| `docs/`配下のドキュメント | 53（42） |
| DB schemaバージョン | **24**（19） |
| CI workflow | 7（ci、pages、macos-agent、dl-deploy、site-deploy、release-gate、fuzz-continuous） |
| `eval` / `new Function` ・ `innerHTML` / `insertAdjacentHTML` | 0 ・ 0 |
| CI Node.jsバージョン | 22、24、26 |
| macOSエージェントバージョン | **0.5.81**、最小 macOS 13 |

括弧内は前回レポートの値です（変化があった項目のみ）。

---

## 1. OWASP ASVS Level 1

**判定: 完全適合（14領域中14領域が適合または緩和済み）。**

| 領域 | 状況 | 根拠 |
|---|---|---|
| 認証 | 合格 | scrypt（versioned KDF migration）、timing-safe比較、256bit session token、失敗遅延、IP単位lockout、Google OIDC + PKCE。エージェントのbearer secretはpepper付きHMAC-SHA256。macOS keychainは `AfterFirstUnlockThisDeviceOnly` |
| Session管理 | 合格 | token hash保存、sliding expiry、revoke、password変更処理、定期prune、ロール付きsession |
| Access control | 合格 | HTTP route 111件のうち94件がpermission gate、1件がauthenticated、6件がagent認証、公開は10件。deny-by-default境界はWebSocket handshakeにも同一適用。matrix 122件。エージェントenrollmentは管理者承認が必要で、両クライアントがこの単一境界を再利用 |
| 入力検証 | 合格 | JSON 64KB、strict Zod、未知key拒否、文字列・範囲上限、SSRF guard。エージェント観測はZodとSQLite CHECK制約で二重検証。macOSのTLS ClientHello parserは長さをすべて境界検査し4KBで打ち切る |
| 暗号 | 合格 | `randomBytes`/UUID、session/TOFU/principalHashのSHA-256、エージェント資格情報のHMAC-SHA256、timing-safe equality、MCPのRS256 JWT、Hubリリース署名のKMS Ed25519、エージェント更新マニフェストの埋め込みEd25519鍵 |
| Error処理 | 合格 | 汎用500、stack非公開、request ID付きserver log |
| Data保護 | 合格 | config/backup/TLS keyは0600、公開config/logからsecret除外、資格情報はhash-only保存、脅威問い合わせはデバイス外へ出さない、宣言され・テストで強制される空のprivacy manifest |
| 通信 | 合格 | HTTPS/HSTS対応、OIDC callbackのsecure redirect強制、MCP OAuthのHTTPS JWKS、エージェント更新チェックはephemeral・cookie-less・デバイス識別子なし |
| 悪意コード | 合格 | evalなし、frontend HTML挿入監査をCIで強制 |
| File処理 | 合格 | upload上限、backup名検証、traversal防止、restore/migration fail-closed |
| API security | 合格 | method別route、strict schema、response size/time上限、認証付きexport、MCP rate limiting、冪等なエージェントingest、読み取りエンドポイントは `ETag`/`304` |
| Configuration | 合格 | hard-coded credentialなし、example設定、secret scan、production demo拒否、リリースビルドはビルド時に禁止entitlementを拒否 |
| Business logic | 合格 | HttpOnly cookie + CSRF保護、explicit permission token、試行制限付き管理者承認enrollment、deny-by-default enforcement |
| 監査・ログ | 合格 | append-only audit_events（pseudonymous actorHash/principalHash）、24時間scheduleで180日retention、MCP専用audit store |

---

## 2. OpenSSF Scorecard（推定）

**推定スコア: 9.6/10。**

| Check | Score | 根拠 |
|---|---:|---|
| Pinned dependencies | 10 | 全38 GitHub Actions参照をfull commit SHAへ固定 |
| Token permissions | 10 | 既定read-only。deploy workflowだけ必要権限を追加 |
| Dangerous workflow | 10 | `pull_request_target`なし |
| Binary artifacts | 10 | commit済みbinaryなし |
| Security policy | 10 | `SECURITY.md`とprivate vulnerability reporting |
| License | 10 | AGPL-3.0-only |
| SAST | 10 | ASH、secret scan、ESLint、frontend挿入監査、npm audit |
| Vulnerabilities | 10 | production `npm audit`をCI実行。本レビュー0件 |
| Dependency updates | 10 | npm/Actionsのweekly Dependabot（7日cooldown）を、npmの `min-release-age` インストール時下限で補完 |
| CI tests | 10 | PRでunit/coverage、parser fuzz、browser smoke。Node 22/24/26 matrix。System Extension identity gate付きのmacOSエージェント専用workflow |
| Maintained | 10 | 現在のmainまで継続的にrelease・改善 |
| Code review | 8 | PRと必須checkを運用。RBACとpermission matrixがreview基準を強化 |
| Fuzzing | 7 | parser fuzzingをPRごと、および `fuzz-continuous.yml` で6時間ごとの20分campaignとして実行し、発見入力を `test/fuzz/corpus/` に永続化。意図的にOSS-Fuzzではない（coverage誘導なし）ため残点が生じる |
| Signed releases | 9 | Hubリリースはdetached signature資産付きで、リリースと署名を統合したコマンドを通じて公開され、資産をダウンロードした形で検証し、publish/edit/週次で再検査される。macOSエージェントリリースはDeveloper ID署名・公証済み。残り1点はSLSA provenance |

推定が約9.4から上がったのは、主に継続fuzzingが走るようになったことと、署名なしリリースの発覚後にリリースと署名を統合したためです。

---

## 3. ISO/IEC 25010

| 品質特性 | Score | 強み | 残るgap |
|---|---:|---|---|
| 機能適合性 | 9 | 複数router収集、独自の可視化を持つ成熟したmacOSエンドポイントエージェント、萌芽的なWindowsエージェント、エージェント/ルーター相関、ローカル脅威照合、AI洞察、export、MCP + OAuth | OpenAPIなし |
| 性能効率性 | 9 | WAL、batch、bounded summary、cache、worker分離backup、MCP concurrency cap、indexされたagent-scope参照。エージェントは時間集約からチャートを提供しApp Napで安価に常駐 | 重いbackup検証中はhost-levelの短い遅延が残り得る |
| 互換性 | 9 | Node 22/24/26、JA/EN、Yamaha/Cisco/ASUS/conntrack、macOS 13+エージェントと萌芽的Windowsエージェント、Cognito compatibility profile、subpath proxy配下の正常動作。オフラインバンドルがLinuxで展開可能に | CIのhardware確認はfixture中心 |
| 使用性 | 9 | Responsive UI、setup guide、自動検出、health診断、検知別通知スイッチ、共有収集ソース選択、自己クリアする「記録停止」警報と読み取れる脅威ソース表示を持つインストール可能なメニューバーmacOSエージェント、read-only公開デモ | router側設定が依然として実際のオンボーディングコスト |
| 信頼性 | 9 | migration/restore/config/notes fail-closed、health、cancel、request ID、rate limiting、scheduled audit retention、event-loop watchdog。macOSエージェントは黙った停止を検知・告知しrelaunch失敗を記録。WindowsエージェントはDBエラーでfail-closed | Hub watchdogの復帰は外部service managerに依存 |
| Security | 10 | OIDC/PKCE、RBAC、プラットフォーム間で共有される独立agent種別を含むdeny-by-default permission、CSRF、HttpOnly cookie、hash-only資格情報、管理者承認enrollment、MCP OAuth/JWKS、audit trail、rate limit、SSRF guard、統合された署名リリース工程、独立検証されるエージェント更新チェーン、エージェントのApp Sandbox + hardened runtime、オンデバイス脅威照合 | -- |
| 保守性 | 9 | 132 Hub moduleと綺麗に分割されたSwiftエージェント（Core / Network Extension / host app）、双方の強いtest、permission matrix、parser fuzz、native-dep盲点文書化。今サイクルで肥大2モジュールを分割 | `db-migrate.js`と`log.js`が大きいまま |
| 移植性 | 9 | Cloud非依存profile、Linuxで展開可能になったKMS署名portable source、起動前feature policyのoffline mode、version管理rollback、Node 22/24/26 CI。エージェントはtile serviceを呼ばず地図の輪郭を同梱 | 正式な本番OCI image/systemd unitなし |

**平均: 9.1/10。**

---

## 4. Node.js Best Practices

**準拠率: 47/50（94%）。**

- Domain、route、poller adapter、エージェントのingest/相関/threat-intel module、DB bootstrap、auth middleware、browser renderingの責務を分離。今サイクルで読みづらいほど育った2ファイルを分割しました。
- 外部async処理にtimeout/AbortSignal上限。backup pruneはworkerとsingle-flight jobで隔離、ASUSポーリングはoverlapping cycleをcoalesce、MCP requestはconcurrency cap。
- 同期的DB呼び出しはプロセス全体をブロックし得るため、worker thread上のevent-loop watchdogが固まったプロセスを強制再起動し、きっかけの病的クエリはindexレベルで修正済み。
- Loggerは`AsyncLocalStorage`で安全な`X-Request-Id`を付け、query stringは記録しません。
- Graceful shutdown、readiness、schema migration、config rollback、永続化失敗、permission enforcementをtest。起動時チェックがDBの欠落を報告します。
- ESLint、V8 coverage、Node 22/24/26、Playwright、parser fuzz（PRごと + 6時間ごとの継続）、ASH、secret scan、dependency auditをgateにし、macOSエージェントはSystem Extension identity gate付きの専用workflowを持ちます。
- 信頼できない入力を多層で検証: エージェント観測は入口でZod、保存時にSQLite CHECK制約。脅威エンドポイントは「照合対象の宛先を受け取る」のではなく「データを渡す」設計。
- SSRF保護はoutbound endpointを名前解決し、link-local/metadata/multicast/broadcastを拒否し、検査済みIPへ接続を固定してDNS rebindingを防ぎます。
- リリース整合性はKMS管理鍵をリポジトリ外のDNS TXTレコードにアンカー。リリースと署名は資産をダウンロード形で検証する1コマンドに統合。
- 依存のinstall scriptを無効化。native依存のaudit盲点は手動検証手順と共に文書化。

Default hardware integration CI、正式process manager/OCI成果物、OpenAPIがないため満点とはしません。

---

## 5. SonarQube相当Quality Gate

| Metric | 結果 | Rating |
|---|---:|---|
| Reliability | Critical/Highの既知不具合なし。エージェントの「黙って停止」障害は検知・告知され、relaunch失敗は痕跡を残す | A |
| Security | 高確度secret・dependency findingなし。独立agent種別を含む完全なRBAC、監査、SSRF保護、KMS Hub署名、統合された署名リリース工程、独立検証されるエージェント更新チェーン | A |
| Maintainability | 今サイクルの成長はクライアントエージェント。肥大した2つのHubモジュールを分割 | A |
| Coverage | line 84.59% / branch 80.11% / function 81.96%（CI gateが検査するスコープ） | A |
| Duplication | 手動・静的reviewで重大な新規重複なし | A（推定） |

**Quality gate: 合格。**

### 主な保守性hotspot（Hub）

| File | 行数 | 評価 |
|---|---:|---|
| `src/db-migrate.js` | 1,202（885） | schema migration v1--v24 |
| `public/js/log.js` | 1,050（824） | pagination、filter、renderが同居 |
| `src/devices.js` | 891（665） | device identity、persistence、merge lifecycle |
| `server.js` | 842（823） | bootstrapとdependency wiring |
| `src/history.js` | 803（773） | `history-queries.js` 抽出後のstore orchestration |
| `src/routes/agents.js` | 731（707） | エージェントのenrollment、承認、ingest、capabilities、geo-cache、threat-intelルート |
| `public/js/graph.js` | 679 | 抽出済みhelper/panel/rendererのorchestration |
| `src/pollers/cisco.js` | 661 | parser/handshake抽出後のstateful SSH lifecycle |
| `src/mcp-publication-gate.js` | 639 | 公開判断、client release timing、diagnostics |
| `src/pollers/yamaha.js` | 627 | adapter parser周辺のstateful SSH lifecycle |
| `src/history-queries.js` | 612 | `history.js` から分離したクエリ層 |

今サイクルで2モジュールが1,000行を超えました。`db-migrate.js` は設計上伸びるもの（append-onlyのmigrationが5本追加）ですが、`log.js` は分割されないまま27%、`devices.js` は34%伸びています。どちらも手に負えない域ではありませんが、この一覧に再び手を入れるなら明白な候補です。

---

## 6. Macアプリ品質（Appleプラットフォーム）

本節はmacOSエージェントを**Macアプリとして**、Appleが「App Store非経由で配布されるMacアプリ」に課す期待に照らして評価します: サンドボックスとhardened runtime、entitlementの最小化、Developer ID署名と公証、Network/System Extensionの正しくプライバシーに配慮した利用、信頼できるソフトウェア更新チェーン、privacy-by-designと宣言されたprivacy manifest、Human Interface Guidelinesとアクセシビリティ、reliability/observability、テスト容易性です。スコアはリポジトリ内容からの推定で、macOS専用ビルドと署名パイプラインはソースとCIから検証し、実行はしていません。

**推定スコア: 9.2/10。**

| 評価軸 | Score | 根拠 | Gap |
|---|---:|---|---|
| App Sandbox & hardened runtime | 10 | メニューバーhost appとcontent-filter extensionの双方が `app-sandbox = true` を宣言。リリースビルドは `--options runtime` で署名。共有app group（`group.com.egressview.agent`）が唯一のIPC面 | -- |
| Entitlementの最小化 | 9 | hostは `network.client`、`system-extension.install`、（CSV用の）`files.user-selected.read-write`、content-filter NE keyのみ。リリースビルドは禁止entitlement（`network.server`、`temporary-exception.*`、top-levelのMach service名）をビルド時とZIP往復後に**拒否** | エクスポートにuser-selected-fileは不可避 |
| 署名 & 公証 | 10 | `build-release.sh` はarchive、**内側から署名し直し**、最終entitlementを検証、`notarytool --wait`、staple、`spctl --assess`、ZIP往復後のバイト再検証。Hub側のリリースと署名は統合され、署名なしで出荷できず、publish/edit/週次で再検査 | macOS専用。本レビューでは未実行 |
| Network/System Extension | 10 | **pass-only** の `NEFilterDataProvider`: すべての判定はreporting付き `.allow()`。opt-inはフロー単位で読み、statisticsレポートは曖昧なため無視。CI identity gateがbundle id・`NEMachServiceName`・`startSystemExtensionMode()`・プロセス内コード有効性を検証 | -- |
| ソフトウェア更新の整合性 | 9 | DNSアンカー付きfingerprintの埋め込みEd25519鍵。マニフェスト署名はJSON解析の*前*に検証。厳密により新しいバージョンのみ。size + SHA-256検査。`SecStaticCodeCheckValidity` によるTeam-ID照合。coordinatorは検証済みパッケージで止まる。サンドボックスアプリが起動できないものを `installd` はインストールできるため `.pkg` で配布。relaunch失敗はログ化 | Mac App Store非経由のため独自チェーン |
| Privacy by design & privacy manifest | 10 | 復号せず既定では接続の中身を読まない。opt-inのSNIは4KBで打ち切りオンデバイス保持。QUICはデコードせず数える。脅威照合はローカル。更新チェックはデバイス識別子を送らない。0.5.29からアプリと拡張の双方が `PrivacyInfo.xcprivacy`（トラッキングなし・収集データ空）を同梱し、リポジトリテストと接触ホストを列挙した公開の `docs/agent-privacy.md` で裏打ち | -- |
| HIG & アクセシビリティ | 8 | `LSUIElement` メニューバーアプリ。色ではなく**形**で区別するtemplateアイコン、完全な文言を最初のメニュー行に置きVoiceOverラベルにも設定、ローカライズ（en/ja）、アイコン欠落時のテキストfallback | メニューバー専用面は本質的に簡素。より深いアクセシビリティ監査は今後 |
| Reliability & observability | 9 | 黙った「記録停止」を検知・告知（起きていた時間のみ）、予行用の自己クリアスイッチ、cooldownと日次上限を持つ通知種別（監視アラートは除外）、App Nap、keychain読み取りのメインスレッド外移動、relaunch失敗を診断する時間差インストールログ | 完全な挙動検証はmacOS専用 |
| テスト容易性 | 9 | 更新チェーン、パッケージ同一性、資格情報/enrollment、脅威照合とconfidence、フローマッピング、TLS/QUIC分類、storage/migration、charts/coverage、通知、launch-at-loginを覆う**80のSwift test file（12,379行）、本レビューで730件を実行**、CIのSystem Extension identity gate | 署名/公証の手順とオンデバイス挙動はunit testできない |

**際立つ点。** エージェントは注意深いプラットフォーム市民です: サンドボックスが許す最小限だけを行い、ネットワークから読むのを最小限にし、利便性をリスクに変えることを拒み、いまやその抑制をビルドテストが誠実に保つ機械可読マニフェストで宣言します。署名の筋は、署名なしリリースが漏れた後にHubがリリースと署名を1つの自己検証する行為へ統合したことで、さらに引き締まりました。

**さらに進める余地。** App Store配布（ストアの更新・プライバシーの足場を継承できる）は今日では意図的な非目標です。メニューバー面を超えたより深いアクセシビリティ・ローカライズ監査は今後の課題であり、macOSパイプライン全体はmacOSでしか実行できないため、Linux環境で走らせられない部分は本レビューがCI証跡に依拠しています。

---

## 7. Windowsアプリ品質（Microsoftプラットフォーム）

本節はWindowsエージェントを*Windowsアプリとして*評価します。サービスをインストールする配布型デスクトップエージェントにプラットフォームが期待すること — 最小権限のサービスID、守られたIPC境界、正しい資格情報保管、綺麗に入って綺麗に消えるper-machine MSI、Authenticode署名と信頼できる更新チェーン、privacy by design、WindowsのUX・アクセシビリティ慣習、サービス監督下での信頼性、テスト容易性 — を軸にします。

これは§6の再採点ではなく、意図的に**別の**フレームワークです。2つのプラットフォームが守る境界は違います: Macエージェントの難所はサンドボックス・entitlement・公証であり、Windowsエージェントの難所は独自アカウントで動くサービス、他のローカルユーザーに到達させてはならない名前付きパイプ、そして配布チェーンそのものであるインストーラーです。WindowsをAppleのチェックリスト（あるいは「サンドボックスがあるか」）で測れば、間違ったものを採点し、実際に正しくできている点を見落とします。

**推定スコア: 8.3/10。** Macエージェントより低く、理由はほぼ1つです: コードは健全ですが、配布チェーンが完成していません。

| 評価軸 | Score | 根拠 | Gap |
|---|---:|---|---|
| サービスIDと最小権限 | 10 | サービスは `LocalSystem` ではなく **`NT AUTHORITY\LocalService`** でインストールされます。組み込みアカウントのうち弱い側で、マシン全体の権限を持たずネットワーク資格情報はnullです。収集に管理者は要らないので、要求しません | -- |
| IPC境界 | 10 | 名前付きパイプを既定のままにせずACLを与えます。`BuildSecurity` は **Network SIDを明示的にDeny**（パイプは拒否しない限りSMB経由で到達可能）し、`LocalSystem` を許可し、明示的に渡された1つのSIDにのみread/write/synchronizeを与えます。多くの実装が省略するのはこのDenyです | -- |
| 資格情報保管 | 9 | Hubのbearerは **Windows Credential Manager** に `CRED_PERSIST_LOCAL_MACHINE` で保管します。サービスが書くファイルでもなく、レジストリの平文でもありません | 同じ関心事の実装が2つ（UIとCore）あり、まとめるべき縫い目 |
| インストーラーの正しさ | 9 | WiX、**`Scope="perMachine"`**、`Start="auto"` / `ErrorControl="normal"` の明示的な `ServiceInstall`、インストールで開始しインストールとアンインストールの双方で停止する `ServiceControl`、データディレクトリを `LocalService` にのみ与える `util:PermissionEx`、そして手で入れたサービスを影として残さず除去する **dev→MSI移行スクリプト**。CIは全PRでMSIをビルドするため、壊れたインストーラーはマージ前に落ちます | CIでは無署名ビルド |
| サービス回復性 | 9 | `util:ServiceConfig` がWindows自身の障害復旧（60秒待って再起動）を設定するため、監督は自前watchdogではなくプラットフォームの仕事です。devスクリプトも同じ3段復旧と失敗フラグを設定します | 復旧挙動はマニフェストからの確認で、実走では未検証 |
| Authenticodeと更新チェーン | **5** | MSIは**無署名でビルド**されます。CIの手順名は「Build unsigned Windows MSI」で、署名・タイムスタンプ・`Get-AuthenticodeSignature` 検証がありません。Windows向け更新マニフェストも未公開で、macOSエージェントの署名済みマニフェストチェーンに対応するものがWindowsにはまだありません | **本節最大のギャップ。** 無署名MSIを実行する利用者はSmartScreen警告を受け、出所を検証する手段がありません — Macビルドが与える保証の正反対です |
| Privacy by design | 10 | Macエージェントと同じ抑制、Hub側も同じ境界です: パケット内容は決して収集せず、診断は**テストでプライバシー安全を保証**し、Hubの `agent` アクセス種別を再利用して第二の面を開きません。非公開アドレスは位置情報サービスへ送りません（0.5.70でプラットフォーム横断に修正） | -- |
| WindowsのUXとアクセシビリティ | 8 | Fluentテーマを持つWPF trayアプリ、en/jaローカライズ、そしてMac英語文言に対し**テストで固定された共通語彙** — 読者が目にする用語で両製品が乖離できません。CIではrender checkと**render-cost budget**が走り、デスクトップのチャートとしては異例の厳格さです | UI Automation / スクリーンリーダーの自動検証がなく、ハイコントラストとDPI挙動は本レビューで未確認 |
| テスト容易性 | 7 | ソース14,447行に対しテスト2,906行で、永続化、上限付きドロップ、プライバシー安全な診断、クロスプラットフォーム語彙を覆います。ランナーはテストフレームワークではなく**約450アサーションの素の `Program.cs`** で、テストごとの分離も報告もなく、1件の失敗で実行が終わります | フレームワーク（xUnit/NUnit）なら分離と失敗一覧が得られます。比率はHubおよびMacエージェントを大きく下回ります |

**際立つ点。** セキュリティに関わる選択は、急いだWindows移植が取り違えがちなところで、ここは正しく取っています: `LocalSystem` ではなく `LocalService`、パイプへのNetwork SID明示Deny、設定ファイルではなくCredential Manager、実体ある `ServiceInstall` とプラットフォーム障害復旧を伴う `perMachine`、そして以前手で入れたサービスを片付ける移行。共通語彙テストは本当に良い着想です — 「2つのエージェントが同じことを言う」を翻訳レビューではなくビルド時の性質にしています。

**さらに進める余地。** 重要なギャップは署名です: 無署名MSIはMacの `.pkg` より第一印象が悪く、macOS側が譲れないとしている検証を欠いたまま更新チェーンを残します。次にテストランナーを本物のフレームワークへ、そして2つの `WindowsCredentialVault` 実装を1つに。

---

## 結論

現在のmainは、文書化されたself-hostedデプロイモデルに対して十分な多人数運用向けセキュリティ制御を備えています。macOSエージェントは行儀のよいMacアプリであり、Windowsエージェントはvertical sliceから実体あるアプリへ育ちました — 14,447行、3プロジェクト、per-machine MSI、独自の6つのCIチェック — しかも第二の面を開かずHubの既存 `agent` 境界を再利用しています。自動品質ゲートは広く、データ変更操作はfail-closed、deny-by-defaultのRBACが全面適用され、MCPはOAuth保護・rate limit・監査付きで、Critical/Highの問題は残っていません。

Macのフレームワークを拡張せずWindows用（§7）を追加したことで、レビューが見えるものが変わりました。自分のプラットフォームの基準で採点すると、Windowsエージェントのセキュリティ設計はよく読めます — `LocalSystem` より `LocalService`、名前付きパイプへのNetwork SID明示Deny、設定ファイルよりCredential Manager、プラットフォーム障害復旧を伴う `perMachine` — そして汎用チェックリストなら埋もれていたギャップが1つ際立ちます: **MSIは無署名でビルドされ、Windows向け更新マニフェストが無い**ことです。macOSでは「署名なしでリリースは出せない」を痛い形で学び、1つのコマンドに強制しました。Windows側はその地点に達しておらず、達するまで、Macの利用者が検証可能なパッケージを得るところでWindowsの利用者はSmartScreen警告を受けます。次に直すべき最も価値ある一点です。

前回レポートへの訂正が2つあります。coverageの数値（92.40/88.45/89.55）は、引用されているコマンドを実行しても再現できませんでした。実測値は **84.59/80.11/81.96** で、gateを 1.6/1.1/2.0 ポイント上回ります。また「2,429件中2,417件、残りは環境固有」は、いまや **2,654件中2,654件** です — Hubのテスト群は本環境で完全に通り、macOS側（730件）はCIからの推定ではなく本レビューのためmacOS上で実行しました。

保守性は想定どおりの方向へ動きました — 成長はエージェントにあります。残る改善余地は、Windowsに対するAuthenticode署名と更新マニフェスト、Windowsランナーの本物のテストフレームワーク化、SLSA provenance（Signed-Releasesの残り1点）、リポジトリ内campaignを超えたcoverage誘導fuzzing、OpenAPI契約、正式なOCI/serviceの成果物です。リリースに関わるのは最初の1つだけで、残りは需要駆動の拡張です。据え置きの留保は検証上のもので、Windowsのテスト・MSI・署名は Windows でしか走らないため、§7は実行ではなくソースとCIから評価しています。
