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

- **In the repository** — `SECURITY.md`, the signed-distribution guide, the
  project website, and the GitHub release notes that first use the key. These
  are one control domain, not four: all of them are built from this repository
  and a single account compromise rewrites them together.
- **Outside the repository** — at least one channel under separate credentials.
  This is the part that carries the trust, and it is currently a DNS TXT record
  at `_egressview-release.egressview.com`, served from a different provider:

  ```console
  $ dig +short TXT _egressview-release.egressview.com
  "egressview-release-key=egressview-release-2026; fp=SHA256:6288...eccc; created=2026-08-05"
  ```

The `.pub.pem` file shipped beside a release is not a trust anchor by itself,
and neither is the repository. Users must compare it with a fingerprint obtained
from a channel that a compromise of this repository would not reach.

## Sign and release

**One command, run from a maintainer workstation.** Check out the tag, then:

```bash
aws sso login --sso-session egressview
```

```bash
AWS_PROFILE=egressview-release npm run release:publish -- --tag v2.0.3
```

That is the whole procedure. It is a single command on purpose: 2.0.0, 2.0.1
and 2.0.2 were all published with no signed assets, and the pipeline never
failed — it was never run, because releasing and signing were two separate
things a person had to remember to do in order. Three releases in a row are
enough evidence that remembering is not a control.

The order matters, and the command enforces it:

1. **Refuses to start** unless `HEAD` is exactly the tag, the tree is clean,
   and `npm run release:check` passes. A release built from a dirty tree is not
   the thing the tag names, and signing afterwards does not fix that.
2. Refuses a tag that is **already published**, before spending a build and a
   signature on it.
3. Builds and signs with the KMS key.
4. Verifies the bundle, then **proves three tamper cases fail**: a modified
   archive, a rewritten checksum, and a forged signature.
5. Compares the key fingerprint against the trust registry **and the DNS TXT
   record**, which is served under separate credentials from this repository.
   A fingerprint published only beside the artifact proves nothing.
6. Creates the release as a **draft** and uploads the four assets.
7. **Downloads those assets back from GitHub** and verifies what the release
   page actually serves — not what is on this disk.
8. Only then flips the draft to published.

**Draft-first is what makes an unsigned release impossible rather than merely
unlikely.** If any step fails, what exists is a draft, not a public release
with nothing to verify — which is exactly the state 2.0.x was left in.

Add `--dry-run` to exercise everything up to step 5 without creating anything
on GitHub.

### The gate behind it

`.github/workflows/release-gate.yml` runs `npm run release:verify-published`
when a release is published **or edited**, and weekly over the most recent
releases. It takes no manual input: a gate whose operator chooses what gets
checked is not a gate. To check one older tag, run
`npm run release:verify-published -- --tag <tag>` locally. It downloads what the release page serves and verifies that, so it
catches a release created another way — from the GitHub web interface, say —
and catches assets removed or replaced after publication. It needs no AWS
access.

Releases that predate this procedure and were never signed are recorded in
`release-signing/unsigned-releases.json` with a reason each, so the gate reports
a known fact instead of failing for ever. **A gate that always fails is one
people learn to ignore.** A test refuses any entry for a release published on
or after the policy date, so the list cannot become a way to quiet a new
failure.

### Signing stays on the workstation

It is tempting to give GitHub Actions an OIDC role with `kms:Sign` and remove
the human entirely. That would widen who can sign from *a person holding an SSO
session at a workstation* to *anything that executes in a workflow*, in a
project whose key policy restricts signing to a dedicated principal and whose
trust anchor is deliberately outside the repository. That trades a discipline
problem for a supply-chain problem. The key stays where it is; the workstation
step is one command.

`--private-key` remains available on `offline:bundle` and takes a local key file
instead of KMS. It exists for CI, which signs a throwaway artifact with a
disposable key on every pull request to exercise the mechanism, and for anyone
building their own distribution. **It does not produce an official release.**

### Release notes

Notes must state the artifact names, checksum, complete fingerprint, signing key
ID, and a link to the verification guide. Where the release number and the Hub
version differ — 2.0.2 carries Hub 1.10.0, and the assets are named for the Hub
version — say both, so the asset names and the notes cannot silently disagree.

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
