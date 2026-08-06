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

署名はメンテナのworkstationで行います。checkoutが意図した署名対象tagであること、
cleanであること、テストが通っていることを確認してから、KMS鍵でbuildします。

```bash
aws sso login --profile egressview-release
AWS_PROFILE=egressview-release npm run offline:bundle -- \
  --output dist/offline \
  --kms-key-id alias/egressview-release \
  --region ap-northeast-1
```

`--private-key`はローカル鍵ファイルを使う選択肢として残っています。CIが使い捨て鍵で
仕組みを検証する用途と、独自に配布物を作る利用者向けで、**正式リリースにはなりません**。
両オプションは排他です。

アップロード前に`npm run offline:verify`を、生成されたarchive・checksum・署名・公開鍵に
対して実行します。**このコマンドにAWSアクセスもAWS CLIも不要です** — 署名はchecksum
ファイルに対する生のEd25519署名で、`openssl`と同梱の`.pub.pem`だけで検証できます。
公開鍵のfingerprintを再計算し、登録済みactive recordと比較してください。アップロードするのは
archive・checksum・detached署名・公開鍵だけです。

Releaseノートには成果物名、checksum、完全なfingerprint、署名鍵ID、検証ガイドへのリンクを
記載します。可能なら別のメンテナがダウンロード物を検証し、単独メンテナの場合は別のclean環境で
ダウンロードして検証してから公開を告知します。

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
