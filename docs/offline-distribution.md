# Signed offline-runtime distribution

> [Japanese / 日本語](offline-distribution.ja.md)

The portable distribution is for installations that may use the Internet
during install or upgrade but run EgressView without Internet access afterward.
It is not an air-gapped installer: `npm ci --omit=dev` downloads the exact
production dependencies recorded in `package-lock.json` on the target host.
This lets native modules such as `better-sqlite3` match the target OS and CPU.

The installer runs that `npm ci` with install scripts disabled, so native
modules come from the prebuilt binaries in their packages and the target needs
no compiler. `better-sqlite3` publishes prebuilds for darwin, linux, linuxmusl,
and win32 on arm64 and x64; installing on any other platform requires Python
and a C++ toolchain, and `npm ci --omit=dev --ignore-scripts=false` by hand.

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

The active release signing key is:

```text
key id       egressview-release-2026
algorithm    Ed25519
fingerprint  SHA256:6288265bd746d230a3637e3a520e2335f48dc939a4d76d7b05c44ea5baf3eccc
```

Compare the **complete** value. A prefix or suffix match is not a match. The
enrolled record is in
[`release-signing/trusted-fingerprints.json`](../release-signing/trusted-fingerprints.json),
and the same fingerprint is published in `SECURITY.md`, on the project site, and
through an independently controlled channel — agreement across those is what
makes it a trust anchor.

CI uses an ephemeral key only to test the signing path; it is not an official
release identity. See the [release signing procedure](release-signing.md) for
custody, publication, rotation, and compromise response.

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

Official releases are signed with an AWS KMS key held by the maintainer; see
[the release signing procedure](release-signing.md). You cannot sign an official
release, and that is the point — it is what the signature attests.

Building and signing your **own** distribution needs no AWS account. Use a local
Ed25519 key, kept outside the repository with mode `0600`:

```bash
openssl genpkey -algorithm ED25519 -out /secure/path/egressview-signing.key
npm run offline:bundle -- \
  --output dist/offline \
  --private-key /secure/path/egressview-signing.key
```

Verification is the same either way and never needs AWS: `openssl` and the
`.pub.pem` shipped beside the artifact are enough.

`--unsigned true` exists only for local development and must never be published
as an official release. The CI distribution gate generates a temporary key,
builds and verifies the bundle, installs its locked dependencies, loads
`better-sqlite3`, and starts the installed application in offline mode.
