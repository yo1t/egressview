# Release署名鍵の運用手順

> [English](release-signing.md)

この手順は、正式な署名付きportable releaseの信頼起点を確立します。CIは毎回破棄する
試験鍵を使うだけで、releaseの真正性は保証しません。
`release-signing/trusted-fingerprints.json`にactiveな鍵が登録されるまでは、正式な
project鍵で署名済みとは表現しません。

## 鍵生成

1. patch適用済みで管理者が管理するworkstationを使い、不要なnetwork接続を切断して
   `umask 077`を設定します。
2. repository外にpassphrase暗号化済みEd25519鍵を生成します。

   ```bash
   umask 077
   openssl genpkey -algorithm ED25519 -aes-256-cbc \
     -out /secure/offline/egressview-release-YYYY.key
   openssl pkey -in /secure/offline/egressview-release-YYYY.key -pubout \
     -out /tmp/egressview-release-YYYY.pub.pem
   node scripts/release-key-fingerprint.js \
     /tmp/egressview-release-YYYY.pub.pem
   ```

3. 秘密鍵のprimary copyは暗号化したoffline volumeへ保存します。別の物理場所に、別途
   暗号化したrecovery copyを1つ保管します。passphraseは両方の鍵とは別に保管し、
   accessできるrelease maintainerを限定して利用記録を残します。
4. 秘密鍵をGit、GitHub Actions secret/artifact、CI runner、projectの`.env`、log、
   chat、ticket、EC2へ保存しません。
5. fingerprint commandを独立してもう一度実行し、完全な値を照合します。先頭・末尾
   だけの照合はしません。

## Fingerprintの登録・公開

公開鍵とactive recordを`release-signing/trusted-fingerprints.json`へreview付きPRで
追加します。key ID、完全な`SHA256:<64文字の小文字hex>` fingerprint、生成日、公開鍵
pathを記録します。同じ完全なfingerprintを次の全経路で公開します。

- `SECURITY.md`と署名付きdistribution guide
- その鍵を初めて使うGitHub Release note
- project website
- maintainerの既存Qiita/Zenn accountまたはDNS TXT record等、独立管理する経路を1つ以上

Releaseに同梱した`.pub.pem`だけでは信頼起点になりません。利用者は別経路で固定した
fingerprintと照合します。

## 署名・公開

信頼済みrelease workstationで署名します。checkoutが意図した署名済みtagで、cleanかつ
全test通過済みであることを確認し、repository外の秘密鍵pathを指定します。

```bash
npm run offline:bundle -- \
  --output dist/offline \
  --private-key /secure/offline/egressview-release-YYYY.key
```

Upload前に生成したarchive、checksum、signature、公開鍵を`npm run offline:verify`で検証し、
公開鍵fingerprintをactive registry entryと再照合します。uploadするのはarchive、checksum、
detached signature、公開鍵だけです。秘密鍵や署名workstationの作業dataはuploadしません。

Release noteにはartifact名、checksum、完全なfingerprint、signing key ID、検証guideへのlinkを
記載します。可能なら別maintainerがdownload後のfileを検証します。単独maintainerの場合は、
告知前に別のclean環境からdownloadして検証します。

## Rotation・漏えい対応

計画rotationでは、旧鍵と新鍵で個別に署名したartifactを1 releaseだけ併記し、両fingerprintを
独立経路でも告知します。overlap releaseの公開後に旧鍵を`retired`へ変更します。

漏えいの疑いがあればreleaseを直ちに停止します。鍵を`revoked`にし、完全なfingerprintと
incident日を全公開経路で告知し、activeな署名環境から削除します。clean workstationで新鍵を
生成し、review済みtagから影響artifactを再構築します。既存GitHub Releaseのartifactを、
明示的なincident noticeと新versionなしに差し替えません。
