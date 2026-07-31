# 署名付きオフライン稼働用distribution

> [English](offline-distribution.md)

このportable distributionは、install/upgrade時にはInternetを利用できるが、
稼働開始後はInternetへ接続しない環境向けです。完全閉域installerではありません。
導入先で`npm ci --omit=dev`を実行し、`package-lock.json`に固定したproduction依存を
取得します。これにより`better-sqlite3`等のnative moduleを導入先のOS/CPUへ
正しく合わせられます。

## Release file

各releaseは次の4ファイルで構成します。

- `egressview-offline-VERSION.tar.gz`: cloud/platform非依存のsource
- `.sha256`: archiveのSHA-256 checksum
- `.sig`: checksum fileに対するEd25519 detached signature
- `.pub.pem`: release公開鍵

Archive内にはCycloneDX SBOM、依存lock、全ファイルのSHA-256 manifest、原子的
installerも含みます。credential、runtime設定、DB、log、秘密鍵、実LAN IP、
Git履歴は含めません。

Archiveと同じ場所にある公開鍵だけでは信頼の起点になりません。受け入れる前に、
別の信頼済みrelease channelで告知したfingerprintと比較します。

```bash
openssl pkey -pubin -in egressview-offline-VERSION.tar.gz.pub.pem \
  -outform DER | openssl dgst -sha256
```

CIの鍵は署名経路の試験専用で毎回破棄します。正式releaseは保護したproject release
鍵を使い、固定fingerprintを別経路でも公開する必要があります。

## 展開前の検証

```bash
ARTIFACT=egressview-offline-VERSION.tar.gz

openssl pkeyutl -verify -rawin -pubin \
  -inkey "${ARTIFACT}.pub.pem" \
  -sigfile "${ARTIFACT}.sig" \
  -in "${ARTIFACT}.sha256"

sha256sum -c "${ARTIFACT}.sha256"
```

macOSでは2番目を`shasum -a 256 -c "${ARTIFACT}.sha256"`に置き換えます。
どちらかが失敗した場合、展開もinstaller実行も行いません。

## Install / upgrade

Node.js 22以上、npm、OpenSSL 3、`tar`、npm registryへの一時的Internet接続、
書き込み可能なinstall prefixが必要です。

```bash
tar -xzf "$ARTIFACT"
sudo node "egressview-offline-VERSION/offline-install.js" install \
  --prefix /opt/egressview
```

`upgrade`も同じ検証済みinstall経路を使います。releaseを
`/opt/egressview/releases/VERSION`へ複製し、依存取得とnative SQLite loadに
成功してから`current` symlinkを切り替えます。旧releaseは`previous`になります。
download、build、native loadのいずれかが失敗しても`current`は変わりません。

可変dataはrelease directory外へ置きます。

```bash
EGRESSVIEW_CONFIG_PATH=/var/lib/egressview/config.json
EGRESSVIEW_DB_PATH=/var/lib/egressview/egressview.db
EGRESSVIEW_BACKUP_DIR=/var/lib/egressview/backups
EGRESSVIEW_OFFLINE_MODE=true
```

依存取得完了後、`/opt/egressview/current/server.js`を起動する前に外向きInternet接続を
遮断できます。

## Rollback

```bash
sudo node /opt/egressview/tools/offline-install.js rollback \
  --prefix /opt/egressview
```

Rollbackは両方のrelease targetが存在することを確認してから、`previous`を
`current`として原子的に有効化し、旧targetを`previous`へ記録します。2本のlink更新
全体は単一filesystem transactionではありませんが、`current`は常に導入完了済み
releaseを指します。外部の設定、DB、backup、logは変更しません。DB migrationを
含むreleaseでは、そのrelease固有のDB rollback手順も実行します。単に旧binaryが
起動するという理由でmigration後DBへ接続しません。

## Build / sign

Ed25519秘密鍵はrepository外へmode `0600`で保存し、release鍵手順に従ってbackupします。

```bash
npm run offline:bundle -- \
  --output dist/offline \
  --private-key /secure/path/egressview-offline-signing.key
```

`--unsigned true`はlocal開発専用で、正式releaseとして公開しません。CI gateは一時鍵を
生成してbundleの構築・検証、lock済み依存のinstall、`better-sqlite3` load、
install済みapplicationのoffline mode起動を確認します。
