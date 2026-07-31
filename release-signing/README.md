# Trusted release keys

This directory is the machine-readable trust registry for official EgressView
offline-distribution signing keys. It intentionally contains no production key
yet. An empty `keys` array means that no release may be represented as signed by
an official project key.

Only reviewed `*.pub.pem` public keys and fingerprints may be committed here. Private keys, recovery
material, passphrases, and signing logs must never enter the repository. Follow
[the release signing procedure](../docs/release-signing.md) before enrolling the
first key.
