import CryptoKit
import Foundation

/// The trust anchor for automatic updates.
///
/// Automatic updating is a path by which we can cause code to run on someone
/// else's Mac, so the key is compiled in rather than fetched. Nothing the agent
/// downloads can introduce a new signer.
///
/// The same key signs offline release bundles, and its fingerprint is published
/// in the `_egressview-release.egressview.com` TXT record and in `SECURITY.md`.
/// Anyone can compare the constant below with those two places without trusting
/// the agent.
public enum AgentReleaseKey {
    public static let identifier = "egressview-release-2026"

    /// Raw Ed25519 public key, the 32 bytes that follow the fixed SPKI header.
    private static let rawRepresentation = Data(base64Encoded: "jLUS+Q2VoyonFtVcv2Z2cnKf6e0sjC9S+9scCg26BU8=")!

    /// Published fingerprint: SHA-256 over the SPKI DER encoding, which is what
    /// `scripts/release-key-fingerprint.js` prints and what the DNS TXT record
    /// carries.
    public static let publishedFingerprint =
        "SHA256:6288265bd746d230a3637e3a520e2335f48dc939a4d76d7b05c44ea5baf3eccc"

    /// The 12-byte prefix every Ed25519 SPKI encoding starts with. Prepending it
    /// to the raw key reproduces the exact bytes the published fingerprint was
    /// taken over.
    private static let spkiHeader = Data([
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ])

    public static var publicKey: Curve25519.Signing.PublicKey {
        // Force-unwrapped deliberately: a build whose embedded key is malformed
        // must fail loudly here, not silently accept every update later.
        try! Curve25519.Signing.PublicKey(rawRepresentation: rawRepresentation)
    }

    /// Fingerprint of the key actually compiled into this build.
    public static var fingerprint: String {
        let digest = SHA256.hash(data: spkiHeader + rawRepresentation)
        return "SHA256:" + digest.map { String(format: "%02x", $0) }.joined()
    }

    /// True when the embedded key is the one published for this project. Checked
    /// before any update is accepted so that a build carrying a substituted key
    /// refuses to update rather than trusting the substitution.
    public static var matchesPublishedFingerprint: Bool {
        fingerprint == publishedFingerprint
    }

    public static func isValidSignature(_ signature: Data, for message: Data) -> Bool {
        guard matchesPublishedFingerprint else { return false }
        return publicKey.isValidSignature(signature, for: message)
    }
}
