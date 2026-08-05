# Release signing key procedure

> [Japanese / 日本語](release-signing.ja.md)

This procedure establishes the trust anchor for official signed portable
releases. The CI workflow uses disposable local keys and does not establish
release authenticity. Until `release-signing/trusted-fingerprints.json` contains
an active key, releases must not be described as signed by the project key.

## Signing key

The release key is an asymmetric AWS KMS key. The private half is generated
inside KMS and cannot be exported, so there is no key file to store, back up,
lose, or leak. Signing requires an authenticated AWS principal rather than
possession of a file.

| | |
|---|---|
| Alias | `alias/egressview-release` |
| Region | `ap-northeast-1` |
| Spec | `ECC_NIST_EDWARDS25519`, `SIGN_VERIFY` |
| Signing algorithm | `ED25519_SHA_512`, `MessageType: RAW` |

**Only the `EgressViewRelease` permission set may sign.** That restriction lives
in the key policy, not in IAM alone: the account-administration statement
deliberately omits `kms:Sign`, so an administrator can manage the key —
rotate it, change its policy, schedule deletion — without being able to sign a
release with it. Do not grant `kms:Sign` to any other role, and in particular
not to an EC2 instance role: signing is done from a maintainer workstation and
no server needs the capability.

Sign in before a release:

```bash
aws sso login --profile egressview-release
```

To read the public key and its fingerprint:

```bash
aws kms get-public-key --profile egressview-release \
  --key-id alias/egressview-release --query PublicKey --output text \
  | base64 -d > /tmp/egressview-release.der
openssl pkey -pubin -inform DER -in /tmp/egressview-release.der \
  -out /tmp/egressview-release.pub.pem
node scripts/release-key-fingerprint.js /tmp/egressview-release.pub.pem
```

Repeat the fingerprint command independently and compare the complete value.
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

Sign on a maintainer workstation. Verify that the checkout is the intended
signed tag, clean, and fully tested. Build with the KMS key:

```bash
aws sso login --profile egressview-release
AWS_PROFILE=egressview-release npm run offline:bundle -- \
  --output dist/offline \
  --kms-key-id alias/egressview-release \
  --region ap-northeast-1
```

`--private-key` remains available and takes a local key file instead. It exists
for CI, which signs a throwaway artifact with a disposable key to exercise the
mechanism, and for anyone building their own distribution. It does not produce
an official release. The two options are mutually exclusive.

Before upload, run `npm run offline:verify` with the generated archive,
checksum, signature, and public key. That command needs neither AWS access nor
the AWS CLI: the signature is a raw Ed25519 signature over the checksum file,
verified with `openssl` and the shipped `.pub.pem`. Recalculate the public-key
fingerprint and compare it with the active registry entry. Upload only the
archive, checksum, detached signature, and public key.

Release notes must state the artifact names, checksum, complete fingerprint,
signing key ID, and verification-guide link. A second maintainer should verify
the downloaded files when available; for a single-maintainer release, download
and verify them from a separate clean environment before announcing the
release.

## Rotation and compromise

Planned rotation uses one overlap release signed separately by both the old and
new key, with both fingerprints announced through the independent channel. Mark
the old key `retired` only after the overlap release is available.

Because the overlap release has to be signed with the old key, **do not schedule
deletion of a KMS key at rotation time.** Deletion is irreversible once the
pending window expires. Verification never needs the key — it uses the shipped
public key and `openssl` — so a retired key costs $1/month and buys back the
ability to sign again if something goes wrong. Keep it unless there is a
specific reason not to.

If compromise is suspected, stop releases immediately. Mark the key `revoked`,
publish the complete fingerprint and incident date through every publication
channel, disable the KMS key or remove `kms:Sign` from the release permission set,
create a new key, and rebuild affected artifacts from the reviewed tag. Never replace
artifacts in an existing GitHub release without a visible incident notice and a
new version.
