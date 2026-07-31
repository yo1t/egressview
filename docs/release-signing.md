# Release signing key procedure

> [Japanese / 日本語](release-signing.ja.md)

This procedure establishes the trust anchor for official signed portable
releases. The CI workflow uses disposable test keys and does not establish
release authenticity. Until `release-signing/trusted-fingerprints.json` contains
an active key, releases must not be described as signed by the project key.

## Key ceremony

1. Use a patched, administrator-controlled workstation. Disconnect unnecessary
   network access and set `umask 077`.
2. Generate a passphrase-encrypted Ed25519 key outside the repository:

   ```bash
   umask 077
   openssl genpkey -algorithm ED25519 -aes-256-cbc \
     -out /secure/offline/egressview-release-YYYY.key
   openssl pkey -in /secure/offline/egressview-release-YYYY.key -pubout \
     -out /tmp/egressview-release-YYYY.pub.pem
   node scripts/release-key-fingerprint.js \
     /tmp/egressview-release-YYYY.pub.pem
   ```

3. Store the primary private key on an encrypted offline volume. Keep one
   separately encrypted recovery copy in a different physical location. Store
   the passphrase separately from both copies. Limit access to named release
   maintainers and record each access.
4. Never store the private key in Git, GitHub Actions secrets/artifacts, a CI
   runner, project `.env` files, logs, chat, tickets, or an EC2 instance.
5. Independently repeat the fingerprint command and compare the complete value.
   Do not compare only a prefix or suffix.

## Enrol and publish the fingerprint

Add the public key and an active record to
`release-signing/trusted-fingerprints.json` in a reviewed pull request. Record a
key ID, the complete `SHA256:<64 lowercase hex>` fingerprint, creation date, and
public-key path. Publish the same full fingerprint in all of these locations:

- `SECURITY.md` and the signed-distribution guide;
- the GitHub release notes that first use the key;
- the project website;
- at least one independently controlled channel, such as the maintainer's
  established Qiita/Zenn account or a DNS TXT record.

The `.pub.pem` file shipped beside a release is not a trust anchor by itself.
Users must compare it with the pinned fingerprint from another channel.

## Sign and release

Perform signing on the trusted release workstation. Verify that the checkout is
the intended signed tag, clean, and fully tested. Build with the private key path
outside the repository:

```bash
npm run offline:bundle -- \
  --output dist/offline \
  --private-key /secure/offline/egressview-release-YYYY.key
```

Before upload, run `npm run offline:verify` with the generated archive, checksum,
signature, and public key. Recalculate the public-key fingerprint and compare it
with the active registry entry. Upload only the archive, checksum, detached
signature, and public key. Never upload the private key or the signing workspace.

Release notes must state the artifact names, checksum, complete fingerprint,
signing key ID, and verification-guide link. A second maintainer should verify
the downloaded files when available; for a single-maintainer release, download
and verify them from a separate clean environment before announcing the release.

## Rotation and compromise

Planned rotation uses one overlap release signed separately by both the old and
new key, with both fingerprints announced through the independent channel. Mark
the old key `retired` only after the overlap release is available.

If compromise is suspected, stop releases immediately. Mark the key `revoked`,
publish the complete fingerprint and incident date through every publication
channel, remove it from active signing systems, create a new key on a clean
workstation, and rebuild affected artifacts from the reviewed tag. Never replace
artifacts in an existing GitHub release without a visible incident notice and a
new version.
