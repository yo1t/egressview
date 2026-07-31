# Signed offline-runtime distribution

> [Japanese / 日本語](offline-distribution.ja.md)

The portable distribution is for installations that may use the Internet
during install or upgrade but run EgressView without Internet access afterward.
It is not an air-gapped installer: `npm ci --omit=dev` downloads the exact
production dependencies recorded in `package-lock.json` on the target host.
This lets native modules such as `better-sqlite3` match the target OS and CPU.

## Release files

Each release consists of four files:

- `egressview-offline-VERSION.tar.gz`: cloud- and platform-neutral source;
- `.sha256`: SHA-256 checksum for that exact archive;
- `.sig`: Ed25519 detached signature over the checksum file;
- `.pub.pem`: release public key.

The archive also contains a CycloneDX SBOM, the exact dependency lock, a
per-file SHA-256 manifest, and the atomic installer. It must not contain a
credential, runtime configuration, database, log, private key, real LAN address,
or Git history.

The public key beside an archive is not its own trust anchor. Compare its
fingerprint with the fingerprint announced through a separate trusted release
channel before accepting it:

```bash
openssl pkey -pubin -in egressview-offline-VERSION.tar.gz.pub.pem \
  -outform DER | openssl dgst -sha256
```

CI uses an ephemeral key only to test the signing path. An official release
must use the protected project release key and publish its pinned fingerprint.

## Verify before extraction

```bash
ARTIFACT=egressview-offline-VERSION.tar.gz

openssl pkeyutl -verify -rawin -pubin \
  -inkey "${ARTIFACT}.pub.pem" \
  -sigfile "${ARTIFACT}.sig" \
  -in "${ARTIFACT}.sha256"

sha256sum -c "${ARTIFACT}.sha256"
```

On macOS, use `shasum -a 256 -c "${ARTIFACT}.sha256"` for the second command.
Do not extract or run the installer if either check fails.

## Install or upgrade

Node.js 22+, npm, OpenSSL 3, `tar`, temporary Internet access to the npm
registry, and a writable installation prefix are required.

```bash
tar -xzf "$ARTIFACT"
sudo node "egressview-offline-VERSION/offline-install.js" install \
  --prefix /opt/egressview
```

`upgrade` is an alias of the same verified installation path. A release is
copied into `/opt/egressview/releases/VERSION`, dependencies are installed and
the native SQLite module is loaded successfully before the `current` symlink is
changed. The old target becomes `previous`. A failed download, build, or native
load leaves `current` unchanged.

Keep mutable data outside the release directory:

```bash
EGRESSVIEW_CONFIG_PATH=/var/lib/egressview/config.json
EGRESSVIEW_DB_PATH=/var/lib/egressview/egressview.db
EGRESSVIEW_BACKUP_DIR=/var/lib/egressview/backups
EGRESSVIEW_OFFLINE_MODE=true
```

After dependencies are installed, outbound Internet access can be removed
before starting `/opt/egressview/current/server.js`.

## Rollback

```bash
sudo node /opt/egressview/tools/offline-install.js rollback \
  --prefix /opt/egressview
```

Rollback first verifies that both release targets exist, then atomically
activates `previous` as `current` and records the former target as `previous`.
The two link updates are not one filesystem transaction, but `current` always
points to a complete installed release. Rollback does not change the external
configuration, database, backups, or logs. If a release introduced a database
migration, follow that release's database rollback instructions as well. Never
run an older binary against a migrated database merely because the process
starts.

## Build and sign

Keep the Ed25519 private key outside the repository with mode `0600` and back it
up through the release-key procedure:

```bash
npm run offline:bundle -- \
  --output dist/offline \
  --private-key /secure/path/egressview-offline-signing.key
```

`--unsigned true` exists only for local development and must never be published
as an official release. The CI distribution gate generates a temporary key,
builds and verifies the bundle, installs its locked dependencies, loads
`better-sqlite3`, and starts the installed application in offline mode.
