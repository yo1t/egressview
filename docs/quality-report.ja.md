# EgressView コード品質レポート

- **評価日**: 2026-10-12
- **評価基準**: 前回レポートは `95e4ef0`。本サイクルは `fa8b93e6` までを評価（301コミット）
- **バージョン**: Hub 1.11.1 ・ Agent for Mac 0.5.128 ・ Agent for Windows 0.1.155（**一般公開済み**）・ EgressView pack 2.1.1 + `[Unreleased]`
- **Node.js**: >=22（CI: Linuxで 22 / 24 / 26、加えてWindowsで 22）。**macOSエージェント**: Swift 6 toolchain、最小 macOS 13。**Windowsエージェント**: .NET 10（C#）、WPF tray UI、Windowsサービス
- **評価方法**: 自動テスト、V8 coverage、静的解析、依存・secret scan、browser smoke、parser fuzzing、手動コードレビュー。各クライアントは*それぞれのプラットフォーム*の基準で評価します: macOSエージェントはMacアプリ品質フレームワーク（§6）、WindowsエージェントはWindowsアプリ品質フレームワーク（§7）

> SonarQubeとOpenSSFのスコアはリポジトリ内容からの推定で、公式scannerは実行していません。penetration testも対象外です。Windowsのビルド・MSI・サービス挙動は `windows-latest` でのみ動くため、§7は実行ではなくソースとCIの証跡から評価しています。HubのテストとmacOSエージェントのSwiftテストは、いずれも本レビューのためmacOS上で実行しました。

---

## 総合評価

**総合グレード: A**

CriticalまたはHighの不具合は見つかりませんでした。前サイクルが2つのクライアントエージェントを*作る*話だったのに対し、今サイクルは**それらが実機と実データに当たったときに何が起きるか**の話です。定義づける出来事が3つあります。

第一に、**Windowsエージェントが建物から出ました**。もうCIの成果物ではありません。0.1.155は署名付き更新マニフェストと共に `dl.egressview.com` で公開され、3週間で約50版が出荷されました。そして公開とともに、実際のインストールでしか現れない失敗が現れました — それに対するプロジェクトの応答が、本レポートで最も情報量の多い証跡です。いま**取り下げ済みリリースの登録簿**が、二度とインストール・公開してはならない版をすべて記録しています。各項目は後継を名指しします。「移る先のない取り下げは、誰も従えない指示だから」です。そしてMSIビルダー・公開スクリプト・unit testの3箇所が、登録簿にある版を扱うことを拒みます。Windowsの3項目は誠実な事故記録です: 0.1.117はフロー1件ごとに31,647,027件の観測を走査するmigrationを出荷し、25分間1バイトも書かずに回り続けました — これを入れた機械は**記録を止め、二度と再開しません**。0.1.118は1つの版番号が異なる2つのビルドを指してしまい（`msiexec` は何も置き換えないまま0を返しました）破棄されました。0.1.125は自分のサービスに名前付きパイプの `CreateNewInstance` だけを与えたため、4つのIPCリスナーのうち3つが100 msごとに失敗し、置き換えまでに失敗カウンタを**1,947,715回**書き込みました — そしてそのテストはクライアントとサーバに同じSIDを与えていたため、この欠陥を見られませんでした。

第二に、**Hubがリクエストに応答するスレッドでDB処理をするのをやめました**。専用のDBスレッド（`db-worker.js` と、メイン側の `db-worker-host.js`）が自分の接続を持ち、メインスレッドは要求を送ってPromiseを受け取ります。冒頭のコメントは終わらせた障害を名指しします: 遅い1文が「ダッシュボード・エージェントのアップロード・`/healthz` をまとめて凍結させていた」。その隣に14件の `perf(hub)` が並びます — covering index、日次ロールアップ、読み取りのリクエスト経路外への移動、同時に問われる読み取りのキャッシュ共有、脅威フィード解析の専用worker化です。

第三はもっと静かで、最も特徴的です: **Hub自身のチャートを実測したら嘘をついていて、正直にするのに5本の連続したschema migrationを要しました。** v25はtimelineがフローを `lastSeen` でバケットに入れていたことを突き止めました — それは*最後に見た時刻*のヒストグラムで、動き続けているフローはすべて最新バケットに積み上がり、曲線は上昇しかできません。あるHubの6時間ビューは、真値156のところを1,115と読んでいました。v26は、最初の修正が「誰も見ていなかった期間」に埋めたバケットを削除しました。v27は期間を「自分の時刻を記録する半分」と「しない半分」に分けました。v28はエージェント側を時間ロールアップから数えるのをやめました — 時刻で切られた区間を5分窓に広げると、1,069から2,007へ、そして戻る三角波が描かれたためです。v29は期間を数えるコストをその古さから独立させました。遡るほど遅くなるバックフィルが、1分間に46回イベントループを止めていたためです。そしてv31が「ルーターが一度も応答しなかった」に「何も送られなかった」とは別のバーを与えました。両者は逆のことを意味します。

**Coverageは改善し、引き続きコマンドが出力する単一スコープで報告します。** `npm run test:coverage` は**line 87.17%、branch 81.23%、function 83.65%**を出力し、CI gate（83/79/80）に対する差は 4.2 / 2.2 / 3.7 ポイントです（前サイクルは 1.6 / 1.1 / 2.0）。Hubのテストは**3,115件**（3,113件成功、失敗0、skip 2 — macOSでは許されない方法で開いているファイルハンドルを調べるため）、macOSエージェントは**892件**（XCTest 882件のうちskip 3、加えてswift-testing 10件、失敗0）です。

一方で、2つは悪い方向に動きました。公開されたWindows MSIは**いまも無署名**です — 資産名は文字どおり `EgressView-Agent-Windows-0.1.155-x64-unsigned.msi` で、前回レポートの警告（「最初の公開より前に署名すること。でなければ同じ版で署名あり/なしの2種類が世に出る」）は出来事に追い抜かれました。そして**Hubで1,000行を超えるモジュールが5つ**になりました（前サイクルは2つ）。`server.js` は35%伸びて1,135行です。

| 評価軸 | 結果 | 判定 |
|---|---:|---|
| OWASP ASVS Level 1 | 14領域中14領域が適合または緩和済み | 完全適合 |
| OpenSSF Scorecard | 推定約9.6/10 | 変化なし。残る点はOSS-FuzzとSLSAが必要 |
| ISO/IEC 25010 | 平均9.1/10 | 高品質。移植性が上がり保守性が下がった |
| Node.js Best Practices | 48/50 | 優秀 |
| Macアプリ品質（Appleプラットフォーム） | 推定9.2/10 | 良好なプラットフォーム市民 |
| Windowsアプリ品質（Microsoftプラットフォーム） | 推定8.7/10 | 更新チェーンは完成。守る対象の成果物が無署名 |
| SonarQube相当gate | 合格、coverageはA | High以上のblockerなし |

## レビュー結果

### 前回レポート（`95e4ef0`基準）以降の変更

301コミット。領域別では、Windowsエージェントがfix 52件・feature 17件、Hubがfix 52件・性能改善14件、macOSエージェントがfix 30件・リリース22件です。

| テーマ | 内容 | 証跡 |
|---|---|---|
| Windowsエージェントの一般公開 | Ed25519署名付き更新マニフェストと共に0.1.155を `dl.egressview.com` で公開。3週間で約50版。C#は14,447行から**20,052行**へ | `dl.egressview.com/windows/manifest.json` |
| Windowsの更新クライアント | リクエスト前のfingerprint照合、**JSON解析前の**マニフェスト署名検証、schemaとplatformの固定、ダウングレード拒否、公開オリジンへのURL固定、3通りのサイズ検査、SHA-256検査、そしてインストール対象パッケージへの**Authenticode必須** | `WindowsAgentUpdate.cs` |
| 取り下げ済みリリースの登録簿 | 取り下げた版すべてを理由と後継と共に記録。ビルダー・公開スクリプト・testの3者がそれぞれ扱いを拒否 | `release-signing/withdrawn-agent-releases.json` |
| Hub: DBスレッド | 重い文を自分の接続を持つスレッドへ移動。1本の遅いクエリがダッシュボード・エージェントのアップロード・`/healthz` をまとめて凍結させることがなくなった | `db-worker-host.js` |
| Hub: 正直なチャート | 期間を「その時刻を記録している証跡」から数えるためのmigration 5本（v25--v29）、長期ビューを安くする日次ロールアップ（v30）、「ルーターが応答しなかった」を別状態にする（v31） | schema v24 → **v31** |
| Hub: 読み取り経路の性能 | new-nodes一覧のcovering index、フロー単位でのscoped read、同時に問われるAI factsの共有、未照合フローを毎分1回だけ構築、脅威フィード解析のworker化 | `perf(hub)` 14コミット |
| CI: 自分自身を試すgate | `dotnet package list --vulnerable` を解析するNuGet脆弱性監査を、**自前の脆弱fixtureに対して実行し、拒否しなければ失敗**させる。1つの版の2度目のビルドと取り下げ済み版を拒否するgate | `ci.yml` |
| CI: 主張した成果物を実際に動かす | 本番imageをビルドし起動し `/readyz` まで待ち、DBがvolume側にあり image内に無いことを検査。Hub自身のテストをWindows + Node 22で実行。conntrack経路を実在のconntrackテーブルからSSHで収集（パスワードは実行ごとに生成しマスク） | `production-image`、`test-windows`、`conntrack-integration` |

### 主な改善点

- **DBスレッド — watchdogが代役を務めていた本来の修正。** Hubの重い文は自分のスレッドで自分の接続を使って動きます。前回レポートは「固まったプロセスを強制再起動するevent-loop watchdog」と「indexレベルで直した病的クエリ」を記述しましたが、今サイクルは症状ではなく原因に手を入れました。そのスレッドの接続は、他の接続と同じ2箇所で正しく閉じられます — restoreがファイルを置き換える前と、shutdownが正常停止を記録する前（ハンドルが1つでも開いていれば拒否されます）。
- **推測せず「不明」と言うチャート。** timelineは自分のグルーピングの副産物から上昇曲線を描いていました。その訂正はappend-onlyのmigration 5本として記録され、各本が前の試みが生んだ歪みを実際のHubで測った数字つきで文書化しています。最後の段（v31）は「ルーターが一度も応答しなかった期間」を「何も送られなかった期間」と区別します — 「証跡の不在」を「不在の証跡」と読ませない、このプロジェクトの既存の習慣を、自分自身の出力に適用したものです。
- **自分の基準を下げることを拒むWindows更新チェーン。** クライアントはリクエストを出す前に埋め込み鍵を公開fingerprintと照合し、マニフェストのEd25519署名をJSON解析の**前に**検証し、厳密に新しくないものを拒否し、パッケージURLを公開オリジンに固定し、ダウンロードを3通りに制限し、SHA-256を検査し、そして有効なAuthenticode署名と宣言されたpublisherを要求します。壊れたパッケージや無署名パッケージを「自分で取ってきてください」に降格させません — 理由はソースのコメントにあります。それは「マニフェストの欠陥を沈黙に変えてしまう」から。実務上の帰結は後述のリスクにあります。
- **消すのではなく記録する取り下げ機構。** Windowsの3版が取り下げられ、それぞれに実測された理由と名指しされた後継があり、ツールチェーンの3箇所がビルド・公開・受け入れを拒否します。この記録は設計上、都合が悪いものです。都合の良い項目しか載らない登録簿は、荷重を支えません。
- **自分自身の失敗で試されるgate。** WindowsのNuGet監査が存在するのは、`dotnet package list --vulnerable` が脆弱なパッケージを報告しても終了コード0を返すからです。そこでCIはまずクリーンなfixtureに対して監査を走らせ、次に意図的に脆弱なfixtureに対して走らせ、**監査がそれを受け入れたら失敗**します。ビルド拒否のgateも、読むのではなく走らせます。これはリリース工程が改ざん3ケースの失敗を証明していたのと同じ規律です。
- **主張した成果物を実際に動かす。** CIのコメントが率直に述べています: 「テストされていないDockerfileがリポジトリにあるのは、サポートのないまま『サポート済み成果物』を主張することだ」。本番imageはいまビルドされ、起動され、ready報告まで待たれ、DBがマウントされたvolume上にあり image内には1つも無いことを検査されます。Hubのunitテストもwindows上で動きます。そしてconntrack収集経路 — 「ハードウェアを必要としない唯一のハードウェア統合」 — は、特権コンテナ内の実在のconntrackテーブルに対し、実行ごとに生成されマスクされコミットされないパスワードでSSH越しに検証されます。

### 残余リスク

- **中・公開されたWindows MSIが無署名。** これはもうビルド工程の細部ではありません。利用者がダウンロードする資産の名前は `EgressView-Agent-Windows-0.1.155-x64-unsigned.msi` で、CIの手順名はいまも「Build unsigned Windows MSI」、Authenticode署名・タイムスタンプ・検証がありません。帰結は2つです。Windowsの利用者はSmartScreen警告を受け出所を検証する手段がありません（Macの利用者は公証・staple済みパッケージを得ます）。そしてエージェント自身の更新クライアントがインストール対象に有効なAuthenticode署名を**要求する**ため、公開リリースは `install: "manual"` と記されます — つまり署名付きマニフェスト、fingerprint固定、ダウングレード拒否、3通りのサイズ検査はすべて、決して走らない更新経路の上で正しく動いています。**Windowsの自己更新チェーンは完成していて、かつ不活性です。待っているのは1つの署名だけです。** 前回レポートはMSIがCI成果物でしかなかった時点でこれを中と評価し、最初の公開より前に署名を入れるべきだと述べました。公開が先に来ました。
- **中・Windowsのリリース検証が、リリース頻度に追いついていない。** 3週間で約50版、うち3版を取り下げ、1版は「実サイズのDBならエージェントが永久に記録を止める」状態で公開済みでした。追加された緩和策は強力ですが、ほとんどが*事後*のものです。登録簿は記録して後継を示すもので、追加された唯一の予防的gate（1つの版の2度目のビルドを拒否）は0.1.118の記帳の失敗を直すもので、0.1.117や0.1.125の欠陥種を直すものではありません。この2つはどちらも実機にインストールして見つかり、テストでは見つかっていません — しかも0.1.125についてはテストが存在したうえで、クライアントとサーバに同じSIDを与えていたために見えませんでした。
- **低・Windowsのテスト厳格さが、まだ他に届いていない。** ソース20,052行に対しテスト5,214行 — 比率は20%から26%へ改善しましたが、テストフレームワークではなく781アサーションの素の `Program.cs` が実行するため、テストごとの分離がなく、失敗一覧も出ず、最初の失敗で実行が終わります。
- **低・プラットフォーム専用の検証。** Windowsのビルド・MSI・サービス挙動は `windows-latest` でのみ動くため、§7は実行ではなくソースとCIから評価しています。サービスの障害復旧にはコミット済みの計測スクリプト（`measure-dev-recovery.ps1`。サービスを殺して復帰を計ります）がありますが、CIではなく手で走らせるものです。
- **低・保守性が悪い方向に動いている。** Hubで1,000行を超えるモジュールが5つになりました（前サイクルは2つ）: `src/db-migrate.js`（1,416）、`server.js`（1,135）、`src/devices.js`（1,068）、`public/js/log.js`（1,065）、`src/history-queries.js`（1,017）。`db-migrate.js` は設計上伸びるものです。`server.js` は35%伸び、`history-queries.js` はそれ自体が抽出された結果であり、自分を生んだ分割を追い越しました。
- **低・1つの関心事が2つの実装に。** `WindowsCredentialVault.cs` は `EgressView.Agent.Core` と `EgressView.Agent.Ui` の2箇所にあり、同じストアを触っています。
- **低・App Store非経由の配布。** macOSエージェントはDeveloper ID署名・公証されたDMG/PKGとして出荷し `dl.egressview.com` から自己更新するため、ストアの仕組みを継承せず独自の更新整合性チェーンを持ちます。
- **低・ルーター固有の収集は依然fixture依存。** conntrack経路はCIで実在のテーブルから収集されるようになりましたが、Yamaha・Cisco・ASUSの経路は記録済み出力に対する検証のままです。
- **低・supply chain。** `npm audit` は `better-sqlite3` のamalgamation内のSQLite CVEを検出できません。盲点は手動検証手順と共に文書化済み。install scriptは無効のままです。

**前回レポートの3つのリスクを削除しました。そして、それらはそもそも載るべきではありませんでした。** 前回は「OpenAPI契約なし」「正式な本番OCI imageなし」「リポジトリ内の正式なservice unitなし」を未解決として挙げていました。`docs/openapi.json`（permission matrixから生成され、乖離したらテストが失敗する）、本番 `Dockerfile`、`deploy/egressview.service` は、いずれも**2026-08-23**に入っています — 前回レポート自身の評価基準点より4週間前です。同じ3つの不在は§4で3点を減点した理由でもあったため、あのスコアも過小評価でした。

---

## 実測結果

| 検査 | 結果 |
|---|---|
| Hub unit test | 3,115件中**3,113件成功、失敗0、skip 2**（673 suite）。本レビューで実行。skip 2件は開いているファイルハンドルを調べるもので、macOSでは許されません（CIのLinuxでは実行されます） |
| macOSエージェントテスト | **892件、失敗0**（XCTest 882件のうちskip 3、加えてswift-testing 10件）。本レビューのためmacOS上で `swift test` を実行 |
| Windowsエージェントテスト | 単一のコンソールランナー（`Program.cs` + fixture 1本）に**781アサーション**。`windows-latest` のCIでのみ実行。永続化、上限付きドロップ、プライバシー安全な診断、IPC、サインインタスク、Mac文言との共通語彙を検証 |
| V8 coverage（`npm run test:coverage`、計装されたサーバサイドツリー） | **line 87.17%、branch 81.23%、function 83.65%** |
| CI coverage下限 | line 83%、branch 79%、function 80% — 合格（差は 4.2 / 2.2 / 3.7 ポイント） |
| Parser fuzz test | **32件成功、失敗0**（短campaign。加えて6時間ごとに20分の継続campaignが走り、発見入力をcorpusにcommit） |
| Playwright browser smoke | CI gate合格 |
| ESLint + Frontend HTML挿入監査 | 合格。`innerHTML` / `insertAdjacentHTML` 0件 |
| Production依存監査 | **脆弱性0件** |
| Windows NuGet監査 | `dotnet package list --vulnerable`（脆弱性を見つけても0で終了する）の出力を解析するCI gate。**拒否すべき脆弱fixtureに対して自ら実行される** |
| Secret scan | 高確度secret・環境固有LAN IPなし。追跡DB・追跡symlinkの検査も合格 |
| ASH（Automated Security Helper） | **actionable finding 0件**（suppressed 134）。本レビューの初回実行では3件を報告しました。いずれもgitignore済みのローカル `infra/` ツール内の `aws-cdk-lib` 経由で届く1つの `brace-expansion` advisory で、リポジトリ外・スキャン対象の作業ツリー内という位置です。suppressionではなく、修正版を同梱する `aws-cdk-lib` 2.273.0 へ当該ツールを更新して解消しました |
| GitHub Actions SHA pinning | **42/42**をfull commit SHAへpinned、0 unpinned |
| Hubの移植性 | unitテストをLinux（Node 22/24/26）**とWindows**（Node 22）で実行。offline-runtime配布とoffline portabilityは別のCIレーン |
| 本番image | ビルド・起動し `/readyz` まで待ち、DBがvolume側にあり image内に1つも無いことを検査 |
| ハードウェア経路のintegration | conntrack収集経路を、特権コンテナ内の実在のconntrackテーブルに対しSSH越しに検証（パスワードは実行ごとに生成しマスク） |
| macOSエージェントCI | `macos-agent.yml`（macOS）: `swift test`、app + System Extension の無署名 `xcodebuild`、System Extension identity gate |
| WindowsエージェントCI | `windows-latest`: `dotnet build`、NuGet監査、**無署名MSIビルド**、1つの版の再ビルドと取り下げ済み版を拒否するgate、全スクリプトのPowerShell構文検査、コアテストランナー、チャートのrender check、**render-cost budget** |
| リリース検証 | `release-gate.yml` が公開時・編集時・週次で公開リリースを検査。`release:publish` は資産をダウンロードした形で検証し失敗時はdraftを残す。`publish-agent-release.js` は取り下げ登録簿にある版を拒否。macOSエージェントリリースはDeveloper ID署名・公証・staple済み |

### コードベースメトリクス

| メトリクス | 値 |
|---|---:|
| Hub source行数（`server.js`、`src`、`public/js`） | 45,506（39,497） |
| Hub test行数（unit、integration、smoke、fuzz、portability） | 52,142（44,116） |
| macOSエージェント source行数（Swift、`Sources` + `Xcode`） | 29,529（25,587） |
| macOSエージェント test行数 / file | 15,401 / 97（12,379 / 80） |
| **Windowsエージェント source行数（C#）** | **20,052行 / 92ファイル**（14,447 / 72） |
| **Windowsエージェント test行数（C#） / アサーション** | **5,214 / 781**（2,906 / 約450） |
| Windowsエージェント XAML / PowerShell行数 | 652 / 617（572 / 375） |
| Windowsエージェント プロジェクト数 | 3（`Core`、`Service`、`Ui`）+ render tool 2 + テスト1 |
| Unit test file（Hub） | 267（218） |
| `src/` module | 159（134） |
| 1,000行を超えるHub module | **5**（2） |
| HTTP route（permission matrix） | 111（111） |
| MCP tool | 11 |
| Permission matrix entries | 122 |
| ルートのaccess内訳 | permission 94、authenticated 1、agent 6、public 10 |
| Agent認証ルート | ingest、token rotation、registration revoke、capabilities、geo-cache、threat-intel |
| 定義済みpermission | 8（ユーザー7 + エージェント1） |
| ロール | 3（viewer、operator、admin） |
| Production依存package | 13 |
| `docs/`配下のMarkdown文書 | 45（42） |
| DB schemaバージョン | **31**（24） |
| CI workflow / `ci.yml` 内のjob | 7 / 11 |
| `eval` / `new Function` ・ `innerHTML` / `insertAdjacentHTML` | 0 ・ 0 |
| CI Node.jsバージョン | 22、24、26（Linux）、22（Windows） |
| macOSエージェントバージョン | **0.5.128**、最小 macOS 13 |
| Windowsエージェントバージョン | **0.1.155**、.NET 10 |

括弧内は前回レポートの値です（変化があった項目のみ）。1行だけ比較できません: 前回レポートの「53」件のドキュメントは `docs/` 配下の全ファイルを数えたもので、Markdown文書ではありません。前回基準点における同等の値は42です。

---

## 1. OWASP ASVS Level 1

**判定: 完全適合（14領域中14領域が適合または緩和済み）。**

| 領域 | 状態 | 証跡 |
|---|---|---|
| 認証 | Pass | 版管理されたKDF移行付きscrypt、timing-safe比較、256bitセッショントークン、遅延失敗、IP別ロックアウト、PKCE付きGoogle OIDC。エージェントのbearer secretはpepper付きHMAC-SHA256でhash化。macOS keychainは `AfterFirstUnlockThisDeviceOnly`。WindowsエージェントはbearerをCredential Managerに保管 |
| セッション管理 | Pass | hash化トークン、sliding expiry、revocation、パスワード変更時の処理、定期prune、ロール束縛セッション |
| アクセス制御 | Pass | 111のHTTPルートのうち、94がpermission gate、1が認証のみ、6がエージェント認証、10が公開。deny-by-defaultの境界をWebSocket handshakeにも同一に適用。matrix 122件。エージェントのenrollmentは管理者承認が必要で、両クライアントプラットフォームがこの単一境界を再利用 |
| 入力検証 | Pass | JSON 64KB上限、エンドポイントmoduleでのstrict Zod、未知キー拒否、文字列/範囲の上限、SSRF guard。エージェント観測は入口でZod、保存時にSQLite CHECK制約（64bitバイトカウンタの10進文字列範囲検査を含む）。macOSのTLS ClientHello parserは攻撃者が制御し得る全長を境界検査し、読み取りを4KBで打ち切る |
| 暗号 | Pass | secretと相関には `randomBytes`/UUID、session/TOFU/principalHashにSHA-256、エージェント資格情報にHMAC-SHA256、timing-safe equality、MCPにRS256 JWT、Hubのリリース署名にKMS Ed25519。そしてエージェント更新マニフェストには**両プラットフォームで**埋め込みEd25519鍵を使い、どちらも使用前に公開fingerprintと照合 |
| エラー処理 | Pass | 汎用500応答、stack非露出、request相関付きサーバログ |
| データ保護 | Pass | config・backup・TLS鍵をmode 0600。公開configとログからsecretを除外。資格情報はhashのみ保管。エージェントの脅威照会はデバイス外に出ない。宣言され、テストで強制されるprivacy manifest |
| 通信 | Pass | HTTPS/HSTS対応。OIDC callbackはsecure redirectを強制。MCP OAuthはHTTPS JWKS経由。エージェントの更新確認はcookieなしの一時セッション・最小User-Agent・デバイス識別子なしで行い、WindowsクライアントはパッケージURLをマニフェスト自身のオリジンに固定 |
| 悪意あるコード | Pass | evalなし。Frontend HTML挿入監査をCIで強制 |
| ファイル処理 | Pass | 上限付きupload、backup名の検証、traversal検査、restore/migrationのfail-closed。更新ダウンロードは宣言サイズ・累積合計・絶対上限の3者で制限 |
| API security | Pass | method固有ルート、strict schema、応答サイズ/時間上限、認証付きexport、MCP rate limiting。エージェントのingestは冪等。エージェントの読み取りエンドポイントは `ETag`/`304` を使用。HTTP面はpermission matrixから生成されたOpenAPI文書で記述され、乖離するとテストが失敗する |
| 設定 | Pass | ハードコード資格情報なし、設定例、secret scan、本番でのdemo-mode拒否。エージェントのリリースビルドは禁止entitlementをビルド時に拒否 |
| ビジネスロジック | Pass | CSRF保護付きHttpOnly cookie、API identityへの明示的permissionトークン、試行回数制限付きの管理者承認enrollment、deny-by-default強制 |
| 監査とログ | Pass | 仮名化されたactorHash/principalHash付きのappend-only audit_events、24時間周期での180日retention、clientアドレスをキー化したMCP独立の監査ストア |

---

## 2. OpenSSF Scorecard（推定）

**推定スコア: 9.6/10。**

| Check | Score | 証跡 |
|---|---:|---|
| Pinned dependencies | 10 | GitHub Actions参照42件すべてをfull commit SHAへpin |
| Token permissions | 10 | read-only既定。deploy workflowは必要分のみ拡張 |
| Dangerous workflow | 10 | `pull_request_target` なし |
| Binary artifacts | 10 | バイナリのコミットなし |
| Security policy | 10 | `SECURITY.md` と非公開脆弱性報告 |
| License | 10 | AGPL-3.0-only |
| SAST | 10 | ASH、secret scan、ESLint、HTML挿入監査、npm audit、そしてWindowsエージェント向けNuGet監査 |
| Vulnerabilities | 10 | CIで本番 `npm audit` と `dotnet package list --vulnerable`。本レビューでは0件 |
| Dependency updates | 10 | npmとActionsへの週次Dependabot（7日cooldown）、`npm` の `min-release-age` によるinstall時下限と対応 |
| CI tests | 10 | PRごとにunit/coverage、parser fuzz、browser smoke。LinuxでNode 22/24/26、Windowsで22。本番imageレーン、実conntrack統合、System Extension identity gate付きの専用macOS workflow |
| Maintained | 10 | 評価コミットまで活発なリリース・PR履歴 |
| Code review | 8 | 必須checkつきPRワークフロー。RBACとpermission matrixがレビュー基準を強制 |
| Fuzzing | 7 | parser fuzzingをPRごとに実行し、`fuzz-continuous.yml` で6時間ごとに20分のcampaignを回し、発見入力を `test/fuzz/corpus/` に永続化。意図的にOSS-Fuzzではない（coverage-guidedなフィードバックがない）ため残点が残る |
| Signed releases | 9 | Hubリリースはdetached signature資産つきで、資産をダウンロード形で検証し公開時・編集時・週次に再検査される統合コマンドから公開。macOSエージェントリリースはDeveloper ID署名・公証済み。両プラットフォームのエージェント更新マニフェストはEd25519署名済み。残る1点はSLSA provenanceが必要 — なお、その署名付きマニフェストが指すWindowsの**パッケージ**は無署名です（§7） |

前回の推定から変化なし。WindowsのNuGet監査と追加CIレーンはすでに10点の項目を補強するものです。残る3点には、coverage-guidedなfuzzing、SLSA provenance、第二レビュアーが必要です。

---

## 3. ISO/IEC 25010

| 品質特性 | Score | 強み | 残るgap |
|---|---:|---|---|
| 機能適合性 | 9 | 複数router収集、プロセス別帰属と独自の可視化を持つ成熟したmacOSエンドポイントエージェント、公開済みWindowsエージェント、エージェント/ルーター相関、ローカル脅威照合、AI洞察、export、MCP + OAuth、HTTP面の生成されたOpenAPI記述 | Linuxエージェントがない（公開スクリプトは既にそのプラットフォームを受け付ける） |
| 性能効率性 | 9 | 遅い1文がリクエストを凍結させない専用DBスレッド。WAL、batch、bounded summary、同時に問われる読み取りで共有されるcache、worker分離されたbackupと脅威フィード解析、MCP concurrency cap、covering index、長期ビュー向け日次ロールアップ。エージェントは集約からチャートを提供しApp Napで安価に常駐 | 書き込み1本が依然として容量の上限。今サイクルは読み取りをリクエストスレッドから外したが書き込みは外していない。きっかけとなった本番障害は最終的にホストのI/Oに縛られていた |
| 互換性 | 9 | LinuxでNode 22/24/26・Windowsで22、JA/EN、Yamaha/Cisco/ASUS/conntrack、macOS 13+エージェントと公開済みWindowsエージェント、Cognito compatibility profile、subpath proxy配下の正常動作。conntrack経路はCIで実在のテーブルから収集 | Yamaha・Cisco・ASUSの収集は、ハードウェアではなく記録済み出力に対する検証のまま |
| 使用性 | 9 | Responsive UI、setup guide、自動検出、health診断、検知別通知スイッチ、共有収集ソース選択、自己クリアする「記録停止」警報を持つインストール可能なメニューバーmacOSエージェント、Windowsのtrayアプリ、read-only公開デモ。timelineは「何も送られなかった」を示唆する代わりに「不明」を表示するようになった | router側設定が依然として実際のオンボーディングコスト |
| 信頼性 | 9 | migration/restore/config/notes fail-closed、health/readiness、cancel、request ID、rate limiting、scheduled audit retention、event-loop watchdog*と*それが捕らえるべき事象を減らすDBスレッド、出荷されたservice unitとCIで検証されたコンテナのrestart policy。macOSエージェントは黙った停止を検知・告知し、WindowsエージェントはDBエラーでfail-closed | Windowsの取り下げは、利用者に届いた信頼性事故です。公開された1版はmigrationを完了できず、エージェントを永久に記録しない状態で残しました |
| Security | 10 | OIDC/PKCE、RBAC、プラットフォーム間で共有される独立agent種別を含むdeny-by-default permission、CSRF、HttpOnly cookie、hash-only資格情報、管理者承認enrollment、MCP OAuth/JWKS、audit trail、rate limit、SSRF guard、統合された署名リリース工程、両クライアントプラットフォームで独立検証される更新チェーン、エージェントのApp Sandbox + hardened runtime、オンデバイス脅威照合 | -- |
| 保守性 | 8 | 159のHub module、綺麗に分割されたSwiftエージェント（Core / Network Extension / host app）、3プロジェクトのWindows solution、3者すべてで強いtest、permission matrix、parser fuzz、native-dep盲点の文書化 | **1点減。** 1,000行超が2つから5つに。`server.js` が35%伸び、`history-queries.js` は自分を生んだ分割を追い越した |
| 移植性 | 10 | Cloud非依存profile、KMS署名されたportable source bundle、起動前feature policyのoffline mode、version管理rollback、Node 22/24/26 CI。CIがビルドし起動し状態漏れを検査する本番コンテナimage、コミット済みsystemd unit、そしてLinuxに加えWindowsでも動くHub自身のテスト。エージェントはtile serviceを呼ばず地図の輪郭を同梱 | -- |

**平均: 9.1/10。** 変化なしですが、静止しているのではありません。コンテナimageとservice unitが「主張」ではなく「検証された成果物」になったことで移植性が1点上がり、モジュールの成長が分割を追い越したことで保守性が1点下がりました。

---

## 4. Node.js Best Practices

**準拠率: 48/50（96%）。**

- Domain、route、poller adapter、エージェントのingest/相関/threat-intel module、DB bootstrap、auth middleware、browser renderingの責務を分離。
- **DB処理が専用スレッドで動きます。** `db-worker-host.js` が要求を送りPromiseを返し、workerは自分の接続を持ちます。その接続は必要な2箇所で閉じられます — restoreがファイルを置き換える前と、shutdownが正常停止を記録する前（ハンドルが開いていれば拒否されます）。event-loop watchdogは主防御ではなくbackstopとして残ります。
- 外部async処理にtimeout/AbortSignal上限。backup pruneと脅威フィード解析はworkerとsingle-flight jobで隔離、ASUSポーリングはoverlapping cycleをcoalesce、MCP requestはconcurrency cap。
- Loggerは`AsyncLocalStorage`で安全な`X-Request-Id`を付け、query stringは記録しません。
- Graceful shutdown、readiness、schema migration、config rollback、永続化失敗、permission enforcementをtest。起動時チェックがDBの欠落を報告し、DB初期化中は起動状況が表示されます。
- HTTP面は `docs/openapi.json` で記述され、permission matrixから生成されます。再生成せずにルートを追加するとテストが失敗します。
- 本番 `Dockerfile` と `deploy/egressview.service` unitを提供し、CIがimageをビルドし起動し `/readyz` を待ち、DBがimage内ではなくvolume上にあることを検証します。
- ESLint、V8 coverage、LinuxでNode 22/24/26・Windowsで22、Playwright、parser fuzz（PRごと + 6時間ごとの継続）、ASH、secret scan、dependency auditをgateにし、conntrack収集経路は実在のテーブルに対してintegration test。macOSエージェントはSystem Extension identity gate付きの専用workflowを持ちます。
- 信頼できない入力を多層で検証: エージェント観測は入口でZod、保存時にSQLite CHECK制約。脅威エンドポイントは「照合対象の宛先を受け取る」のではなく「データを渡す」設計。
- SSRF保護はoutbound endpointを名前解決し、link-local/metadata/multicast/broadcastを拒否し、検査済みIPへ接続を固定してDNS rebindingを防ぎます。
- リリース整合性はKMS管理鍵をリポジトリ外のDNS TXTレコードにアンカー。リリースと署名は資産をダウンロード形で検証する1コマンドに統合。取り下げ登録簿が、不良版の再ビルドと再公開を止めます。
- 依存のinstall scriptを無効化。native依存のaudit盲点は手動検証手順と共に文書化。

減点はモジュールサイズ（1,000行超が5ファイル）と、ハードウェアではなく記録済みfixtureに依存するルーター固有の収集経路に対してです。前回レポートはOpenAPI契約・OCI image・service unitの不在を理由に3点を減点しましたが、3つとも執筆時点ですでにリポジトリにありました。

---

## 5. SonarQube相当Quality Gate

| Metric | 結果 | Rating |
|---|---:|---|
| Reliability | HubにCritical/Highの既知不具合なし。DBスレッドが主要な停止要因を除去し、取り下げリリースは後継つきで記録される。一方で今サイクルにWindowsの3版が取り下げられ、うち1版は公開済みだった | A |
| Security | 高確度secret・dependency findingなし。独立agent種別を含む完全なRBAC、監査、SSRF保護、KMS Hub署名、統合された署名リリース工程、両クライアントプラットフォームで検証される更新チェーン | A |
| Maintainability | 成長が分割を追い越した。1,000行超が前サイクルの2つから5つへ | A（下降傾向） |
| Coverage | line 87.17% / branch 81.23% / function 83.65%（CI gateが検査するスコープ） | A |
| Duplication | 手動・静的reviewで重大な新規重複なし。ただし `WindowsCredentialVault` の2実装は例外 | A（推定） |

**Quality gate: 合格。**

### 主な保守性hotspot（Hub）

| File | 行数 | 評価 |
|---|---:|---|
| `src/db-migrate.js` | 1,416（1,202） | schema migration v1--v31。append-onlyで設計上伸びる |
| `server.js` | 1,135（842） | bootstrapとdependency wiring。**35%伸びて**1,000行を超えた |
| `src/devices.js` | 1,068（891） | device identity、persistence、merge lifecycle |
| `public/js/log.js` | 1,065（1,050） | pagination、filter、renderが同居 |
| `src/history-queries.js` | 1,017（612） | **66%伸びた** — `history.js` からの抽出が、自分の分割を追い越した |
| `src/history.js` | 894（803） | store orchestration |
| `src/routes/connections.js` | 791 | 通信ログ、summary、脅威件数のルート |
| `src/routes/agents.js` | 789（731） | エージェントのenrollment、承認、ingest、capabilities、geo-cache、threat-intelルート |
| `src/agent-ingest-store.js` | 763 | エージェント観測の永続化とロールアップ保守 |
| `src/threat-intel.js` | 723 | フィード取得、解析スケジュール、永続化、判定 |
| `src/pollers/yamaha.js` | 710（627） | adapter parser周辺のstateful SSH lifecycle |
| `public/js/graph.js` | 679 | 抽出済みhelper/panel/rendererのorchestration |

1,000行超が前サイクルの2つから5つになりました。前回レポートは `log.js` と `devices.js` を「この一覧に再び手を入れるなら明白な候補」と名指しましたが、`log.js` は1%、`devices.js` は20%伸びており、どちらも手は入っていません。注目すべきは、35%伸びて2番目に大きいファイルになった `server.js` と、66%伸びた `src/history-queries.js` です — 後者は前サイクルに `history.js` を分割して生まれたファイルであり、自分を作った分割を追い越しました。

---

## 6. Macアプリ品質（Appleプラットフォーム）

本節はmacOSエージェントを**Macアプリとして**、Appleが「App Store非経由で配布されるMacアプリ」に課す期待に照らして評価します: サンドボックスとhardened runtime、entitlementの最小化、Developer ID署名と公証、Network/System Extensionの正しくプライバシーに配慮した利用、信頼できるソフトウェア更新チェーン、privacy-by-designと宣言されたprivacy manifest、Human Interface Guidelinesとアクセシビリティ、reliability/observability、テスト容易性です。スコアはリポジトリ内容からの推定で、macOS専用ビルドと署名パイプラインはソースとCIから検証し、実行はしていません。Swiftのテスト群は本レビューのためmacOS上で**実行しました**。

**推定スコア: 9.2/10。**

| 評価軸 | Score | 証跡 | gap |
|---|---:|---|---|
| App Sandbox & hardened runtime | 10 | メニューバーのhostアプリとcontent filter拡張の双方が `app-sandbox = true` を宣言。リリースビルドは `--options runtime` で署名。共有app group（`group.com.egressview.agent`）が唯一のIPC面 | -- |
| Entitlementの最小化 | 9 | hostは `network.client`、`system-extension.install`、`files.user-selected.read-write`（CSVエクスポート用）、content filter NE keyのみ。リリースビルドは禁止entitlement（`network.server`、任意の `temporary-exception.*`、トップレベルのMach service名）をビルド時と、ZIP往復後に再度**拒否** | エクスポートにuser-selected-fileは避けられない |
| 署名 & 公証 | 10 | `build-release.sh` がarchiveし、**内側から外へ再署名**し、最終entitlementをassertし、`notarytool --wait` に提出し、staple、`spctl --assess`、そして往復したバイト列を再検証。Hub側のリリース＋署名は統合され、無署名での出荷が不可能で、公開時・編集時・週次に再検査される | macOS専用。本レビューでは未実行 |
| Network/System Extension | 10 | **pass-only**の `NEFilterDataProvider`: すべての判定はreporting付き `.allow()` で、トラフィックを保持もブロックもしない。opt-inはフロー単位で読み、statistics reportは曖昧として無視。CIのidentity gateがbundle id、`NEMachServiceName`、`startSystemExtensionMode()`、プロセス内のコード有効性をassert | -- |
| 更新整合性 | 9 | DNSアンカー付きfingerprintの埋め込みEd25519鍵、JSON解析*前*の署名検証、厳密に新しい版のみ、署名済みマニフェストに対するsize + SHA-256検査。パッケージ自身の署名と公証は、開いたときにmacOS（InstallerとGatekeeper）が検査する — エージェント自身はパッケージ署名を検査しない（未使用だった `AgentPackageVerifier` は0.5.126で削除。`SecStaticCodeCheckValidity` はインストーラー署名を読めない）。coordinatorはチェックサム検証済みパッケージで止まる。サンドボックスアプリは自分が書いたものを起動できないが `installd` はインストールできるため `.pkg` で配布。relaunch失敗は記録され、アップグレードのコピーは積み上がらなくなった（0.5.125） | Mac App Store経由ではないため独自のチェーンを持つ |
| Privacy by design & privacy manifest | 10 | 復号せず、既定では接続の中身を読まない。opt-inのSNIは4KB上限でデバイス内に留まる。QUICは数えるだけでデコードしない。脅威照合はローカル。更新確認はデバイス識別子を送らない。アプリと拡張の双方が `PrivacyInfo.xcprivacy` を同梱し、宣言のないプライバシー関連API使用はリポジトリテストがビルドを失敗させる。2026-09-27以降、hostアプリの宣言は配布CDNと任意の外部サービスが保持し得るデータを開示するよう*広げられた* — 新たな収集ではなく正確さへの訂正。拡張の一覧は空のままで、`docs/agent-privacy.md` が接触する全ホストを列挙 | -- |
| HIG & アクセシビリティ | 8 | `LSUIElement` のメニューバーアプリ。templateアイコンは**色ではなく形**で区別し、完全な文言を最初のメニュー行に置きVoiceOverのaccessibility labelにも設定。en/ja対応。アイコン資産が無い場合のテキストfallback。VoiceOverの退行は不具合として扱い修正される（0.5.128でアプリチャートの読み上げを復旧） | メニューバーのみの面は本質的に簡素。より深いアクセシビリティ監査は今後の課題 |
| Reliability & observability | 9 | 黙った「記録停止」を検知・告知（起きていた時間のみ計上）、自己クリアするrehearsalスイッチ、cooldownと日次上限（監視アラートは除外）付きの通知種別、App Nap、keychain読み取りのメインスレッド外化、relaunch失敗を診断する時間差インストールログ、macOSがフローのcloseを2回報告しても件数が正しいこと（0.5.127）、Hubへの重複記録の削減（0.5.126） | 完全な挙動検証はmacOS専用 |
| テスト容易性 | 9 | **Swiftテスト97ファイル（15,401行）、本レビューで892件をmacOS上で実行**（XCTest 882件のうちskip 3、加えてswift-testing 10件）。更新チェーン、パッケージ同一性、資格情報/enrollment、脅威照合とconfidence、フロー対応付け、TLS/QUIC分類、保存/migration、チャート/カバレッジ、通知、ログイン時起動をカバー。CIにSystem Extension identity gate | 署名・公証とデバイス上の挙動はunit testできない |

**際立つ点。** エージェントは引き続き注意深いプラットフォーム市民であり、今サイクルは拡張よりも磨き込みでした: 47版にわたる正しさの積み上げ — 重複したcloseレポートがフローのバイト数を二重に数えなくなり、アップグレードのコピーが積み上がらなくなり、VoiceOverがアプリチャートを再び読むようになりました。privacy manifestは守られたのではなく*広げられた*ことが重要です。真実であることに価値が依存する宣言にとって、それが正しい方向です。

**さらに進める余地。** App Store配布（ストアの更新・プライバシー基盤を継承できる）は現時点で意図的な非目標です。メニューバー面を超えたアクセシビリティ・ローカライズ監査は今後の課題です。そしてmacOSのパイプライン全体はmacOS上でしか動かせないため、本レビューは署名と公証の工程についてはCIの証跡に依拠しています。

---

## 7. Windowsアプリ品質（Microsoftプラットフォーム）

本節はWindowsエージェントを**Windowsアプリとして**、「サービスをインストールして配布されるデスクトップエージェント」にプラットフォームが期待することに照らして評価します: 最小権限のサービスID、守られたIPC境界、正しい資格情報保管、綺麗に入って綺麗に消えるper-machine MSI、Authenticode署名と信頼できる更新チェーン、privacy-by-design、WindowsのUXとアクセシビリティ慣習、サービス監督下での信頼性、テスト容易性です。

これは§6の再採点ではなく、意図的に*別の*フレームワークです。両プラットフォームが守る境界は異なります。Macエージェントの難所はサンドボックス・entitlement・公証であり、Windowsエージェントの難所は自分のアカウントで動くサービス、他のローカルユーザーが到達してはならない名前付きパイプ、そして配布チェーンそのものであるインストーラーです。

**推定スコア: 8.7/10。** エージェントはもう公開されているので、本節は計画を採点しているのではありません。2項目が上がり、1項目が下がり、本節を定義づけるgapは変わっていません。

| 評価軸 | Score | 証跡 | gap |
|---|---:|---|---|
| サービスIDと最小権限 | 10 | サービスは `LocalSystem` ではなく **`NT AUTHORITY\LocalService`** でインストールされます — 組み込み2アカウントのうち弱い方で、マシン全体の権限を持たずネットワーク資格情報はnull。収集は管理者を必要としないので、要求しません | -- |
| IPC境界 | **9** | 名前付きパイプは既定のままではなくACL付きです: `BuildSecurity` が **Network SIDを明示的にDeny**（拒否しない限りパイプはSMB経由で到達可能）してから `LocalSystem` を許可し、明示的に渡された1つのSIDにのみread/write/synchronizeを与えます | **1点減。** 0.1.125はサービス自身のアカウントに `CreateNewInstance` だけを与えたため、4つのリスナーのうち3つが毎回失敗して100 msごとに再試行し、失敗カウンタを1,947,715回書きました。そのテストはクライアントとサーバに同じSIDを与えていたため、これを見られませんでした |
| 資格情報保管 | 9 | Hubのbearerは `CRED_PERSIST_LOCAL_MACHINE` で **Windows Credential Manager** へ。サービスが書くファイルでも、平文のレジストリでもありません | 同じストアを触るvault実装が依然2つ（`Core` と `Ui`） |
| インストーラーの正しさ | 9 | WiX、**`Scope="perMachine"`**、`Start="auto"` と `ErrorControl="normal"` を持つ明示的な `ServiceInstall`、インストール時に開始しインストール時とアンインストール時の双方で停止する `ServiceControl`、データディレクトリを `LocalService` のみに与える `util:PermissionEx`、dev→MSI移行スクリプト、そしてアンインストールでは消えるがアップグレードでは消えないサインインタスク。CIは毎PRでMSIをビルドし、いまは**1つの版の2度目のビルドも拒否**します — まさに0.1.118の教訓（2つのビルドが1つの番号を共有し、`msiexec` が何も置き換えないまま0を返した）です | 無署名でビルドされる |
| サービスのresilience | 9 | `util:ServiceConfig` がWindows自身の障害復旧（60秒遅延での再起動）を設定するため、監督は自前のwatchdogではなくプラットフォームの仕事です。`measure-dev-recovery.ps1` はサービスを殺し、復帰を待ち、前後のDBを比較します | 計測スクリプトはCIではなく手で走らせるもの |
| Authenticodeと更新チェーン | **6** | **1点増。ただしチェーンについてのみ。** 更新クライアントは完成しfail-closedです: リクエスト前に埋め込み鍵を公開fingerprintと照合し、マニフェストのEd25519署名をJSON解析*前*に検証し、schemaとplatformを固定し、厳密に新しくない版を拒否し、パッケージURLは公開オリジンと一致しなければならず、ダウンロードは宣言サイズ・累積合計・絶対上限で制限され、SHA-256を検査し、そしてインストールまたは再検証の前に**宣言されたpublisherを伴う有効なAuthenticode署名を要求**します。無署名パッケージを「自分で取ってきてください」に降格させません | **MSIはいまも無署名** — 公開資産名は `…-0.1.155-x64-unsigned.msi` で、CIの手順名はいまも「Build unsigned Windows MSI」。クライアントが署名を要求するため、リリースは `install: "manual"` と記され、**上記のチェーン全体が決して走りません**。利用者はSmartScreen警告を受け、出所を検証する手段がありません |
| Privacy by design | 10 | Macエージェントと同じ抑制、Hub内で同じ境界: パケットの内容は決して収集せず、診断は**テストでプライバシー安全性をassert**し、Hubの `agent` アクセス種別を再利用して2つ目を開きません。非公開アドレスは位置情報サービスへ送られません | -- |
| WindowsのUXとアクセシビリティ | 8 | Fluentテーマを持つWPF trayアプリ、en/ja対応、そしてMacの英語文言に対する**テストで固定された共通語彙**により、読者が見る用語で2製品が乖離できません。CIでrender checkと**render-cost budget**が動くのは、デスクトップのチャートとしては異例の厳格さです。狭いカード上でスイッチのラベルが折り返すといったレイアウト不良も不具合として直されます | UI Automation / スクリーンリーダーの自動assertionがなく、高コントラストとDPIの挙動は本レビューで未確認 |
| テスト容易性 | **8** | **1点増。** ソース20,052行に対しテスト5,214行・**781アサーション** — 比率は20%から26%へ上がり、テスト行（+79%）がソース（+39%）より速く伸びました。CIには**拒否すべき脆弱fixtureに対して実行される**NuGet脆弱性監査と、読むのではなく走らせるビルド拒否gateが加わりました | ランナーはいまも素の `Program.cs` でフレームワークではありません: テストごとの分離がなく、失敗一覧も出ず、最初の失敗で実行が終わります。0.1.125がその代償です — 欠陥に対するテストが存在し、それを見られませんでした |

**際立つ点。** 更新クライアントが本節で最も強く、その理由を正確に述べる価値があります: **不正な入力に対して有用であることを拒む**のです。無署名や壊れたパッケージを手動ダウンロードに降格させれば初日から自己更新を出荷できたはずですが、そうせず失敗します。理由はソースにあります。それは「マニフェストの欠陥を沈黙に変えてしまう」から。取り下げ登録簿も同じ性格です。0.1.117を消して先に進むのは簡単でしたが、代わりに理由が数字つきで書き留められ、後継が名指しされ、ツールチェーンの3箇所がそれを触ることを拒みます。

**さらに進める余地。** 署名です。そしてそのコストは以前より高くなりました。無署名MSIはかつて第一印象の問題でしたが、いまは「丁寧に作られた完成済みの更新チェーンが遊んでいる」理由です。クライアントが、公開側の産物を正しく拒否しているからです。その次は: テストランナーを本物のフレームワークにすること — 0.1.125がその論拠です（テストがあったのに見えなかった欠陥）。そして2つの `WindowsCredentialVault` 実装を1つにすることです。

---

## 結論

評価コミット時点で、mainは文書化された自己ホスト型デプロイモデルに適しており、強固なマルチユーザーセキュリティ制御を備えています。自動品質gateは広く、そのいくつかは自分自身を試すようになりました。データを変える操作はfail-closedで、deny-by-defaultの完全なRBACが強制され、MCPアクセスはrate limitingと監査付きでOAuth保護され、CriticalまたはHighの問題は残っていません。Coverageは87.17/81.23/83.65へ上がり、Hubのテストは3,115件になりました。

今サイクルの性格は「現実との接触」でした。Windowsエージェントが公開され、どれだけCIを積んでも見つからない種類の失敗をただちに生みました — 実際のDBでは完了できないmigration、2つのビルドを指す版番号、自分のテストでは見えない誤ったパイプACL。重要なのは、それぞれが実測値と後継つきで書き留められ、ツールチェーンの3箇所が取り下げ済み版のビルド・公開・受け入れを拒むようになったことです。Hubの、自分自身の本番停止に対する答えは防御的ではなく構造的でした: DB処理が専用スレッドへ移り、watchdogは計画ではなくbackstopになりました。そしてtimelineのチャートは、自分のグルーピングから上昇曲線を描いていたことが判明し、訂正にappend-onlyのmigration 5本を要しました — 各本が、前の試みが持ち込んだ歪みを記録しています。

無署名のWindows MSIは、静かに、より高くつくようになりました。前サイクルは「誰にも渡していない成果物」に対する中リスクで、助言は「最初の公開より前に署名すること」でした。公開が先に来ました。コストはいま具体的で、やや皮肉です: Windowsの更新クライアントは完成しており厳格です — fingerprint固定、解析前の署名検証、ダウングレード拒否、3通りに制限したダウンロード、SHA-256検査、Authenticode必須 — そして公開側が無署名MSIを出すため、リリースは `install: "manual"` と記され、その何一つ走りません。チェーンは出来上がり、正しく、そして不活性です。待っているのは1つの署名だけ。これが引き続き、最も価値のある修正対象です。

前回レポートへの訂正を2つ記します。前回は未解決リスクに「OpenAPI契約なし」「正式な本番OCI imageなし」「リポジトリ内の正式なservice unitなし」を挙げ、同じ3つの不在を理由にNode.js Best Practicesで3点を減点していました — しかし `docs/openapi.json`、本番 `Dockerfile`、`deploy/egressview.service` はいずれも2026-08-23に入っており、前回レポート自身の評価基準点より4週間前です。そして前回§7の見出しスコア8.3/10は、同じ節の表の平均（8.6）と一致していませんでした。したがってここでの8.7は、0.4ではなく約0.1の上昇です。

保守性は唯一、悪い方向に動いている指標であり、このプロジェクトは通常これが得意なので、はっきり名指しする価値があります。1,000行超が2つから5つになりました。前回レポートは `log.js` と `devices.js` を次の明白な候補として指名しましたが、どちらも分割されていません。その間に `server.js` が35%、`history-queries.js` が66%伸びました — 後者は前サイクルに `history.js` を分割して*生まれた*ファイルであり、自分を作った分割を追い越しました。残る改善として明確なのは、WindowsのAuthenticode署名、Windowsランナーの本物のテストフレームワーク化、肥大した5モジュールの分割、Signed-Releasesの最後の1点となるSLSA provenance、リポジトリ内campaignを超えるcoverage-guided fuzzing、そしてYamaha・Cisco・ASUSの収集経路のハードウェア検証です。リリース上の懸念に近いのは最初の1つだけで、残りは要件に応じた強化です。変わらない留保は検証に関するものです: Windowsのテスト・MSIビルド・サービス挙動はWindows上でのみ動くため、§7はここでは実行ではなくソースとCIから評価しています。
