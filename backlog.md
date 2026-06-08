# Widemap Backlog

実装予定の機能・改善案。完了したら削除またはチェック。

## 🎯 ポジショニング・差別化（AI時代のホーム/SOHOセキュリティ）

### 背景 — なぜ今このツールが必要か

**「Mythos時代」と呼ばれるAI×IoT普及期の家庭・SOHOにおけるサイバーセキュリティの課題:**

- 一般家庭・SOHOのLANに接続されるデバイスは年々増加。スマートTV・IPカメラ・NAS・Wi-Fiスピーカー・家電・ルーター・スイッチなど20〜40台以上が当たり前に
- IoT機器の多くはセキュリティが後回しにされており、ファームウェアの更新も不定期。サプライチェーン段階での侵害（Mirai型マルウェア等）が常態化
- AIを活用したマルウェアはC2サーバーとのやり取りを人間の目には正常通信に見せかけながら継続。従来のシグネチャベース検出では対応が難しくなっている
- **しかし家庭・SOHOのユーザーには「自分のネットワーク内のデバイスが今どこと通信しているか」を把握する手段がほぼない**

### Wideemapが応える問い

> *LAN内の各デバイスは、今実際にどこと通信しているのか？*

この問いに答えられるツールが、家庭・SOHO向けに存在しなかった。

### Wideemapの優位性と差別化要因

| 観点 | Widemap の強み |
|------|--------------|
| **監視方式** | NATセッションテーブルをSSH経由でパッシブ読み取り。通信経路に一切介在しない |
| **ハードウェア** | 追加機器ゼロ。既存のYamaha RTX（家庭・SOHOで高シェア）をそのまま活用 |
| **デバイス識別** | OUI・mDNS・SSDP・NetBIOS・Appleモデル辞書で「どの機器が」を特定。IoT機器の識別精度が高い |
| **脅威インテリジェンス** | Feodo/ThreatFox/URLhaus/Spamhaus DROPをローカル突合。IP外部送信なし |
| **アラート** | 脅威検出時に即時Slack DM。クールダウン設定でスパム防止 |
| **プライバシー** | 完全ローカル動作。通信内容・デバイス情報はクラウドに送信しない |
| **コスト** | OSS（AGPL-3.0）。追加費用ゼロ |
| **セットアップ** | `npm install && npm start` のみ。10分で可視化開始 |

### 優先的にアピールすべきユースケース

1. **スマートホームのIoT機器監視** — スマートTV、IPカメラ、スマートスピーカーが見知らぬIPと通信していないか
2. **在宅勤務環境のセキュリティ確認** — 業務PCと私物デバイスが混在するLANの通信状況把握
3. **Yamaha RTX導入済みSOHO** — すでにRTXを使っている環境への追加価値として即効性が高い
4. **C2検出・ボットネット加担の検知** — Feodo等フィードとの突合で既知の脅威インフラを即検出

---

## 📋 推奨実装順序

> 完了した項目は `🟢` でマーク。未着手・進行中はそのまま。

| # | 項目 | 理由 |
|---|------|------|
| 🟢 1 | server.js モジュール分割 + テスト作成 | 全ての後続作業の前提。機能変更なしのリファクタなのでリスク低 |
| 🟢 2 | SQLite 化 | better-sqlite3 (WAL mode)。保存期間2年。バックアップ・リストア機能付き |
| 🟢 3 | C2/Botnet 検出 Phase 1（外部フィード突合） | Feodo/ThreatFox/URLhaus/Spamhaus DROP。3段階信頼度（検出/要確認/未検出）。通信ログUI・脅威ポップアップ付き |
| 🟢 3+ | アラート通知（Slack DM） | Bot Token + ユーザー名検索。クールダウン・言語対応。high/low 両方通知（デフォルト1h間隔） |
| 🟢 3+++ | 新規デバイス検出 | SQLite内のMAC履歴との差分比較。未知デバイスがLANに参加した瞬間を検出してSlackアラート＋NEWバッジ表示 |
| 🟢 3++ | 接続履歴のオンデマンドロード（API化） | 現状は全件をSocket.IOで送信。2年保存で10万件超になるとブラウザが重くなる。期間フィルタ付きREST APIに変更し、初回は直近24hのみ送信。リアルタイム更新は差分pushを維持 |
| 🟢 4 | DNS ログ監視（L7 可視化） | Yamaha RTXは `syslog debug on` + 外部syslogサーバー受信でデバイス単位（送信元IP＋ドメイン）が取得可能。Widemap側でUDP 514受信→`DNS Query`行パース→NATセッション突合。OpenWrt（dnsmasq）は #4+ で同時対応 |
| 4+ | conntrack 対応（OpenWrt / ASUS ルーターモード / Ubiquiti UDM） | conntrack 共通パーサーで複数ルーターを一括対応。ユーザー層が大幅拡大。ASUS・Ubiquiti はファームウェア変更不要。OpenWrt は Buffalo/TP-Link 等に要フラッシュ |
| 4++ | ビーコン検出（C2ハートビート） | 同一宛先への一定間隔（±10%）通信を自動検出。C2ハートビートの典型パターンに直撃。SQLite実績があれば実装可能。誤検知対策として最低観測回数・間隔閾値を設定 |
| 5 | 通信ブロック（Yamaha RTX / OpenWrt） | 検出から「対処」まで完結。Yamaha: ip filter をSSH経由で書き込み。OpenWrt: ipset + iptables でFeodo全リスト自動ブロック可。自動ブロックは誤検知リスクがあるため手動承認モードを先行実装 |
| 5+ | IPv6 通信先可視化（パケットミラー方式） | RTX ミラーポートで IPv6 パケットをキャプチャ。pass-through 維持のまま通信先が見える。追加機器(Pi等)必要 |
| 5++ | AWS VPC Flow Logs 対応（NAT GW + EIGW） | NAT GW（IPv4）と EIGW（IPv6）で Yamaha と同構造のデータが取れる。オンプレ + クラウド統合ビューは競合なし |
| 6 | C2/Botnet 検出 Phase 3（外部API連携） | AbuseIPDB / VirusTotal / AlienVault OTX による精密判定。ビーコン検出の運用実績・誤検知率を確認してからチューニングに入る |
| 7 | モバイルアプリ（iOS/Android ビューア） | Capacitor で既存 Web UI をラップ。アラート通知との組み合わせで Firewalla 相当の UX に |
| 8 | macOS メニューバーアプリ | バックエンドが安定してから。独立プロジェクトとして進められる |
| 9 | IPv6 セッション追跡（RA Proxy 方式） | ⚠️ Nuro 光環境では RA Proxy 切替で IPv6 通信断が発生（2026-06-06 実機確認済み）。ISP/ONU 変更なしでは実現不可 |
| 10 | バックエンド生成テキストの多言語化 | investigate メモ・vendor カテゴリ名等のサーバー側テキストを言語設定に連動。現状は日本語固定 |
| 11 | その他（CSV/JSONエクスポート等） | 優先度に応じて随時 |

### 2026-06-06 セッションで完了した追加実装

| 機能 | 内容 |
|------|------|
| 通信ログビュー | 全セッション一覧。カラムごとのソート・検索（テキスト/正規表現/日付範囲）。脅威行クリックで詳細ポップアップ |
| IPv4/IPv6 バッジ | NDP キャッシュからIPv6検出。メタ行にプロトコルバッジ表示 |
| 脅威信頼度 3段階 | 検出(high/赤)・要確認(low/オレンジ)・未検出(緑)。推奨アクション文あり |
| DB バックアップ・リストア | 定期バックアップ(設定可能)、世代管理、DL/Upload リストア、確認ダイアログ |
| ログ保存期間設定 | 7日〜2年（デフォルト2年）。短縮時の確認ダイアログ付き |
| NAT ディスクリプタ設定 | 設定UIから変更可能（環境変数依存を解消） |
| i18n テスト | 翻訳キーの網羅性、option 要素の漏れ、フロントエンド TDZ 検出 |
| セキュリティ | ASH スキャン必須（steering ルール）。push 前に毎回 actionable: 0 確認 |

### 2026-06-07 セッションで完了した追加実装（#4 相当）

| 機能 | 内容 |
|------|------|
| dnsmasq DNS ログ | `src/pollers/dnsmasq-log.js`。`/var/log/dnsmasq-queries.log` を tail -F してパース。query/reply 行を照合し resolvedIP→dstHost を補完。直接クエリデバイスは per-client 追跡も可能 |
| dstHost 優先度制御 | dnsCache に `source: 'dnsmasq' \| 'ptr'` フィールド追加。dnsmasq エントリは PTR 逆引きで上書き不可。`isPtrJunk()` で EC2・compute.internal 等のジャンク名をフィルタ |
| [INSPECT] syslog | `src/pollers/inspect-syslog.js`。`/var/log/yamaha-router.log` を tail -F して TCP セッション完了行をリアルタイムパース。60秒ポーリングで取りこぼした短命 TCP セッションを補完 |
| [DHCPD] syslog | `src/pollers/dhcpd-syslog.js`。同ファイルから Allocates/Extends 行をパースし IP→MAC マッピングを 24h TTL で維持。`resolveMacByIp()` の第2優先として統合 |
| 📡 データソース設定 UI | 設定画面に「データソース」タブを追加。dnsmasq / [INSPECT] / [DHCPD] の有効/無効とログファイルパスを UI から変更可能。`/api/config/datasources` API 経由で保存・即時反映 |
| i18n 対応 | データソースタブのタブ名・セクション見出し・ログファイルラベルに `data-i18n` 属性追加。日英両対応 |
| テスト追加 | `parsers.test.js` に [INSPECT] 5件・[DHCPD] 5件の計10件を追加。総テスト数 55件、全 PASS |
| README / GitHub Pages | README.md・README.ja.md・index.html・index.ja.html を最新機能（dnsmasq / [INSPECT] / [DHCPD] / データソースタブ）に対応して更新 |
| ASH セキュリティスキャン | `ash --mode local` 実行。bandit・checkov・detect-secrets・npm-audit・semgrep 全ツール PASS（actionable: 0） |

### 2026-06-07 セッション（リファクタリング）で完了した実装

| 項目 | 内容 |
|------|------|
| P0-2 persistSecret() | ASUS/Yamaha/Slack の secret 保存処理を `persistSecret(section, updates)` 1関数に集約。3箇所の raw JSON read→write を置き換え |
| P0-3 テスト分離 | `npm test` は unit のみ（141件）。実機依存 integration テストは `RUN_INTEGRATION=1 npm run test:integration` で opt-in |
| P0-4 upload 制限 | 100MB 超のバックアップアップロードを受信中に検知して 413 を返す（全バッファ後ではなくストリーミングチェック） |
| P1-1 dnsmasq テスト | `parsers.test.js` に7件追加。query[A/AAAA]/reply IPv4/CNAME/NODATA/169.254.x.x ルーター代理 IP を網羅 |
| P1-2 tail-helper | `src/pollers/tail-helper.js` で `createTailPoller()` ファクトリを実装。inspect/dhcpd/dnsmasq 3 poller を各 ~45 行に削減 |
| P1-3 recordConnection() | `recordConnection(session, now)` をserver.jsに追加。Yamaha poll と [INSPECT] handler の重複 enrich+upsert+notify ロジックを統合 |
| P1-4 src/devices.js | SQLite `devices` テーブルで ip/mac/vendor/dnsName/mdnsName/ipv6/firstSeen/lastSeen/sources を集約。起動時に接続履歴からシード |
| P1-5 端末一覧タブ | `GET /api/devices` API（NDP IPv6付き）と「🖥 端末一覧」ビューを追加。検索・ソート・更新ボタン対応 |
| P1-6 API 可観測性 | `src/enrichment.js` に apiStats（rdap/geo/ptr の ok/fail/lastOkAt/lastError）追加。`GET /api/status` で公開 |
| テスト追加 | history.test.js 11件・devices.test.js 9件追加。総テスト数 150件、全 PASS |
| 端末一覧 詳細パネル | 行クリックで右側に詳細パネル表示（ベンダー/DNS/mDNS/NetBIOS/IPv6/ソース/初回・最終確認）。メモ編集・保存・「🔍 自動調査」ボタン（調査結果をメモ欄に追記） |
| 端末一覧 列フィルタ | 列ヘッダーの🔍アイコンで通信ログ同様の popup フィルタ（含む/で始まる/で終わる/正規表現）。フィルタ有効時にアイコンをハイライト・「フィルタ解除」ボタン表示 |
| 右パネル → 端末一覧連動 | ASUS クライアントカードクリック時に端末一覧タブを表示中なら IP フィルタを適用。解除バッジ付き |
| 端末一覧 メモ欄 | min-height 80px → 160px（2倍）に拡大 |

---

## 🔧 2026-06-07 ローンチ後リファクタリング・品質改善

ローンチ後に機能追加を続けるための技術的負債整理。全面改修ではなく、動作を変えない小さな PR に分けて進める。

### P0 — 先に片付ける（事故防止・テスト安定化）

| # | 項目 | 理由 | 完了条件 |
|---|------|------|----------|
| ✅ P0-1 | `server.js` の責務分割（設定・API・Socket.IO・poller 起動） | 1074 行に設定、認証、ルーティング、履歴更新、通知、起動処理が集中しており、変更時の影響範囲が読みにくかった | テスト先行で進行（2026-06-07 完了）。`src/notes.js`（純粋モジュール）/ `src/config.js`（ファイル I/O のみ）/ `src/runtime.js`（`recordConnection`・`resolveMacByIp`・`handleInspectSession`・io を DI）/ `src/investigation.js`（自動調査キュー）/ `src/routes/*.js`（auth/notes/connections/devices/backup/config/slack 7ファイル）に分割。server.js を 1074行 → 433行に削減。新テスト 42件追加（notes 14件 / config 5件 / runtime 12件 / middleware 4件 / 既存 + デバイスタブテスト）。194テスト全グリーン |
| ✅ P0-2 | config / secret 保存処理を一本化 | Yamaha/ASUS/Slack の secret 維持処理が複数箇所に散っており、将来の上書き事故が起きやすい | `persistSecret(section, updates)` を server.js に追加。ASUS/Yamaha/Slack の3箇所の raw write をすべて置き換え済み |
| ✅ P0-3 | integration test を実機あり/なしで分離 | `npm test` が実機ルーター接続前提になっており、通常環境では失敗する | 実機テストは `RUN_INTEGRATION=1 npm run test:integration` で opt-in。`npm test` は unit のみ実行 |
| ✅ P0-4 | backup upload のサイズ制限を実装 | コメントでは 100MB 制限だが、現状は受信 chunk を全てメモリに積む | `UPLOAD_MAX_BYTES = 100MB`。受信中に累積サイズをチェックし、超過時は 413 を返す |

### P1 — 保守性・回帰防止

| # | 項目 | 理由 | 完了条件 |
|---|------|------|----------|
| ✅ P1-1 | dnsmasq-log parser の unit test 追加 | 実ログ形式、CNAME チェーン、NODATA、router 代理 IP の回帰を防ぐ | `test/unit/parsers.test.js` に7件追加。query[A/AAAA]/reply/CNAME/NODATA/169.254.x.x を網羅 |
| ✅ P1-2 | poller 共通ライフサイクルの整理 | `start/stop/reconnect`、tail 再試行、enabled 状態管理が poller ごとに増えている | `src/pollers/tail-helper.js` で `createTailPoller()` ファクトリを作成。3 poller すべてを ~45 行に削減 |
| ✅ P1-3 | 履歴・enrichment 更新ロジックの共通化 | Yamaha poll と INSPECT handler に、接続履歴 upsert、通知、未知デバイス検出、非同期 enrichment が重複している | `recordConnection(session, now)` を server.js に追加。両ハンドラから利用 |
| ✅ P1-4 | device table / inventory を作る | ASUS/DHCPD/ARP/NDP/NAT/INSPECT/DNSMASQ/mDNS から十分な端末情報が取れているが、現状は接続履歴・メタ情報・notes に分散している | `src/devices.js` 追加。`devices` テーブル（SQLite）で ip/mac/vendor/names/ipv6/firstSeen/lastSeen/sources 集約。起動時に接続履歴からシード。9件ユニットテスト追加 |
| P1-5 | `deviceId` と観測値ベースの名寄せを導入 | IP は DHCP で変わり、MAC もプライバシーMAC/仮想NICで変わるため、どちらも安定した主キーにならない。端末一覧・メモ・信頼状態を長期的に安定させるには内部IDが必要 | `deviceId` を発行し、`devices` は内部ID中心に変更。IP/MAC/IPv6/hostname/mDNS/NetBIOS/ASUS名/Bonjour/観測ソースを `device_observations` または同等構造に保持。明確な一致だけ自動統合し、曖昧な一致は confidence と merge候補として扱う。手動 merge/split の余地を残す |
| ✅ P1-6 | 端末一覧ビューを追加 | Widemap は既に端末情報を多く取得しているが、現状はグラフ/通信ログ中心で「LAN内に何がいるか」を一覧で確認しづらい | `GET /api/devices` 追加（NDP IPv6付き）。UI に「🖥 端末一覧」タブ追加。IP/MAC/ベンダー/名前/IPv6/ソース/初回・最終確認。検索・列フィルタ・ソート対応。行クリックで詳細パネル（メモ編集・自動調査）。右サイドバーからの IP フィルタ連動 |
| ✅ P1-7 | 外部 API 依存の可観測性を改善 | RDAP/Geo/Threat feed の失敗がユーザーから見えにくい | `src/enrichment.js` に `apiStats` 追加。rdap/geo/ptr の ok/fail/lastOkAt/lastFailAt/lastError を `GET /api/status` で公開 |

### P2 — 余裕ができたら

| # | 項目 | 理由 | 完了条件 |
|---|------|------|----------|
| P2-1 | `public/index.html` の段階分割 | 単一 HTML に CSS/JS/UI が集中しており、UI 改修が重くなりやすい | まず CSS/JS を別ファイル化。ビルドツール導入は必要になるまで保留 |
| P2-2 | API 入力バリデーションの共通化 | route ごとに個別 validation が増えている | IP、MAC、timestamp、retention、logFile などの validator を `src/utils` か専用モジュールへ集約 |
| P2-3 | ログ出力の整備 | `console.log/error` が中心で、重要度やカテゴリ検索がしづらい | logger ラッパーを追加し、カテゴリ・level・必要なら JSON 出力に対応 |
| P2-4 | Socket.IO 初期 emit の削減 | 接続時に直近24h分の接続履歴を全件 emit するため、データが増えると初期 polling ペイロードが肥大化（実測 450〜900KB）。2026-06-07 に確認 | 初期 emit を直近1h に短縮し、追加データは `/api/connections` API で取得させる |
| P2-5 | `/api/connections` 全期間フェッチの上限設定 | 「全期間」選択時に `from`/`to` なしでリクエストされ、2年分全データ（実測 15MB）を毎回返す。データ増加とともに肥大化が続く。2026-06-07 に確認 | デフォルト上限（件数 or 期間）を設ける。「全期間」はページネーションまたは `all=1` の明示フラグを要求。**⚠️ 優先度低め**: 「全期間を見たい」ユーザーに全データを返すのは本質的に正しい。地図・グラフは「宛先IP×件数の集計値」で十分なため、全レコードを返さない設計に変えることで軽減可能。テーブルはページネーション対応で対処できる。現状43,000件程度（実測15MB）なら実用上問題なく、数十万件規模になってから対処すれば十分。「表示に必要な粒度」と「ストレージの粒度」を分離するのが根本解（2026-06-08 洞察） |
| ✅ P2-6 | Socket.IO 定常 push のデータ量削減 | widemap を開いている間の定常通信が実測 1,300 KB/s と想定より多い。60秒ごとに24h分全件（~10,000件）を送信していた。2026-06-07 に確認 | `lastPollEmitTime` / `lastInspectEmitTime` を導入し、前回 emit 以降に `lastSeen` が更新されたエントリのみ差分送信。差分ゼロ時は emit をスキップ。差分件数は 166〜399件/回（全件の約2〜4%）、帯域削減率 **96〜98%**（~50KB/s → ~1.3KB/s）。テスト5件追加。2026-06-08 完了 |
| ✅ P2-7 | geo エラー時のリトライ抑制 | ip-api.com がレートリミットで空レスポンスを返した際に `[geo] batch error` が連続発生。2026-06-07 に確認 | エラー時に未キャッシュ IP を 30 分間リトライ抑制。DB にも保存するため再起動後も有効。2026-06-08 完了 |
| ✅ P2-8 | RDAP / Geo キャッシュの SQLite 永続化 | 再起動のたびにキャッシュがリセットされ、全 IP 分の RDAP/Geo フェッチが走っていた（実測 ~20 回/分）。ip-api.com のレートリミット超過の一因 | `rdap_cache` / `geo_cache` テーブルを `.widemap.db` に追加。起動時に有効エントリを復元。2026-06-08 完了 |
| ✅ P2-9 | 起動時 RDAP フェッチを 5並列 throttle に変更 | `pollYamahaConnections` が全 IP を一斉並列フェッチしており、スパイク時に rdap.arin.net への負荷が集中 | `lookupRdapBatch(ips, concurrency=5)` を追加。5件ずつ await して順次処理。キャッシュヒット時は即座にスキップ。2026-06-08 完了 |
| ✅ P2-10 | `[INSPECT]` ハンドラの RDAP throttle 適用 ＋ キャッシュスタンピード解消 | `handleInspectSession` は `lookupRdap` を直接呼ぶため throttle が効かない。また同一 IP への並行リクエストがキャッシュ書き込み前に複数走り、同じ IP が5分で3回フェッチされる事象を確認（2026-06-08）。ip-api.com 無料制限（45回/分）を超えている可能性 | `lookupRdapBatch` 経由への変更より根本的な解として `lookupRdap()` 自体に in-flight dedupe を実装。`inFlightRdap = Map<ip, Promise>` で全呼び出し元（Yamaha poll / INSPECT / 自動調査）を自動保護。`rdapGeneration` カウンターで restore 中の旧 Promise が新 DB/cache に書き込む race も解消。finally() での `=== p` チェックで旧 Promise が新 Promise を消す race も修正。2026-06-08 完了 |

---

## 📦 接続履歴のオンデマンドロード（#3++）

### 現状の問題

WebSocket 接続時に `connectionHistory` 全件を一括送信している。2年保存 × 活発な環境では10万件超になりブラウザが重くなる。

### 実装方針

**① 初回送信を直近24hに絞る（server.js）**

```js
// 変更前
socket.emit('connections-update', { connections: [...connectionHistory.values()] });

// 変更後
const cutoff = Date.now() - 24 * 60 * 60 * 1000;
const recent = [...connectionHistory.values()].filter(c => c.lastSeen >= cutoff);
socket.emit('connections-update', { connections: recent, partial: true });
```

**② REST API を追加（server.js）**

```
GET /api/connections?from=<timestamp>&to=<timestamp>
```

SQLite の `idx_lastSeen` インデックスが既にあるので高速。レスポンスは `{ connections: [...], total: N }`。

**③ 時間フィルターと連動（public/index.html）**

- 時間フィルター変更時 → `GET /api/connections?from=...&to=...` を叩いてグラフ・地図を再描画
- リアルタイムの新着は引き続き WebSocket 差分 push を維持
- `partial: true` 受信時は「過去24時間を表示中」などの件数表示を追加

### テスト方針

**`test/unit/history.test.js`** ✅ 2026-06-07 実装済み（11件 PASS）

| # | テスト内容 | 状態 |
|---|-----------|------|
| 1 | `from`〜`to` 範囲内のエントリだけ返る | ✅ |
| 2 | 範囲外（古すぎ・新しすぎ）は含まれない | ✅ |
| 3 | `from` 省略時は全件返る | ✅ |
| 4 | 件数0件でも空配列を返す（エラーにならない） | ✅ |
| +  | 境界値テスト（from/to ちょうどの値を含む） | ✅ |

**24h フィルター（partial: true ロジック）**

| # | テスト内容 | 状態 |
|---|-----------|------|
| 5 | 24h 超のエントリが queryByTimeRange で除外される | ✅ |
| 6 | 24h 以内のエントリが queryByTimeRange で含まれる | ✅ |
| 7 | in-memory Map フィルター（WebSocket emit 相当）が DB と一致 | ✅ |

REST エンドポイントのテストは Express ごと起動が必要で重いため手動確認で十分。フロントの時間フィルター連動はブラウザテストが必要なためスコープ外。

### 工数見積もり

| 作業 | 時間 |
|------|------|
| REST エンドポイント追加 | 1〜2h |
| WebSocket 初回送信を絞る | 1h |
| フロントの時間フィルターと API を連動 | 4〜5h |
| `partial: true` 時の UI 表示 | 1〜2h |
| テスト作成 | 1〜2h |
| **合計** | **8〜12h** |

---

## 🛡️ C2/Botnet 検出 Phase 1 — 外部フィード突合

### 概要
Yamaha NAT セッションの宛先 IP/ドメインを、既知の脅威インテリジェンスフィードと突合して
**C2 サーバ / Bot ネットワーク / マルウェア配布元** との通信を検出・ハイライト表示する。

### 推奨スタートライン（Phase 1）

無料・API キー不要・サーバ負荷小で最も効果が高い組み合わせ：

| ソース | 取得 | 内容 |
|--------|------|------|
| **Feodo Tracker** (`https://feodotracker.abuse.ch/downloads/ipblocklist.csv`) | 1時間ごと | Emotet/Dridex/TrickBot 等の C2 サーバ IP |
| **ThreatFox** (`https://threatfox.abuse.ch/export/csv/ip-port/recent/`) | 1時間ごと | マルウェア IOC（IP:port） |
| **URLhaus** (`https://urlhaus.abuse.ch/downloads/csv_recent/`) | 1時間ごと | マルウェア配布 URL（ドメイン突合用） |
| **Spamhaus DROP** (`https://www.spamhaus.org/drop/drop.txt`) | 1日ごと | ハイジャック済み IP 範囲（CIDR） |

### 実装方針

```
[起動 + 1時間ごと]
  fetchThreatIntel() → 全フィードを並列ダウンロード → IPセット/CIDRトライに保持

[NAT poll 後]
  for c of latestConnections:
    if threatHit = matchThreatIntel(c.dst, c.dstHost):
      c.threat = threatHit  // {source: 'feodo', tag: 'Emotet C2'}

[クライアント]
  - グラフ：threat のあるノードを 🚨 赤強調
  - 地図：弾道アークを赤に
  - 接続パネル：行に 🚨 アイコン
  - 統計：「危険な接続先」セクション追加
  - ヘッダーに警告バッジ（今日検出した件数）
```

---

## 🛡️ C2/Botnet 検出 Phase 2/3 — パターン分析・API 連携

> **前提**: Phase 2 のビーコン検出は過去データの参照が必要なため、SQLite 化が完了していることが前提。
> Phase 1 の運用実績（誤検知率・検出数）を確認してからチューニングに入ること。

### Phase 2: 通信パターン分析（外部フィード不要）

| 検出 | 手法 |
|------|------|
| **Beaconing** | 同じ (src,dst,port) に一定間隔（±10%）で複数回観測 → C2 ハートビート疑い |
| **DGA ドメイン** | dstHost の文字エントロピー計算（Shannon）が閾値超 |
| **DNS exfiltration** | dst:53 への大量クエリ（連続秒数） |
| **異常ASN/国** | 通常通信しない国・無名VPS業者への接続が初出 |
| **データ exfil** | 単一宛先への長時間 upload 集中（要 Yamaha トラフィック統計） |

#### ビーコン検出 実装方針（#4++）

**なぜ現状のスキーマでは検出できないか**

現在の `connections` テーブルは `firstSeen` / `lastSeen` の2点のみで、通信の時系列が取れない。
ビーコン検出には「いつ、何回見えたか」の時系列が必要。

**スキーマ追加**

```sql
CREATE TABLE connection_events (
  src   TEXT NOT NULL,
  dst   TEXT NOT NULL,
  dport INTEGER NOT NULL,
  proto TEXT NOT NULL,
  ts    INTEGER NOT NULL,
  PRIMARY KEY (src, dst, dport, proto, ts)
);
CREATE INDEX idx_ce_src_dst ON connection_events(src, dst, dport, proto, ts);
```

ポーリング時に「この接続が今回見えた」タイムスタンプを記録。古いイベント（例：30日超）は定期削除。

**検出アルゴリズム**

```
1. src→dst ペアごとに直近イベントのタイムスタンプ列を取得
2. 隣接間隔リストを計算（差分）
3. 平均間隔・標準偏差を算出
4. stddev / mean < 0.15（変動15%以内）
   かつ 観測回数 ≥ 5
   かつ 観測期間 ≥ 3日（偶然の一致を除外）
   → ビーコン疑いとしてフラグ
```

**誤検知対策（難所）**

NTP・OS telemetry・広告 SDK なども一定間隔で通信するため、以下で絞る：
- 既知良性ドメインのホワイトリスト（`time.apple.com`, `*.windows.com` 等）
- 最低観測期間 3日以上（短期偶然を除外）
- 脅威フィード未検出かつ RDAP 大手（Google/Apple/Microsoft/Amazon）は除外

**設定 ON/OFF**

`autoInvestigate` と同じパターンで実装：
- `server.js` に `let beaconDetect = false` を追加
- `saveConfig()` / `loadConfig()` に含める
- 設定 UI の「検出」タブに「ビーコン検出」トグルを追加
- ポーリングループ内で `if (!beaconDetect) return` するだけ

**工数見積もり**

| 作業 | 時間 |
|------|------|
| スキーマ追加 + ポーリング側の記録 | 2〜3h |
| 分析ロジック + Slack アラート | 2〜3h |
| UI 表示（バッジ・フィルタ）+ 設定 ON/OFF | 2〜3h |
| 誤検知チューニング（ホワイトリスト等） | 5〜10h |
| **合計** | **11〜19h** |

誤検知対策を「最低限動く」レベルに留めれば 10h 以内。実用レベルは運用しながら継続チューニング。

### Phase 3: API key を使った精密判定

| サービス | 機能 | コスト |
|---------|------|-------|
| **AbuseIPDB** | IP毎の悪意度スコア (0-100) | 無料 1,000/日 |
| **AlienVault OTX** | コミュニティ IOC + リッチコンテキスト | 無料アカウント |
| **VirusTotal** | URL/IP/ドメイン マルチエンジン判定 | 無料 4req/min |

→ 自動調査ノードの結果に「Threat: ...」セクションとして追記

### UI 案

- **設定 → 一般**: 「☑ 脅威検出を有効化」「☑ Phase2 ヒューリスティック」「API キー（任意）」
- **ヘッダー右**: 過去24時間の検出件数バッジ（赤）
- **グラフ・地図**: 該当ノードを赤枠＋脈動アニメ
- **通信先パネル**: 行頭に 🚨、ホバーで Threat 詳細
- **統計タブ**: 「危険な接続先 Top」を新規追加

### 留意点

- **誤検知対策**: フィード由来情報には source/timestamp/confidence を保持し、UI で出典明示
- **プライバシー**: 外部 API への dst IP 送信は AbuseIPDB/VT などのみ、Spamhaus/Feodoはローカル突合のみ
- **負荷**: ThreatIntel ダウンロードは IPv4-first（npm install と同じ問題回避）
- **URLhaus は IP ではなくフル URL/パスで突合すること**: `185.199.109.133`（GitHub Pages CDN）のような共有 CDN の IP 自体はクリーンだが、URLhaus には `github.com/.../*.zip` 形式の悪性 URL が多数登録されている。IP でブロック・検出すると GitHub Pages 全体が誤検知になるため、URLhaus フィードの突合は `c.dstHost + path` のフル URL 単位で行う必要がある（2026-06-06 実機調査で確認）。

---

## 🌐 IPv6 セッション収集

> ⚠️ **Nuro 光 + Yamaha RTX 環境での制約（2026-06-06 実機確認済み）**:
> RA Proxy モードへの切り替え（`no lan pass-through member 1 lan2 lan1`）を実施したところ、
> IPv6 通信が完全に途絶した。Nuro ONU（ZXHN 系）が RA Proxy と非互換と判明。
> **現環境では `show ipv6 connection` による L3 セッション追跡は不可能。**
> 代替策: ミラーポート + tcpdump 方式（下記）、または OpenWrt（conntrack が IPv6 標準対応）で回収する。

### 背景（実機調査結果）

Yamaha RTX1300 の LAN2 パケット数を確認したところ、IPv6 トラフィックが全体の約 36% を占めていることが判明。現在の Widemap はこれを**完全に見えていない**。

```
LAN2 受信パケット:
  IPv4: 115,434,707
  IPv6:  65,190,208  ← 全体の約 36%
```

現在の IPv6 設定（`show config | grep ipv6` 実機確認済み）：
```
ipv6 routing on
ipv6 route default gateway dhcp lan2   ← Nuro ONU から IPv6 デフォルトルート取得
ipv6 prefix 1 ra-prefix@lan2::/64      ← Nuro ONU の RA からプレフィックス取得
ipv6 lan1 address ra-prefix@lan2::1/64
ipv6 lan1 rtadv send 1 o_flag=on       ← LAN1 デバイスへ RA 配信（SLAAC）
ipv6 lan1 dhcp service server
lan pass-through member 1 lan2 lan1    ← LAN2（WAN）↔ LAN1 を L2 ブリッジ
lan pass-through ethertype 1 ipv6      ← IPv6 を L2 パススルー
```

### なぜ現状では ipv6 filter dynamic が効かないか

`lan pass-through ethertype 1 ipv6` は IPv6 フレームを **L2（Ethernet レベル）** で素通りさせる。
Yamaha 公式ドキュメントに「**中継するパケットに IP フィルターの精査は行われません**」と明記されており、
`ipv6 filter dynamic` を追加しても pass-through パケットには適用されない。

### 解決策：RA Proxy モードへの切り替え

`lan pass-through` の代わりに **RA Proxy**（L3 ルーティング）を使うと `ipv6 filter dynamic` が有効になる。

| 方式 | レイヤー | filter dynamic | セッション追跡 |
|------|---------|:-:|:-:|
| `lan pass-through ethertype ipv6`（現状） | L2 ブリッジ | ❌ | ❌ |
| **RA Proxy**（`ra-prefix@lan2`） | L3 ルーティング | ✅ | ✅ |

**重要**: RA Proxy の核心設定（`ipv6 prefix 1 ra-prefix@lan2::/64` と `ipv6 lan1 rtadv send 1`）は**すでに存在している**。
`lan pass-through` の2行を削除するだけで RA Proxy モードに切り替わる可能性がある。

### Nuro光 での切り替え手順（要メンテナンスウィンドウ）

```
# 削除する設定（2行）
no lan pass-through member 1 lan2 lan1
no lan pass-through ethertype 1 ipv6

# 追加する設定
ipv6 filter dynamic 100 * * ftp
ipv6 filter dynamic 101 * * domain
ipv6 filter dynamic 102 * * www
ipv6 filter dynamic 103 * * https
ipv6 filter dynamic 104 * * smtp
ipv6 filter 1000 pass * * * * *
ipv6 lan2 secure filter out 1000 dynamic 100 101 102 103 104

# 確認
show ipv6 connection   ← セッションが出れば成功
```

> ⚠️ **Nuro光 固有リスク**: Nuro ONU（ZXHN F2886Q 等）は独自構成のため、
> `lan pass-through` 削除後に IPv6 接続が切れる可能性がある。
> 必ず `save` 前に動作確認し、切断時は `no ipv6 filter dynamic ...` で元に戻せるよう準備すること。

### Widemap 側の実装（Yamaha 側設定変更後）

**ポーラー追加:**
```
show ipv6 connection  ← IPv4 の show nat descriptor に相当
```

**パーサー拡張:**
現在の `parseNatDetail`（`server.js:388`）は IPv4 専用（`.` で IP とポートを分割）。
IPv6 アドレス（`2001:db8::1` 形式）に対応した別パーサーが必要。

```js
// IPv6 セッション行のフォーマット例（要実機確認）
// TCP  2001:db8::1.12345  2404:6800::1.443  ESTABLISHED
```

### 留意点

- IPv6 は NAT なし → src が LAN 内の GUA（`2001:`）または ULA（`fc00:`/`fd00:`）
- パーサーの `src.startsWith('192.168.')` フィルターを IPv6 アドレス判定に拡張する
- OpenWrt は conntrack が IPv6 を標準サポートするため、OpenWrt 対応時に同時実装可能（こちらはリスクなし）

### 代替案: ミラーポート + tcpdump（RA Proxy 不可時）

Nuro 光 ONU が RA Proxy と非互換であることが判明（2026-06-06 実機確認済み: `no lan pass-through member 1 lan2 lan1` で IPv6 通信断）。
`lan pass-through` を維持したまま IPv6 通信先を可視化するには、ミラーポートでパケットキャプチャする。

**RTX1300 設定:**
```
lan port-mirroring lan2 lan1:1 in
```

**監視マシン（Pi/Mac）:**
```bash
# LAN ポート 1 にケーブル接続し、IPv6 フローを抽出
sudo tcpdump -i eth0 ip6 -n -l | \
  awk '/^[0-9]/ {print $0}' > /tmp/ipv6-flows.log

# または Widemap に直接送る形:
# tshark -i eth0 -f "ip6" -T fields -e ipv6.src -e ipv6.dst -e tcp.dstport -e udp.dstport
```

**Widemap 実装（将来）:**
- `src/pollers/mirror.js` — tcpdump/tshark 出力をパースし、IPv6 セッションを組み立てる
- 既存の enrichment パイプライン（GeoIP・RDAP）をそのまま適用
- IPv6 バッジを「緑」に切り替え（通信先が見えるようになったため）

**必要機器:**
- 管理型スイッチ or RTX の LAN ポートミラー機能
- 常時稼働の監視マシン（Raspberry Pi 等）
- Widemap のある Mac/EC2 とは別マシンでも可（tcpdump → Widemap API に POST）

---

## 🪞 IPv6 通信先可視化（パケットミラー方式）

### 概要

`lan pass-through` を維持したまま（Nuro 光互換）、RTX のミラーポート機能で IPv6 パケットを別マシンにコピーし、
tcpdump/tshark でフロー情報（送信元 IPv6 ↔ 宛先 IPv6、ポート、プロトコル）を抽出する。
RA Proxy が使えない環境での唯一の IPv6 通信先可視化方法。

### なぜ動くか

`lan port-mirroring` は L2 レベルでフレームをコピーする。`lan pass-through` も L2 で通過させている。
つまりミラーには IPv6 フレームがそのまま届く（pass-through とミラーリングは独立した機能）。

### RTX1300 設定

```
lan port-mirroring lan2 lan1:1 in
```

- `lan2` の受信パケットを `lan1:1`（LAN ポート 1）にミラー
- LAN ポート 1 に監視マシン（Raspberry Pi 等）を接続

### 監視マシン側

```bash
# 方式 A: tshark でフィールド抽出（推奨）
tshark -i eth0 -f "ip6" -T fields \
  -e frame.time_epoch -e ipv6.src -e ipv6.dst \
  -e tcp.srcport -e tcp.dstport -e udp.srcport -e udp.dstport \
  -l | node /path/to/widemap/scripts/ipv6-ingest.js

# 方式 B: tcpdump で生ログ → 定期パース
sudo tcpdump -i eth0 ip6 -n -tt -q > /tmp/ipv6-capture.log
```

### Widemap 実装

- `src/pollers/mirror.js` — tshark 出力をストリームパースし、IPv6 セッションを生成
- セッション形式は既存 IPv4 と同一: `{ src, dst, sport, dport, proto }`
- 既存 enrichment（GeoIP・RDAP）をそのまま適用
- IPv6 バッジを灰色 → 緑に切り替え（通信先が見えるようになったため）
- connectionHistory に IPv6 セッションも UPSERT

### 必要機器

| 機器 | コスト | 備考 |
|------|--------|------|
| Raspberry Pi (4/5) | ¥5,000〜10,000 | 常時稼働、低消費電力 |
| LANケーブル | ¥0（手持ち） | RTX LAN ポート 1 → Pi |

### 前提条件

- RTX1300 の LAN ポートに空きが 1 つ以上ある
- 監視マシンが Widemap バックエンドと通信可能（同一 LAN or localhost）
- `tshark` または `tcpdump` がインストール済み

### 留意点

- ミラーは WAN 側の受信のみ（`in`）→ LAN → WAN の送信は別途 `out` を追加すれば取れる
- 大量トラフィック時は Pi の処理能力がボトルネック（100Mbps 程度まで実用的）
- Widemap 本体とは分離可能（Pi → HTTP POST → Widemap API）

---

## ✅ 接続履歴ストレージの SQLite 化（完了）

### 概要
現在の JSONL ファイル（`.widemap.connections.jsonl`）を SQLite に置き換え、
長期保存（2年）・重複排除・高速検索を実現する。

### 動機
- JSONL は append + snapshot で同一キーの重複が大量発生し、ファイルが肥大化する
- compactHistory の仕組みが複雑で、クラッシュ時にデータ不整合のリスクがある
- 2年保存の場合でも SQLite なら小規模オフィスで 1GB 未満に収まる見込み
- WAL モードにより書き込み中クラッシュでも自動リカバリされる

### なぜ SQLite か（RDS/DynamoDB 等を使わない理由）
- 単一ユーザー・単一ノードで動くローカルツールであり、クラウド DB は過剰
- ネットワーク障害時でもログを書き続ける必要がある（外部 DB だと本末転倒）
- AWS コストが毎月発生する（このツールの用途に見合わない）
- セットアップの敷居が上がる（`npm install && npm start` で動く手軽さを維持したい）
- レイテンシ: ローカル SQLite は数μs、RDS は数ms（リアルタイム表示に影響）
- 将来マルチテナント SaaS にする予定はない

### 変更対象（server.js 内）
- `loadConnectionHistory()` → SQLite SELECT に置換
- `appendHistoryLog()` → SQLite UPSERT に置換
- `snapshotHistory()` → 不要（削除）
- `compactHistoryLog()` → 不要（削除）
- `connectionHistory` Map → メモリキャッシュとして残すか、SQLite を直接参照するか要検討

### スキーマ案
```sql
CREATE TABLE connections (
  src       TEXT NOT NULL,
  dst       TEXT NOT NULL,
  dport     INTEGER NOT NULL,
  proto     TEXT NOT NULL,
  sport     INTEGER,
  ttl       INTEGER,
  srcMac    TEXT,
  srcVendor TEXT,
  srcDnsName  TEXT,
  srcMdnsName TEXT,
  dstHost   TEXT,
  country   TEXT,
  org       TEXT,
  lat       REAL,
  lon       REAL,
  city      TEXT,
  firstSeen INTEGER NOT NULL,
  lastSeen  INTEGER NOT NULL,
  PRIMARY KEY (src, dst, dport, proto)
);
CREATE INDEX idx_lastSeen ON connections(lastSeen);
CREATE INDEX idx_src ON connections(src);
CREATE INDEX idx_dst ON connections(dst);
```

### バックアップ・リカバリ
- WAL モード有効化（`PRAGMA journal_mode = WAL`）
- 日次バックアップ: `db.backup()` で 7 世代保持
- 起動時 `PRAGMA integrity_check` → 失敗時は最新バックアップから自動復旧
- バックアップなし + 破損時は空 DB で再スタート（動作継続優先）

### マイグレーション
- 初回起動時に既存 `.widemap.connections.jsonl` を検出したら自動インポート
- インポート完了後、JSONL ファイルを `.jsonl.migrated` にリネーム

### 依存追加
- `better-sqlite3`（ネイティブモジュール、npm install でビルド）

### 留意点
- フロントエンドへの `io.emit('connections-update', ...)` インターフェースは変更なし
- `connectionHistory` Map をメモリに残す場合、起動時に SQLite から全件ロードする（現状と同じ動作）
- TTL 超過エントリの削除は日次バッチで `DELETE WHERE lastSeen < ?`


---

## 🖥️ macOS メニューバーアプリ化

### 概要
Swift ネイティブの menubar アプリとして構築。メニューバーにアイコンを常駐させ、
バックエンド（Node.js server.js）の起動/停止、ブラウザでのUI表示をワンクリックで行う。

### メニュー構成
```
🌐 Widemap アイコン
 ├─ 🚀 ツール起動（ブラウザで開く）
 ├─ ▶️  バックエンド開始
 ├─ ⏹  バックエンド停止
 ├─ ⚙  設定...（ポート番号・ルーターIP変更）
 ├─ 📊 ステータス: 稼働中 (N接続)
 ├───────────────
 ├─ ℹ️  About Widemap
 └─ ❌ 終了
```

### 動作
- アプリ起動 → メニューバーにアイコン表示（Dockには出ない）
- 「バックエンド開始」→ 内蔵の `node server.js` を子プロセスで起動
- 「ツール起動」→ デフォルトブラウザで `http://localhost:<port>` を開く
- 「バックエンド停止」→ 子プロセスに SIGTERM を送る
- 「設定」→ ポート番号やルーターIPを変更するミニウィンドウ

### 設定
- ポート番号: ユーザーが自由に選択可能（デフォルト 3000）
- ルーターIP: 設定画面から変更可能

### 配布
- `brew install --cask widemap` で配布（Homebrew Cask）
- または `.dmg` を GitHub Releases に置く
- Node.js は前提条件: `brew install node`（アプリにはバンドルしない）

### コード署名
- Apple Developer Program（Individual）に登録: $99/年
- 登録名: **Yoichi Takizawa**（法的な本名が必須、ハンドル名不可）
- 署名表示例: `Developer ID Application: Yoichi Takizawa (XXXXXXXXXX)`
- 署名なしだと「開発元を確認できません」警告が出るため取得推奨

### 技術選定理由
- Swift ネイティブ → 軽量（5MB以下）
- メニューバーのみの「ヘッドレス」アプリとして自然
- Node.js バックエンドは Process で起動/停止するだけ
- ブラウザ起動は `NSWorkspace.shared.open(URL)` 一行

---

## 🌍 conntrack 対応（OpenWrt / ASUS ルーターモード / Ubiquiti UDM）

### 概要
Yamaha RTX に加え、conntrack インターフェース（`/proc/net/nf_conntrack`）を持つ Linux ベースのルーターから NAT セッション＋WiFi クライアント情報を取得できるようにする。
共通の conntrack パーサーで複数機種を一括対応し、対応ルーターの幅が大幅に広がる。

### 対応ルーター一覧とファームウェア変更要否

| ルーター | 接続方法 | 取得インターフェース | ファームウェア変更 | 備考 |
|---------|---------|------------------|-----------------|------|
| **Yamaha RTX** | SSH | `show nat descriptor` （独自コマンド） | ❌ 不要 | すでに対応済み |
| **ASUS（ルーターモード）** | SSH | `/proc/net/nf_conntrack` | ❌ 不要 | 標準ファームウェアにカーネルインターフェースあり。Merlin 推奨だが **Merlin 不要** で実現可 |
| **OpenWrt** | SSH | `conntrack -L` or `/proc/net/nf_conntrack` | ✅ 必要 | Buffalo/TP-Link 等は OpenWrt フラッシュが前提 |
| **Ubiquiti UDM** | SSH | `/proc/net/nf_conntrack` | ❌ 不要 | SSH は鍵認証のみ（パスワード認証なし）。UDM-Pro・UDM-SE も同様 |

> **ASUS 補足:** 標準ファームウェア（Merlin ではない）でも `/proc/net/nf_conntrack` はカーネルが直接提供するため読み取り可能。
> Merlin は `conntrack -L` コマンドを追加するが、コマンドがなくても `/proc/net/nf_conntrack` を直接 `cat` すれば同じデータが得られる。

### conntrack 共通パーサーの設計

ASUS・OpenWrt・Ubiquiti は全て同じ Linux conntrack 出力フォーマットを持つため、**パーサーを1本共有**できる。

### 前提: server.js モジュール分割（完了済み 🟢）

server.js のモジュール分割は #1 で完了済み。新ルーター対応 = 新ファイル追加で済む構造になっている。

#### 分割案
```
src/
  pollers/yamaha.js      — SSH接続、NATテーブルパース
  pollers/asus.js        — ASUS AP認証、クライアント取得
  pollers/conntrack.js   — ASUS/OpenWrt/Ubiquiti 共通 conntrackパース
  enrichment.js          — DNS逆引き、RDAP、GeoIP
  device-identify.js     — OUI、mDNS、SSDP、NetBIOS、Apple辞書
  history.js             — 接続履歴の保存/読み込み
  api.js                 — Express routes + Socket.IO
server.js                — エントリポイント（組み立てるだけ）
```

#### ポーラー共通インターフェース
```js
// 各 poller が実装するインターフェース
module.exports = {
  name: 'yamaha',           // 識別名
  start(config, callbacks), // ポーリング開始（callbacks.onSessions(sessions) で通知）
  stop(),                   // 停止
  status(),                 // { connected: bool, lastPoll: Date, error?: string }
};
```

#### 進め方（段階的）
1. Yamaha ポーラーを `src/pollers/yamaha.js` に切り出し → 動作確認
2. ASUS ポーラーを `src/pollers/asus.js` に切り出し → 動作確認
3. enrichment / device-identify / history を順次切り出し
4. server.js をエントリポイント（組み立て）のみに
5. OpenWrt ポーラーを新規追加

#### 留意点
- 各ステップで `npm start` して動作確認してからコミット
- public/index.html（フロントエンド）は変更なし
- Socket.IO のイベント名・ペイロードも変更なし（内部リファクタのみ）
- テストがないので、手動確認が必須（将来的にはポーラー単体テストを追加）

#### テスト戦略（モジュール分割と同時進行）

**フレームワーク**: `node:test`（Node.js 標準、依存追加なし）

**ユニットテスト（外部依存なし、高速）:**
| 対象 | テスト内容 |
|------|-----------|
| `parseNatDetail` | Yamaha 出力文字列 → セッション配列 |
| `parseClientList` | ASUS 生データ → クライアント配列 |
| `parseMeshNodes` | AiMesh データ → ノード配列 |
| `parseOuiManuf` | OUI テキスト → MAC ベンダー Map |
| `lookupAppleModel` | モデル ID → 機種名 |
| `inferVendorCategory` | ベンダー名 → カテゴリ |
| `isAllowedRouterIp` | IP → プライベート IP 判定 |
| `htmlEscape` | XSS エスケープ |
| `computeRates` | トラフィック差分計算 |

**統合テスト（実機接続、`.widemap.json` のクレデンシャルを使用）:**
| 対象 | テスト内容 |
|------|-----------|
| Yamaha SSH 接続 | 接続→コマンド実行→結果取得→切断 |
| Yamaha NAT 取得 | `show nat descriptor` 実行→パース→件数 > 0 |
| Yamaha NAT ベースライン比較 | 前回正常時と同オーダーのセッション数か（±50%） |
| Yamaha 再接続 | `yamahaConn.destroy()` で強制切断→自動再接続を確認 |
| ASUS 認証 | ログイン→トークン取得→クライアントリスト取得 |

**ベースライン比較テスト（NAT パース結果の正否判定）:**
- 初回テスト実行時に `test/fixtures/baseline.json` に正常時のメトリクスを保存
  - セッション数、ユニーク送信元数、ユニーク宛先数
- 以降のテストはベースラインとの比較で判定（±50%の範囲なら正常）
- 各セッションに `src`, `dst`, `proto`, `dport` が全て存在することを構造検証
- ベースライン更新: `node --test test/integration/yamaha.test.js -- --update-baseline`

**実行方法:**
```bash
# ユニットテストのみ（CI向き、実機不要）
node --test test/unit/

# 統合テスト（実機接続、.widemap.json 必須）
node --test test/integration/

# 全テスト
node --test
```

**テストファイル構成:**
```
test/
  unit/
    parsers.test.js        — パーサー系ユニットテスト
    utils.test.js          — ユーティリティ関数テスト
  integration/
    yamaha.test.js         — Yamaha SSH 実機テスト
    asus.test.js           — ASUS HTTP 実機テスト
  fixtures/
    nat-detail-sample.txt  — Yamaha NAT 出力サンプル
    client-list-sample.txt — ASUS クライアントリスト出力サンプル
```

### 実機なしで実装可能な範囲（〜8割）

| 項目 | 手法 | 備考 |
|------|------|------|
| NAT セッション取得 | SSH → `conntrack -L` or `cat /proc/net/nf_conntrack` | 出力フォーマットは安定・公開済み |
| WiFi クライアント | SSH → `iwinfo wlan0 assoclist` or `ubus call hostapd.wlan0 get_clients` | RSSI・MAC・TX/RX 取得可 |
| テスト環境 | OpenWrt x86 Docker イメージ（公式配布） | conntrack パーサーのローカルテスト可 |
| パーサー実装 | conntrack 出力サンプルを fixtures として用意 | `src=... dst=... sport=... dport=... ...` 形式 |

### 実機が必要な部分（残り2割）

- 実際の NAT セッション量でのパフォーマンス確認
- WiFi 固有情報（RSSI 等）は VM 上では取れない
- ハードウェア/バージョンごとのコマンド出力の微妙な差異
- ubus の有無・バージョン差（古い OpenWrt は ubus なし）

### 実装方針

1. `conntrack -L` / `/proc/net/nf_conntrack` 共通パーサーを実装（Yamaha NAT パーサーと同じインターフェース）
2. conntrack ポーラー（`src/pollers/conntrack.js`）を追加 — ASUS・OpenWrt・Ubiquiti が全て利用
3. 設定画面に「ルータータイプ: Yamaha RTX / ASUS（標準） / OpenWrt / Ubiquiti UDM」選択を追加
4. **ASUS**: SSH接続後 `cat /proc/net/nf_conntrack` で取得。WiFi クライアントは Web API（`192.168.x.x/appGet.cgi?hook=get_clientlist()`）で取得（既存 ASUS ポーラー流用）
5. **Ubiquiti UDM**: SSH接続に `~/.ssh/id_rsa` 等の鍵認証が必須。設定画面で秘密鍵パスを指定できるようにする
6. Docker OpenWrt x86 イメージで conntrack パーサーの統合テスト
7. 実機ユーザーからのフィードバックで差異を吸収

### ASUS 固有の実装メモ

- SSH デフォルトポート: 22。ルーター管理画面で「Telnet/SSH の有効化」が必要
- `/proc/net/nf_conntrack` の読み取りに root 権限は不要（ルーターにログインするユーザーは通常 root）
- WiFi クライアントリストは既存の ASUS HTTP ポーラー（`appGet.cgi`）を流用できる
- conntrack 取得間隔: 30秒（Yamaha と同じデフォルト）

### Ubiquiti UDM 固有の実装メモ

- SSH ポート: 22。デフォルトで有効
- **鍵認証のみ**。UniFi Network Controller の設定 → Advanced → SSH Keys でユーザーの公開鍵を登録
- `/proc/net/nf_conntrack` で NAT セッション取得
- WiFi クライアントは UniFi API（`/proxy/network/api/s/default/stat/sta`）で取得可能（Cookie 認証）
- 実機なしでもコード実装は可能（出力フォーマットは標準 conntrack と同一）

### conntrack 出力例
```
ipv4     2 tcp      6 117 TIME_WAIT src=192.168.1.100 dst=142.250.196.110 sport=52344 dport=443 src=142.250.196.110 dst=192.168.1.1 sport=443 dport=52344 [ASSURED] mark=0 use=2
ipv4     2 udp      17 29 src=192.168.1.105 dst=8.8.8.8 sport=41234 dport=53 src=8.8.8.8 dst=192.168.1.1 sport=53 dport=41234 [ASSURED] mark=0 use=2
```

### 優先度
高（ASUS・Ubiquiti は実機なしで着手可能。共通パーサー1本で3機種に対応できるコスパの良さ。ユーザー層拡大に直結）

---

## 🚫 通信ブロック（Yamaha RTX / OpenWrt）

### 概要
検出した脅威 IP を SSH 経由でルーターのフィルターに動的に書き込み、通信を遮断する。
手動ブロック（UI ボタン）と自動ブロック（C2 フィード一括投入）の両方をサポート。

### Yamaha RTX：ip filter 書き込み

```bash
# ブロック追加（Widemap 管理ルールは 19000 番台に固定）
ip filter 19001 reject * 142.250.196.110 * * *
ip filter list  ← 確認

# 解除
no ip filter 19001

# 全 Widemap ルール削除（復旧用）
no ip filter 19001
no ip filter 19002
...
```

| 項目 | 内容 |
|------|------|
| 管理番号帯 | 19000〜19999 に固定（既存フィルターと衝突しない） |
| 上限 | RTX1300 は約 1,024 エントリ → 手動ブロックと高優先 C2 IP のみ対象 |
| 復旧 | UI から「全 Widemap フィルター削除」を1クリックで実行 |

### OpenWrt：ipset + iptables

```bash
# 初回セットアップ（OpenWrt 対応インストール時に1度だけ実行）
ipset create widemap_block hash:ip
iptables -I FORWARD -m set --match-set widemap_block dst -j DROP

# ブロック追加（即時反映・ルールリロード不要）
ipset add widemap_block 142.250.196.110

# 解除
ipset del widemap_block 142.250.196.110

# 全解除（復旧）
ipset flush widemap_block
```

| 項目 | 内容 |
|------|------|
| スケール | 数万エントリ対応 → **Feodo/ThreatFox 全リストの自動ブロックが実用的** |
| 適用 | 即時（ファイアウォールリロード不要） |
| 復旧 | `ipset flush widemap_block` 1コマンド |

### Yamaha RTX vs OpenWrt の違い

| | Yamaha RTX | OpenWrt |
|--|--|--|
| 自動ブロック（全フィード投入） | ❌ 上限超え | ✅ ipset で可能 |
| 手動ブロック（個別 IP） | ✅ | ✅ |
| 復旧の容易さ | △ ルール番号管理必要 | ✅ flush 1発 |

### UI 設計

- **手動ブロック**: 接続パネルの行メニューから「この IP をブロック」→ 確認ダイアログ → SSH 実行
- **自動ブロック**: 設定画面に「☑ C2 フィードを自動ブロック（OpenWrt のみ推奨）」オプション
- **ブロック一覧**: 設定画面でブロック中 IP 一覧を表示・個別解除・全解除
- **デフォルト**: 自動ブロックは OFF（誤検知リスクを考慮）

### 安全設計

- 書き込み系 SSH コマンドは UI の明示的な操作時のみ実行（バックグラウンド自動実行は自動ブロック ON 時のみ）
- TTL 付きブロック（デフォルト 24 時間で自動解除）をオプションで設定可能
- Widemap が管理するルールは専用の番号帯・セット名で完全に分離

---

## 🔍 DNS ログ監視（L7 可視化）

### 概要
ルーターの DNS ログを取得し NAT セッションと突合することで、IP だけでは分からない
ドメイン名・サービス名を接続に付加する。パケットキャプチャ不要で IoT デバイスの L7 が見える。

### 取得方法

| 取得元 | 誰が（送信元IP） | 何を（ドメイン） | 備考 |
|--------|:-:|:-:|------|
| **EC2 dnsmasq ログ**（`/var/log/dnsmasq-queries.log`） | ✅ 一部 | ✅ | **既に稼働中・追加設定不要。現行の実装方針** |
| `show dns cache`（Yamaha SSH ポーリング） | ❌ | ✅ | キャッシュは全デバイス共有。送信元IPなし。実装済み |
| Yamaha `syslog debug on` | ❌ | ❌ | **2026-06-07 実機確認: DNS クエリは出力されない。採用しない** |
| OpenWrt dnsmasq ログ | ✅ | ✅ | #4+ で対応 |

### EC2 dnsmasq — 実装方針（採用）

**2026-06-07 実機調査結果:**
- EC2（`YOUR_SERVER_IP:53`）で dnsmasq が稼働中（`/usr/sbin/dnsmasq`）
- `log-queries` が有効 → `/var/log/dnsmasq-queries.log` に蓄積中
- 現時点で **353,344 行・31MB** のクエリログがある
- 一部 LAN デバイスは EC2 dnsmasq に**直接クエリ** → per-client IP が取れる
- 多くのクエリは Yamaha DNS プロキシ経由（`from 169.254.219.142`）→ 個別識別不可

**直接クエリ確認済みデバイス（per-client 取得可能）:**

| IP | デバイス | 根拠ドメイン |
|----|---------|-------------|
| 192.168.41.25 | Philips Hue Bridge | data.meethue.com, diag.meethue.com |
| 192.168.41.69 | ASUS ルーター本体 | dlcdnets.asus.com, routerfeedback.asus.com |
| 192.168.41.111 | Amazon Echo 系 | kinesis.amazonaws.com, exch-apn.amazon.com |
| 192.168.41.82 | iPhone / MacBook | p182-contacts.icloud.com |
| 192.168.41.93 | Windows PC | edge.microsoft.com, dyn.keepa.com |
| 192.168.41.13 | Nintendo Switch | ctest-ipv6.nintendo.net, accounts.nintendo.com |
| 192.168.41.73 | Mac/PC | slack.com, blacklist.tampermonkey.net |

**ログ形式:**
```
Jun  7 17:34:22 dnsmasq[3975085]: query[A] api.netflix.com from 192.168.41.25
Jun  7 17:34:22 dnsmasq[3975085]: forwarded api.netflix.com to 10.41.0.2
Jun  7 17:34:22 dnsmasq[3975085]: reply api.netflix.com is 54.239.28.85

Jun  7 17:34:19 dnsmasq[3975085]: query[A] kic-mclip.lgthinq.com from 169.254.219.142
                                                                          ↑ Yamaha プロキシ経由（個別IP不明）
```

**Widemap 実装:**

```js
// src/pollers/dnsmasq-log.js
// /var/log/dnsmasq-queries.log を tail -F してパース
// 追加依存なし・追加設定不要

const RE_QUERY = /(\w+\s+\d+\s[\d:]+) dnsmasq\[\d+\]: query\[(?:A|AAAA)\] (\S+) from (\S+)/;
const RE_REPLY = /dnsmasq\[\d+\]: reply (\S+) is (\S+)/;

// query 行: { time, domain, clientIP }
// reply 行: { domain, resolvedIP }
// → domain + resolvedIP で NAT セッション（dst IP）と突合
// → clientIP が 192.168.41.x なら per-client、169.254.x.x なら "router"
```

**NAT セッションとの突合:**
```
dnsmasq: { clientIP: '192.168.41.25', domain: 'data.meethue.com', resolvedIP: '34.200.1.10' }
NAT    : { src: '192.168.41.25', dst: '34.200.1.10', dport: 443 }
  → 「Hue Bridge が data.meethue.com に接続」として付加
```

**実装タスク:**
- [x] `src/pollers/dnsmasq-log.js` — `/var/log/dnsmasq-queries.log` の tail パーサー（2026-06-07 完了）
- [x] `query[A/AAAA]` 行から `{ time, domain, clientIP }` を抽出
- [x] `reply` 行から `{ domain, resolvedIP }` を抽出し query とペアリング
- [x] `resolvedIP` で NAT セッションの `dst` と突合 → `dstHost` フィールドに付加
- [ ] `clientIP` が `192.168.41.x` の場合はデバイスレコードに `lastDnsQuery` も記録（未実装）
- [x] Yamaha プロキシ経由（`169.254.x.x`）のクエリは `dstHost` 補完のみに使用
- [x] データソース設定 UI でログファイルパスを変更可能に（`/var/log/dnsmasq-queries.log`）

### show dns cache（ドメイン補完のみ・実装済み）

```
DNS キャッシュ: { domain: 'api.netflix.com', resolvedIP: '142.250.196.110' }
NAT セッション: { src: '192.168.1.10', dst: '142.250.196.110', dport: 443 }
  → c.dstHost = 'api.netflix.com' として付加（PTR 逆引きより信頼性が高い）
  ※ 誰がクエリしたかは紐付かないが、接続先のドメイン名が分かる（実装済み ✅）
```

### OpenWrt / dnsmasq の場合（#4+ で対応）

```
dnsmasq ログ: { time, clientIP: '192.168.1.10', domain: 'api.netflix.com', resolvedIP: '142.250.196.110' }
NAT セッション: { src: '192.168.1.10', dst: '142.250.196.110', dport: 443 }
  → 「192.168.1.10（スマートTV）が api.netflix.com に接続」として完全突合
  ※ EC2 dnsmasq と同じパーサーを流用できる
```

### 得られる価値

- **IoT デバイスのサービス識別**（Switchbot、スマート家電等は標準 DNS を使う）
- **C2 ドメイン検出の強化**（接続前のクエリ時点で検出可能）
- **DGA 検出精度向上**（エントロピー計算をクエリログに対して直接実施）
- **DNS トンネリング検出**（同一ドメインへのサブドメイン大量クエリを直接観測）

### 限界

- **DNS ログで分かるのは「接続前のクエリ」だけ**
  - 接続が HTTPS（port 443）の場合、通信内容はいずれにせよ見えない
  - DNS ログはドメイン名と IP の対応を知る手段であり、L7 プロトコル解析ではない
- **DoH（DNS over HTTPS）を使うクライアントはクエリが残らない**
  - Chrome・Firefox・iOS の主要アプリは DoH を使う可能性が高い
  - IoT・組み込み機器・レガシー機器は標準 DNS が多く、こちらが主なターゲット
- **SNI によるドメイン識別はできない**（パケット検査が必要）
  - Firewalla 等はインライン検査で TLS ClientHello の SNI を読み、HTTPS 接続のドメインを識別する
  - Widemap がこれを実現するにはパケットキャプチャ統合（「その他」参照）が必要
- **外部 DNS ハードコード**（8.8.8.8 等）の機器はルーターの DNS を通らない
  - NAT セッションで `dst=8.8.8.8, dport=53` が見えたら該当機器を特定できる

### OpenWrt との関係
EC2 dnsmasq（現行）と OpenWrt dnsmasq は同じログ形式のため、パーサーを共用できる。
OpenWrt 対応（#4+）の際は `src/pollers/dnsmasq-log.js` をそのまま流用する。

---

## `[INSPECT]` syslog によるセッション補完・代替

### 概要

Yamaha RTX が送出する `[INSPECT]` syslog（既に EC2 の `/var/log/yamaha-router.log` に蓄積中）を
Widemap に取り込むことで、現行の NAT セッションポーリングを補完・一部代替できる。

**実機で確認済みのログ形式:**
```
Jun  7 17:04:51  [INSPECT] LAN2[out][101098] TCP 192.168.41.73:53638 > 44.207.59.147:443 (2026/06/07 17:04:37)
                                                   ↑送信元IP:port        ↑宛先IP:port        ↑接続開始時刻
↑syslog 出力時刻（= 接続終了時刻）
```

### NAT セッションポーリング（現行）との比較

| 比較軸 | NAT ポーリング（現行） | `[INSPECT]` syslog |
|--------|----------------------|-------------------|
| **取得方式** | Widemap が SSH で定期ポーリング | Yamaha が自律的に EC2 へ push |
| **表すもの** | **今まさに存在するセッション** | **完了したセッション** |
| **リアルタイム性** | ポーリング間隔以内（現状 2秒） | 接続終了後に数秒〜の遅延 |
| **短命セッション** | ポーリング間に終わると**消える** | 必ず記録される ← 優位点 |
| **セッション継続時間** | 計算できない | 開始・終了タイムスタンプ両方あり → **計算可能** |
| **プロトコル** | TCP + UDP（NATテーブル全体） | **TCP のみ**（INSPECT 対象が TCP） |
| **方向** | 双方向（LAN内も含む） | **LAN→WAN のみ**（`LAN2[out]`） |
| **追加インフラ** | ASUS SSH が必要 | **不要**（EC2 rsyslog が受信済み） |
| **ルーター依存** | ASUS 専用 | Yamaha 固有 |

### 補完として有効な理由

```
NAT ポーリング（2秒間隔）
  ↑ 取りこぼし               ↑ 取りこぼし
--|------[短命TCP接続]--------|------[短命TCP接続]--------|-->
[INSPECT] syslog は全 TCP セッション完了を確実に記録
→ ポーリングが見逃した接続（C2 ビーコンの burst など）も残る
```

また、**接続継続時間**が計算できるため「長時間維持されている接続」の検出（ビーコン検出強化）にも使える。

### 代替としての限界

| 限界 | 内容 |
|------|------|
| UDP が取れない | DNS(53)・NTP(123)・QUIC(443/UDP) が欠落（注: port 853 DoT は TCP なので取れる） |
| アクティブ表示に使えない | 接続中のセッションは終了するまで出ない |
| LAN 内通信が見えない | `LAN2[out]` のみ |
| Yamaha 環境限定 | ASUS・OpenWrt では届かない |

→ **TCP/WAN 通信の「完全な履歴ログ」としては現行ポーリング以上に優秀。完全代替は不可。**

### 実装コスト

追加インフラなし。ファイルを tail するだけ：

```js
// src/pollers/inspect-syslog.js
// /var/log/yamaha-router.log を tail -F して [INSPECT] 行をパース
// Jun  7 17:04:51 169.254.219.142  [INSPECT] LAN2[out][101098] TCP 192.168.41.73:53638 > 44.207.59.147:443 (2026/06/07 17:04:37)
const RE = /\[INSPECT\].*TCP (\S+):(\d+) > (\S+):(\d+) \((\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2})\)/;
// → { src, sport, dst, dport, startedAt, endedAt, durationMs }
```

### 実装タスク

- [x] `src/pollers/inspect-syslog.js` — `/var/log/yamaha-router.log` の tail パーサー（2026-06-07 完了）
- [x] セッション完了イベントを既存の接続テーブルに取り込み（`handleInspectSession()` で upsert 実装済み）
- [ ] `durationMs` フィールドを接続レコードに追加 → 長時間接続の検出・表示に活用（未実装）
- [ ] 統計画面に「セッション継続時間」分布ヒストグラムを追加（ビーコン検出の布石）（未実装）
- [x] [DHCPD] も同ファイルにあるため、IP→MAC マッピングを同時取得（`dhcpd-syslog.js` 2026-06-07 完了）

---

## ⚙️ データソース設定 UI

### 概要

データソースが増えてきたため、**UI 上の「データソース設定」画面**で各ソースの有効/無効と
接続情報を管理できるようにする。

設定情報は2層に分離する：

| 層 | 保存先 | 内容 |
|----|--------|------|
| 秘密情報（認証） | `.env` | パスワード・SSH鍵パス（変更なし） |
| 機能ON/OFF・パス | `.widemap.json` | UI から変更可能 |

### 設定画面イメージ

```
設定 > データソース

┌─ ルーター接続 ───────────────────────────────────┐
│ ☑ ASUS SSH ポーリング                             │
│   IP: 192.168.41.2  User: admin  間隔: 2s        │
│                                                   │
│ ☑ Yamaha RTX SSH                                 │
│   IP: 192.168.41.1  User: admin                  │
│   └─ ☑ show dns cache（ドメイン補完）             │
│   └─ ☑ show nat session                         │
└───────────────────────────────────────────────────┘

┌─ Yamaha syslog（ファイル監視）────────────────────┐
│ ☑ [INSPECT] TCP セッション履歴                    │
│   ファイル: /var/log/yamaha-router.log            │
│                                                   │
│ ☑ [DHCPD] IP→MAC マッピング（同ファイル）         │
│                                                   │
│ □ [IKE] VPN セッション監視                        │
│                                                   │
│ □ DNS per-client（調査モード時のみ有効化）         │
│   デフォルト継続時間: [60] 分                     │
└───────────────────────────────────────────────────┘

┌─ conntrack（OpenWrt / ASUS Merlin / Ubiquiti）───┐
│ □ /proc/net/nf_conntrack                          │
│   SSH先: ___  User: ___                           │
└───────────────────────────────────────────────────┘
```

### `.widemap.json` への追加項目

```json
{
  "dataSources": {
    "asusSSH":       { "enabled": true,  "pollIntervalMs": 2000 },
    "yamahaSSH":     { "enabled": true },
    "yamahaDnsCache":{ "enabled": true },
    "yamahaNat":     { "enabled": true },
    "inspectSyslog": { "enabled": true,  "logFile": "/var/log/yamaha-router.log" },
    "dhcpdSyslog":   { "enabled": true },
    "ikeSyslog":     { "enabled": false },
    "dnsDebugMode":  { "enabled": false, "defaultDurationMin": 60 },
    "conntrack":     { "enabled": false, "sshHost": "", "sshUser": "" }
  }
}
```

### 実装タスク

- [x] `.widemap.json` に dnsmasq / inspect / dhcpd セクション追加（後方互換維持）（2026-06-07 完了）
- [x] 設定画面に「データソース」タブを追加（`#pane-datasource`、`/api/config/datasources` API）
- [x] 各ポーラーが enabled フラグを参照して起動/停止を制御
- [x] ファイルパスを UI から変更可能に（dnsmasq / inspect / dhcpd 各ログファイルパス）
- [x] 設定保存時にポーラーを再設定・再起動（`configure()` + `start()` 呼び出し）
- [ ] IKE・conntrack 等の追加データソースへの拡張（未実装）

---

## 🔔 アラート通知（Slack DM）

C2/Botnet Phase 1 とセットで実装。脅威検出時に Slack DM で通知する。

### 通知チャンネル

Slack Bot（`chat.postMessage`）のみ。Incoming Webhook では DM 送信不可のため Bot Token 方式を使用。

### 通知内容

- 送信元デバイス（src IP / MAC ベンダー / mDNS 名）
- 宛先 IP・国・組織名
- フィードソースとタグ（例: `Feodo - Emotet C2`）
- 検出時刻

### 重複抑制

- 同一 `(src, dst)` ペアに対してクールダウン時間内は再通知しない
- クールダウンはメモリ管理（再起動でリセットで可）

### エラーハンドリング

- Slack API 失敗時はログのみ、サーバーは止めない

### 設定画面 UI

```
[ ] Slack通知を有効化

Bot Token:       [xoxb-________________]  [?]
通知先ユーザーID:  [U01____________]         [?]
クールダウン:     [60] 分

[🔗 Slack Appを作成する]  ← api.slack.com/apps?new_app=1 を新タブで開く

[テスト送信]  ← 成功/失敗をその場で表示
```

- `[?]` ヘルプ
  - Bot Token: 「Slack App の OAuth & Permissions から取得。`xoxb-` で始まる文字列」
  - ユーザーID: 「Slack でプロフィールを開き "メンバーIDをコピー" で取得。`U` で始まる文字列」
- テスト送信: `✅ テスト通知を送信しました` または `❌ 送信失敗: invalid_auth` をその場で表示

---

## 📱 モバイルアプリ（iOS / Android ビューア）

### 概要
既存の Web UI を Capacitor でラップし、iOS / Android ネイティブアプリとして配布する。
アラート通知（Slack）と組み合わせることで、外出先からネットワーク監視・ブロック操作が完結する。

### 技術選定：Capacitor

既存の `public/index.html`（Web UI）をそのまま流用できるため追加開発コストが最小。

```
既存 Web UI（HTML/CSS/JS）
  └─ Capacitor でラップ
       ├─ iOS アプリ（Xcode でビルド → App Store）
       └─ Android アプリ（Android Studio → Google Play）
```

### 主な機能（ビューア）

- 接続グラフ・世界地図のリアルタイム表示
- デバイス一覧・接続履歴の閲覧
- 脅威検出アラートのプッシュ通知受信
- 接続パネルから「この IP をブロック」操作

### プッシュ通知

Capacitor の `@capacitor/push-notifications` プラグインで実装。
アラート通知（Slack/Webhook）と並行して、アプリへのプッシュ通知も送れる。

### 配布

| プラットフォーム | 配布方法 | コスト |
|------------|---------|--------|
| iOS | App Store | Apple Developer $99/年 |
| Android | Google Play | $25（初回のみ） |
| 代替 | TestFlight / APK 直配布 | 無料（ストア審査なし） |

### 留意点

- バックエンド（server.js）はローカルネットワーク内で動作するため、**外出先からのアクセスには VPN または ngrok 等のトンネルが必要**
- モバイルアプリはあくまでビューア兼操作端末。バックエンドは常時起動の前提

---

## ☁️ AWS VPC Flow Logs 対応（NAT GW + EIGW）

### 概要

AWS NAT Gateway（IPv4）と Egress-only Internet Gateway（IPv6）の Flow Logs を取り込み、
Yamaha RTX / OpenWrt と同じグラフ・世界地図上に統合表示する。
**オンプレ + クラウドのトラフィックを1画面で見られるツールは現時点で存在しない。**

### Yamaha NAT セッションとのデータ構造比較

| フィールド | Yamaha `show nat descriptor` | AWS NAT GW Flow Log |
|-----------|------------------------------|---------------------|
| 送信元 IP | `src` | `pkt-srcaddr` |
| 宛先 IP | `dst` | `pkt-dstaddr` |
| 送信元ポート | `sport` | `srcport` |
| 宛先ポート | `dport` | `dstport` |
| プロトコル | `proto` | `protocol` |
| 追加情報 | TTL | `action`（ACCEPT/REJECT）・`bytes`・`packets`・`instance-id` |

既存の enrichment パイプライン（GeoIP・逆引き DNS・RDAP）がそのまま再利用できる。

### IPv4 / IPv6 の対応関係

| AWS サービス | プロトコル | Yamaha の対応 |
|------------|-----------|--------------|
| **NAT Gateway** | IPv4 のみ | Yamaha IPv4 NAT セッション |
| **Egress-only Internet Gateway（EIGW）** | IPv6 のみ | Yamaha IPv6 セッション |

NAT GW + EIGW の2つを対象にすることで IPv4/IPv6 を完全カバーできる。
AWS では IPv6 取得に設定変更が不要（Yamaha の `lan pass-through` 問題がない）。

### Flow Log レコード例

```
# NAT GW（IPv4）Regional NAT GW の場合
# resource-id  srcaddr    dstaddr       pkt-srcaddr  pkt-dstaddr
nat-1234abcd   10.0.1.5   203.0.113.5   10.0.1.5     203.0.113.5

# EIGW（IPv6）
# srcaddr                          dstaddr                    protocol
2001:db8:1234:a100:8d6e::10       2404:6800:4004:819::200e   6
```

### 取り込み方法

| 方法 | 遅延 | コスト | 推奨 |
|------|------|--------|------|
| **S3 バケット出力 + ポーリング** | 1〜15分 | 安価（S3 ストレージ料金のみ） | ✅ |
| CloudWatch Logs + API クエリ | 1〜15分 | 従量課金（やや高い） | △ |

### 実装方針

```
[設定]
  - AWS Access Key / IAM Role ARN を設定画面から入力
  - 対象: S3 バケット名 + プレフィックス（NAT GW 用・EIGW 用）
  - ポーリング間隔: 5分（Flow Log の集計遅延に合わせる）

[ポーラー: src/pollers/aws.js]
  - S3 から新着ログファイルを取得（LastModified で差分管理）
  - 行パース: pkt-srcaddr / pkt-dstaddr / srcport / dstport / protocol
  - 既存の enrichment.js に渡す（GeoIP・逆引き DNS）

[フロントエンド]
  - ノードに「AWS」タグ（色分け）
  - 送信元ノード: EC2 instance-id or private IP
  - 地図: オンプレ（日本）→ internet と AWS（リージョン）→ internet が同時表示
```

### 競合との差別化

| | Widemap | Amazon Detective | GuardDuty |
|--|:-:|:-:|:-:|
| グラフ可視化 | ✅ | ✅ | ❌ |
| 世界地図アーク | ✅ | ❌ | ❌ |
| C2/Botnet 検出 | ✅ | ❌ | ✅ |
| **オンプレ + クラウド統合** | **✅** | **❌** | **❌** |
| コスト | **$0** | 従量課金 | 従量課金 |

### 留意点

- **遅延**: Flow Log は 1〜15分の集計遅延。Yamaha の数秒ポーリングとは別物
- **ボリューム**: 大規模 VPC では大量のレコードが発生するため、SQLite のインデックス設計が重要
- **IAM 権限**: `s3:GetObject` / `s3:ListBucket` のみで動作可能（最小権限）
- **マルチリージョン**: リージョンごとに S3 バケットが異なる場合は複数設定に対応が必要

### デプロイアーキテクチャの選択

AWS Flow Logs 対応を「どこで動かすか」で2つのパスがある。

#### パス A：オンプレ常駐プロセスから S3 をポーリング（現実的・推奨）

```
[自宅/オフィスの Mac or Raspberry Pi]
  ├─ Yamaha RTX SSH ポーリング  ✅
  ├─ SQLite                    ✅
  ├─ Socket.IO                 ✅
  └─ AWS SDK で S3 をポーリング ✅ ← Flow Logs をローカルで処理
```

- **Docker 1コンテナで動く**（既存の構成に `src/pollers/aws.js` を追加するだけ）
- Yamaha RTX との統合ビューがそのまま実現できる
- 「常時起動の拠点マシン」が必須（Mac・Pi・NAS 等）

#### パス B：クラウドネイティブ構成（将来の SaaS 化・大規模展開向け）

```
S3（Flow Logs）
  └─ S3 Event → Lambda（パース・enrichment）
                   └─ DynamoDB / Aurora Serverless（接続履歴）
                        └─ API Gateway WebSocket → ブラウザ
```

- Yamaha RTX への SSH は **届かない**（NAT の向こうに到達不可）→ クラウドトラフィックのみ
- Socket.IO は Lambda と相性が悪い（ステートレス）→ API Gateway WebSocket に書き換え必要
- SQLite は Lambda で使えない → DynamoDB / Aurora Serverless に置き換え必要
- **アーキテクチャ全体の書き換えが必要**。Widemap を SaaS として展開する段階の話

| | パス A | パス B |
|--|--|--|
| Yamaha RTX 対応 | ✅ | ❌ |
| AWS VPC Flow Logs | ✅ | ✅ |
| 実装コスト | 低（SDK 追加のみ） | 高（全書き換え） |
| 運用コスト | $0 | Lambda + DynamoDB 従量課金 |
| 対象規模 | 個人・SMB | エンタープライズ・SaaS |
| **現在の Widemap の位置** | **ここ** | 将来の選択肢 |

**現段階ではパス A のみ現実的。パス B は Widemap を SaaS 化する際の設計として別途検討する。**

---

## 🔌 その他

- [ ] パケットキャプチャ統合（別マシンで tcpdump → 解析）
- [ ] TLS JA3/JA4 指紋検出
- [ ] HTTP/HTTPS 上のドメイン名集計（DoH 非対応クライアントは DNS ログ監視で代替可能）
- [ ] 履歴ログのエクスポート（CSV/JSON）
- [ ] グラフレイアウトの保存/復元

---

## 💡 ビジネス戦略メモ

### 有償化・スケールに関する考察（2026年6月時点）

#### 有償ユーザー 10,000人の現実性

- 目標: 10,000人 × $20/月 = $200,000/月 ARR（約3,000万円/月）
- 技術者向け無料版からの転換率 3〜5% → 必要な認知ユーザー数: 200,000〜330,000人
- 現在の backlog 全完了後の推定ユーザー数: 〜2万人 → 有償 600〜1,000人
- **10,000人には追加戦略が必要**

#### MSP（IT管理会社）チャネルが最短経路

```
個人ユーザー 10,000人を集める より
MSP 200社 × 50クライアント = 10,000エンドポイント の方が現実的

MSP への訴求:
  「顧客の Yamaha RTX + AWS を1画面で管理・月次レポート自動生成」
  $50〜100/月/社 → 顧客に転嫁可能
```

#### 10,000人に必要な追加プロダクト機能（現 backlog 外）

- マルチテナント（1ログインで複数拠点管理）
- ゼロタッチ設定（MSP がリモートでクライアント追加）
- 月次セキュリティレポート自動生成（PDF）
- ホワイトラベル対応
- SSO/SAML（企業向けログイン）
- SLA・有償サポート

#### 生成AI時代における「チーム不要論」

2026年時点で「1人 + AI」は以前の「5人チーム」に相当する生産性。

| 作業 | AI 代替可否 |
|------|:-:|
| コード実装 | ✅ AI 支援で 1人実装可能 |
| Tier-1 サポート | ✅ AI チャットボットで代替 |
| マーケティングコンテンツ | ✅ AI で量産 |
| 多言語展開（英語） | ✅ AI で即時対応 |
| 最初の MSP 20〜50社の開拓 | △ 人間が必要（ここだけ） |

**「1人 + AI」で 10,000人有償ユーザーは現実的な目標。**
ただし条件:
1. オンボーディングの完全自動化（人が介在しない導入フロー）
2. MSP 向けセルフサービス（契約・設定・クライアント追加が全て Web 完結）
3. AI サポートの品質（Widemap 専用知識ベースの整備）
4. 最初の 50社だけ泥臭く人間が動く

#### ロードマップ

```
Phase 1（〜1年）: 技術的完成
  backlog #1〜#4++ 完成
  GitHub スター 1,000+ / 無料ユーザー 5,000人 / 有償 100〜300人

Phase 2（1〜2年）: MSP チャネル開拓
  マルチテナント・レポート機能追加
  MSP 20〜50社と契約 → 有償換算 1,000〜2,500人

Phase 3（2〜3年）: スケール
  MSP 200社 / 有償ユーザー 10,000人 / ARR $200K/月
```

#### 競合製品との機能比較（2026年6月調査）

| 機能 | Widemap | Firewalla | ntopng | Pi-hole | Amazon Detective | GuardDuty | Datadog NPM | RITA | Malcolm | **Yamaha DPI** | Backlog |
|------|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:--|
| デバイス可視化（グラフ） | ✅ | ✅ | △ | ❌ | ✅ | ❌ | ✅ | ❌ | △ | △ | 実装済み |
| 世界地図上の接続表示 | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | △ | ❌ | ❌ | ❌ | 実装済み |
| 長期履歴 | ✅ | △ | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | △ | #2 SQLite 化 |
| IPv6 セッション監視 | △※1 | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | #2+ IPv6 収集 |
| C2/Botnet 検出（脅威フィード） | ✅ | ✅ | △有償 | ❌ | △ | ✅ | △ | ✅ | ✅ | ❌ | #3 Phase 1 |
| アラート通知（Slack/Webhook） | ✅ | ✅ | △ | △ | ✅ | ✅ | ✅ | △ | △ | ❌ | 実装済み |
| DNS ドメイン識別（接続先） | ✅※4 | ✅ | ❌ | △ | ❌ | ❌ | △ | ✅ | ✅ | ❌ | show dns cache + dnsmasq-log で実装済み |
| DNS per-client 追跡（誰が何を引いたか） | △※4 一部実装済 | ✅ | ❌ | △ | ❌ | ❌ | △ | ✅ | ✅ | ❌ | dnsmasq-log.js で直接クエリデバイスは per-client 取得済み（2026-06-07）。Yamaha 経由分は不可 |
| DNS トンネリング検出 | △(#4++) | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ | ✅ | ✅ | ❌ | #4++ ビーコン |
| **L7 アプリ名識別（SNI/DPI）** | **✅※3** | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | △ | ✅ | **✅** | DNS cache で実質同等 |
| OpenWrt 対応 | △(#4+) | ❌ | △ | ❌ | ❌ | ❌ | ❌ | △ | △ | ❌ | #4+ conntrack |
| 通信ブロック（能動防御） | △(#5) | ✅ | ❌ | ✅DNS | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | #5 ブロック |
| AWS VPC Flow Logs | △(#5++) | ❌ | △ | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | #5++ AWS |
| オンプレ + クラウド統合 | △(#5++) | ❌ | △ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | #5++ AWS |
| ビーコン・DGA 検出 | △(#4++) | △ | ❌ | ❌ | △ | ✅ | △ | ✅ | ✅ | ❌ | #4++ ビーコン |
| モバイルアプリ | △(#7) | ✅ | ❌ | △ | ❌ | △ | △ | ❌ | ❌ | ❌ | #7 モバイル |
| 専用ハードウェア不要 | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌※2 | ❌※2 | ✅ | 構造上の特性 |
| スループット影響ゼロ | ✅ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 構造上の特性 |
| コスト | $0 | $279〜929 | △ | $0 | 従量課金 | 従量課金 | $$$ | $0 | $0 | **¥25,850/年** | — |
| 無料・OSS | ✅ | ❌ | △ | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ | — |

> ※1 IPv6: Nuro光環境では RA Proxy 方式が使えないため、ミラーポート方式（#5+）で対応予定。
> ※2 RITA・Malcolm はミラーポートまたはPCAP取得用の専用マシンが必要。
> ※3 Widemap は `show dns cache` でドメイン名を取得しており、実用上アプリ名識別と同等。DoH を使うクライアント（Chrome等）や DNS キャッシュ期限切れ時は取れない場合があるが、IoT・スマートTV など家庭・SOHO の主なターゲットは標準 DNS を使うため影響は限定的。Yamaha DPI（有償）との差は「CDN の複数ドメインをアプリ名に統合できるか」程度。
> ※4 `show dns cache` SSH ポーリング + EC2 dnsmasq ログ（`dnsmasq-log.js`、2026-06-07 実装）で接続先ドメイン名を識別済み。EC2 dnsmasq に直接クエリするデバイスは per-client 追跡も可能。Yamaha DNS プロキシ経由（`169.254.x.x`）のクエリは個別識別不可。完全な per-client 対応には `syslog debug on` が必要。

**各競合の一言評価:**
- **Firewalla** — 最も近い競合。専用HW（$279〜）が必要。Widemap は既存ルーターに追加するだけで同等機能を無料提供する点が差別化軸
- **ntopng** — フロー解析に強いが世界地図・C2検出が弱く、高機能版は有償
- **Pi-hole** — DNS フィルタリング専門。ネットワーク可視化・脅威検出はほぼなし
- **Datadog NPM** — クラウド・エンタープライズ向けで高コスト。オンプレルーターには非対応
- **GuardDuty / Amazon Detective** — AWSクラウドのみ。オンプレ不可。#5++ 完了後は「オンプレ+クラウド統合」で競合なしになる
- **RITA** — Zeekログからビーコン・DNSトンネリング・C2を統計検出するOSS（CISA公認）。検出精度は高いがミラーポート必須でセキュリティ専門家向け
- **Malcolm** — CISA/Idaho National Lab 製の OSS。Zeek+Suricata+OpenSearch のフル統合スタック。重量級（16GB+）でICS/OT環境にも使われる本格派。ミラーポート必須
- **Yamaha DPI** — RTX1300/840/830対応の有償拡張（¥25,850/年）。アプリ名識別・経路制御・帯域管理が目的でセキュリティ監視ではない。**競合ではなく補完関係**：DPI syslog を Widemap が取り込むことで L7 アプリ名をゼロ追加機器で実現できる

#### ユニーク性が生まれるタイミング

| backlog 段階 | ポジション |
|-------------|-----------|
| 〜#3++ | Firewalla の廉価版 |
| **#4 完了** | **既存ルーターで動く無料 Firewalla（差別化が始まる）** |
| **#4+ 完了** | **一部機能で Firewalla を超える** |
| **#4++ 完了** | **オンプレ + クラウド統合の唯一の選択肢（競合なし）** |

---

## 🔍 「不正通信の把握」に必要な機能リスト

主目的：*LAN内のIoT機器・NW機器・PC/サーバーが不正な通信をしていないかを把握する*

### 1. 可視性

| 機能 | 状態 | 備考 |
|------|------|------|
| LAN内デバイスの通信先IP・ポート・プロトコル | ✅ 実装済 | Yamaha RTX NATセッション |
| デバイス識別（OUI・mDNS・SSDP・NetBIOS・Apple辞書） | ✅ 実装済 | |
| 接続先の組織名・国・GeoIP | ✅ 実装済 | RDAP・GeoIP |
| 通信履歴（7日間） | ✅ 実装済 | SQLite |
| 接続先ドメイン名の可視化 | ✅ 実装済 | `show dns cache` SSH ポーリング + `dnsmasq-log.js` による forward DNS 補完（2026-06-07）。dnsmasq 名は PTR 逆引きより優先 |
| **DNS per-client 追跡（誰が何を引いたか）** | △ 一部実装済 | EC2 dnsmasq（`dnsmasq-log.js`）で直接クエリデバイスは per-client 取得済み（2026-06-07）。Yamaha プロキシ経由（169.254.x.x）のクエリは個別識別不可。完全対応は `syslog debug on` が必要 |
| **IPv6通信先の可視化** | ❌ 未実装 | 現状36%の通信が不可視。パケットミラー方式で対応可 |
| **DHCP履歴（IPアドレス変動追跡）** | ✅ 実装済 | `dhcpd-syslog.js` で Yamaha `[DHCPD]` ログをリアルタイムパース。IP→MAC を 24h TTL で追跡（2026-06-07） |

### 2. 脅威検出

| 機能 | 状態 | 備考 |
|------|------|------|
| 既知C2・ボットネットIPとの突合（Feodo/ThreatFox/URLhaus/DROP） | ✅ 実装済 | |
| **ビーコン検出**（一定間隔で同一宛先への通信） | ❌ 未実装 | C2ハートビートの典型パターン。SQLite実績があれば実装可能 |
| **通信先の異常検出**（初めての国・AS・深夜帯の突発通信） | ❌ 未実装 | ベースライン学習が必要 |
| **新規デバイス検出**（未知のMACアドレスがLANに参加） | ✅ 実装済 | SQLite内MAC履歴との差分比較。SlackアラートとNEWバッジ実装済み |
| **DGAドメイン検出**（高エントロピーなドメイン名） | ❌ 未実装 | DNSログ取得が前提 |
| **異常ポート通信**（IoTが23/Telnetや4444等に外向き接続） | △ 一部可能 | ポートは見えるが自動フラグなし |
| **大量アウトバウンド検出**（データ持ち出しの兆候） | ❌ 未実装 | トラフィック量の統計が必要 |

### 3. アラート・通知

| 機能 | 状態 | 備考 |
|------|------|------|
| Slack DM通知（脅威検出時） | ✅ 実装済 | クールダウン・言語対応 |
| **モバイルプッシュ通知**（ntfy.sh / iOS Push等） | ❌ 未実装 | Slackが使えない環境向け |
| **定期セキュリティレポート**（週次・月次サマリー） | ❌ 未実装 | 検出件数・新規デバイス・リスク上位デバイス |
| **デバイス別リスクスコア** | ❌ 未実装 | 複数の検出シグナルを集約して可視化 |

### 4. 対応・遮断

| 機能 | 状態 | 備考 |
|------|------|------|
| **通信ブロック（Yamaha RTX）** | ❌ 未実装 | ip filter をSSH経由で書き込み |
| **通信ブロック（OpenWrt）** | ❌ 未実装 | ipset + iptables で即時適用 |
| **脅威検出時の自動ブロック** | ❌ 未実装 | 検出→ブロックの自動化。誤検知対策が課題 |

### 5. 調査・フォレンジクス

| 機能 | 状態 | 備考 |
|------|------|------|
| 通信ログの検索・フィルター | ✅ 実装済 | |
| **接続履歴のオンデマンドロード（API化）** | ✅ 実装済 | 初回24h送信 + 期間フィルター時のAPI追加取得 + 差分push（#3++ 完了） |
| **CSV/JSONエクスポート** | ❌ 未実装 | 外部ツールとの連携・手動調査用 |
| **AbuseIPDB / VirusTotal照会** | ❌ 未実装 | 特定IPの追加情報取得（Phase 3として既出） |

### 6. カバレッジ拡張

| 機能 | 状態 | 備考 |
|------|------|------|
| Yamaha RTX対応 | ✅ 実装済 | |
| **OpenWrt対応** | ❌ 未実装 | ユーザー層の大幅拡大に直結（#4として既出） |
| **MikroTik / pfSense / OPNsense対応** | ❌ 未実装 | SOHO向け人気機種 |

### 優先度の考え方

「不正通信の把握」という主目的に基づき、推奨実装順序に反映済み：

| 順位 | 機能 | 根拠 | 推奨実装順序での位置 |
|------|------|------|-------------------|
| 🟢 | **新規デバイス検出** | 実装済み | #3+++ 完了 |
| 🟡 | **DNS per-client 追跡** | EC2 dnsmasq に直接クエリするデバイスは `dnsmasq-log.js` で per-client 取得済み（2026-06-07）。Yamaha プロキシ経由分は未対応。完全対応には `syslog debug on` が必要 | #4 一部完了 |
| 2 | **conntrack 対応（ASUS/OpenWrt/Ubiquiti）** | ユーザー層拡大 + dnsmasq連携でDNS監視も強化。共通パーサー1本 | #4+ |
| 3 | **ビーコン検出** | SQLite実績があれば実装可能。C2ハートビートの典型パターンに直撃 | #4++ |
| 4 | **通信ブロック** | 検出から「対処」まで完結させる。手動承認モード先行 | #5 |
| 5 | **Yamaha DPI syslog 連携** | RTX1300対応・30日トライアルあり。`[DPI]` ログパースでL7アプリ名を追加機器ゼロで実現 | 新規 |

---

## 🆚 競合比較表（内部参考）

| カテゴリ | 機能 | Widemap | Firewalla | Ubiquiti UniFi | Darktrace / ExtraHop | Cisco Meraki / FortiGate | ISP セキュリティ | ntopng / Zabbix |
|---------|------|---------|-----------|----------------|----------------------|--------------------------|----------------|----------------|
| **対象環境** | 追加ハードウェア不要 | ✅ | ❌ 専用機 ¥15k〜 | ❌ UDM ¥30k〜 | ❌ タップ/SPAN | ❌ 機器+サブスク | ✅ | ✅ |
| | 既存ルーターと共存（非インライン） | ✅ パッシブ | ❌ 中継設置 | ❌ 置換必要 | ❌ | ❌ | ✅ | ✅ |
| | Yamaha RTX 対応 | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ | ⚠️ 要設定 |
| | 家庭・SOHO 向け | ✅ | ✅ | ⚠️ 中〜上位 | ❌ 法人専用 | ❌ 法人専用 | ✅ | ⚠️ 技術者向け |
| **表示機能** | デバイス単位の通信先可視化 | ✅ | ✅ | ⚠️ 限定的 | ✅ | ✅ | ❌ | ⚠️ 要設定 |
| | 世界地図表示 | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| | 接続先組織名・ASN 表示 | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ⚠️ 別途 |
| | IoT デバイス識別（OUI/mDNS） | ✅ | ✅ | ⚠️ 限定的 | ✅ | ⚠️ | ❌ | ❌ |
| | 接続履歴・時系列ログ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| **脅威検出機能** | 既知C2・脅威フィード突合 | ✅ ローカル | ✅ | ✅ Suricata | ✅ AI | ✅ | ❌ | ⚠️ 別途 |
| | 新規デバイス検出（不正接続） | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ⚠️ 要設定 |
| | ビーコン検出（C2ハートビート） | 🔜 実装予定 | ⚠️ 限定的 | ❌ | ✅ | ⚠️ | ❌ | ❌ |
| | DNS クエリ監視（L7） | △ 一部実装済 | ✅ | ✅ | ✅ | ✅ | ❌ | ⚠️ 別途 |
| | 通信ブロック | 🔜 実装予定 | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ |
| **管理機能** | リアルタイムアラート（Slack等） | ✅ | ⚠️ アプリ通知 | ❌ | ✅ | ⚠️ webhook | ❌ | ⚠️ 別途 |
| | 完全ローカル動作（プライバシー） | ✅ | ⚠️ クラウド連携 | ⚠️ クラウド連携 | ❌ クラウド | ❌ クラウド | ❌ | ✅ |
| | セットアップの容易さ | ✅ 10分 | ✅ | ⚠️ 中程度 | ❌ 専門家必要 | ❌ | ✅ | ❌ 高難度 |
| **コスト** | ソフトウェア費用 | ✅ 無料 OSS | ❌ 本体 ¥15k〜 | ❌ 本体 ¥30k〜 | ❌ 数百万〜 | ❌ 数十万〜 | ⚠️ ISP 月額 | ✅ 無料 |
| | 維持費（サブスク等） | ✅ なし | ⚠️ 任意 | ⚠️ 任意 | ❌ 高額 | ❌ 必須 | ⚠️ 月額 | ✅ なし |
