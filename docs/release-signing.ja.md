# Release署名鍵の運用手順

> [English](release-signing.md)

この手順は、正式な署名付きportable releaseの信頼起点を確立します。CIは毎回破棄する
試験鍵を使うだけで、releaseの真正性は保証しません。
`release-signing/trusted-fingerprints.json`にactiveな鍵が登録されるまでは、正式な
project鍵で署名済みとは表現しません。

## 署名鍵

リリース鍵はAWS KMSの非対称鍵です。秘密鍵はKMS内で生成され取り出せないため、
**保管・バックアップ・紛失・漏えいの対象になる鍵ファイルが存在しません**。署名には
ファイルの所持ではなく、認証されたAWS principalが必要です。

| | |
|---|---|
| エイリアス | `alias/egressview-release` |
| リージョン | `ap-northeast-1` |
| 鍵仕様 | `ECC_NIST_EDWARDS25519`、`SIGN_VERIFY` |
| 署名アルゴリズム | `ED25519_SHA_512`、`MessageType: RAW` |

**署名できるのは`EgressViewRelease` permission setだけです。** この制限はIAMではなく
**キーポリシー**にあります。アカウント管理用のstatementは`kms:Sign`を意図的に含まないため、
管理者は鍵のrotation・ポリシー変更・削除予約はできても、その鍵でリリースに署名することは
できません。他のロール、とりわけEC2インスタンスロールへ`kms:Sign`を付与しないでください。
署名はメンテナのworkstationから行うもので、サーバ側にこの権限は不要です。

リリース前にサインインします。

```bash
aws sso login --profile egressview-release
```

公開鍵とfingerprintの取得:

```bash
aws kms get-public-key --profile egressview-release \
  --key-id alias/egressview-release --query PublicKey --output text \
  | base64 -d > /tmp/egressview-release.der
openssl pkey -pubin -inform DER -in /tmp/egressview-release.der \
  -out /tmp/egressview-release.pub.pem
node scripts/release-key-fingerprint.js /tmp/egressview-release.pub.pem
```

fingerprintの算出は独立してもう一度実行し、**全桁**を比較してください。先頭や末尾だけの
比較は不可です。

## Fingerprintの登録・公開

公開鍵とactive recordを`release-signing/trusted-fingerprints.json`へreview付きPRで
追加します。key ID、完全な`SHA256:<64文字の小文字hex>` fingerprint、生成日、公開鍵
pathを記録します。同じ完全なfingerprintを次の全経路で公開します。

- **リポジトリ内** — `SECURITY.md`、署名付きdistribution guide、project website、
  その鍵を初めて使うGitHub Release note。**これらは4つの経路ではなく1つの管理ドメイン**
  です。いずれもこのリポジトリから生成されるため、アカウントを1つ奪われれば同時に
  書き換わります。
- **リポジトリ外** — 別の認証情報で管理する経路を1つ以上。**信頼を担っているのはここ**
  で、現在は別プロバイダが配信するDNS TXTレコード
  `_egressview-release.egressview.com`です。

  ```console
  $ dig +short TXT _egressview-release.egressview.com
  "egressview-release-key=egressview-release-2026; fp=SHA256:6288...eccc; created=2026-08-05"
  ```

Releaseに同梱した`.pub.pem`だけでは信頼起点になりません。**リポジトリも同様です。**
利用者は、このリポジトリの侵害が及ばない経路から取得したfingerprintと照合します。

## 署名・公開

**メンテナのワークステーションで、1コマンドです。** タグをcheckoutしてから、

```bash
aws sso login --sso-session egressview
```

```bash
AWS_PROFILE=egressview-release npm run release:publish -- --tag v2.0.3
```

これが手順のすべてです。**1コマンドにしているのは意図的です。** 2.0.0・2.0.1・2.0.2はいずれも署名済み資産なしで公開されました。パイプラインが失敗したのではなく、**実行されなかった**のです。「リリースする」と「署名する」が、人が順に思い出して実行する別々の行為だったためです。**3回連続で飛んだという事実は、覚えていることが管理策ではないことの証拠です。**

順序が本質であり、コマンドがそれを強制します。

1. `HEAD`がタグと厳密に一致し、作業ツリーがclean、`npm run release:check`が通ることを確認するまで**着手しません**。dirtyな状態から作ったリリースはタグが指すものではなく、後から署名しても直りません。
2. **既に公開済み**のタグは、ビルドと署名を費やす**前に**拒否します。
3. KMS鍵でビルドと署名を行います。
4. バンドルを検証し、さらに**改竄3ケースが落ちることを証明**します（アーカイブの改変、チェックサムの書き換え、署名の偽造）。
5. fingerprintをtrust registry**とDNS TXTレコード**に照合します。DNSはこのリポジトリとは別系統の資格情報で提供されています。**成果物の隣にしか公開されていないfingerprintは何も証明しません。**
6. **draft**としてリリースを作成し、4点をアップロードします。
7. **その資産をGitHubから落とし直して検証**します。手元のディスク上のものではなく、リリースページが実際に配信するものを見ます。
8. ここまで通って初めて、draftを公開へ切り替えます。

**draft先行が、未署名のリリースを「起こりにくい」ではなく「作れない」にしている点です。** どこかで落ちれば残るのはdraftであって、「検証手段が無い公開済みリリース」にはなりません。2.0.xが置かれていたのは、まさにその状態でした。

`--dry-run` を付けると、GitHub上に何も作らずに5番までを実行できます。

### その後ろのゲート

`.github/workflows/release-gate.yml` が、リリースの**公開時と編集時**、および週次で `npm run release:verify-published` を実行します。リリースページが配信するものをダウンロードして検証するので、**GitHubのWeb画面など別経路で作られたリリース**も、**公開後に資産が削除・差し替えられた場合**も捕まえます。AWSアクセスは不要です。

この手順より前に公開され署名されなかったリリースは、理由付きで `release-signing/unsigned-releases.json` に記録してあり、ゲートは永久に失敗するのではなく既知の事実として報告します。**常に失敗するゲートは、人が無視することを学ぶゲートです。** 方針の発効日以降に公開されたリリースの登録はテストが拒否するため、**このリストが新しい失敗を黙らせる抜け道になることはありません。**

### 署名はワークステーションに置いたままにします

GitHub Actionsに `kms:Sign` のOIDCロールを与えて人を完全に排除する案は魅力的ですが、それは署名できる主体を**「SSOセッションを持つ人がワークステーションで」から「ワークフローで実行される何か」へ広げます**。鍵ポリシーで署名を専用プリンシパルに限定し、trust anchorを意図的にリポジトリの外に置いているプロジェクトで、**規律の問題をサプライチェーンの問題に置き換える**取引です。鍵は今の場所に置き、ワークステーション側の作業を1コマンドにします。

`offline:bundle` の `--private-key` は引き続き利用でき、KMSの代わりにローカルの鍵ファイルを取ります。すべてのpull requestで使い捨て鍵により機構を動かし続けるCIのため、および独自に配布物を作る人のためのものです。**公式リリースを作るものではありません。**

### リリースノート

成果物名、チェックサム、完全なfingerprint、署名鍵ID、検証ガイドへのリンクを必ず記載します。リリース番号とHubのバージョンが異なる場合（2.0.2はHub 1.10.0を含み、成果物名はHubのバージョンに従います）は**両方を明記**し、成果物名とノートが黙って食い違わないようにします。

## Rotation・漏えい対応

計画rotationでは、旧鍵と新鍵で個別に署名したartifactを1 releaseだけ併記し、両fingerprintを
独立経路でも告知します。overlap releaseの公開後に旧鍵を`retired`へ変更します。

overlap releaseは旧鍵で署名する必要があるため、**rotation時にKMS鍵の削除を予約しないで
ください。** 待機期間が過ぎると削除は取り消せません。検証は同梱の公開鍵と`openssl`だけで
完結し鍵を必要としないので、旧鍵を残すコストは$1/月にすぎず、何かあった時に再度署名できる
余地を買えます。明確な理由がない限り保持してください。

漏えいの疑いがあればreleaseを直ちに停止します。鍵を`revoked`にし、完全なfingerprintと
incident日を全公開経路で告知し、KMS鍵を無効化するか、release permission setから`kms:Sign`を外します。新鍵を作成し、review済みtagから影響artifactを再構築します。既存GitHub Releaseのartifactを、
明示的なincident noticeと新versionなしに差し替えません。
