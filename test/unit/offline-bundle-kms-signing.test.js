// KMS signing path for the offline distribution (P2-70)
// Run: node --test test/unit/offline-bundle-kms-signing.test.js
//
// The release key lives in AWS KMS and is never present locally, so these
// cases stub the `aws` CLI with a local Ed25519 key. That keeps the test
// runnable without credentials while still exercising the real contract:
// build-offline-bundle.js must turn whatever KMS returns into a detached raw
// signature and a PEM public key that the *unmodified* verifier accepts.
//
// The disposable key here is generated per run and never leaves the temp dir.
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'build-offline-bundle.js');
const { parseArgs } = require(SCRIPT);
const { verify: verifyBundle } = require('../../scripts/verify-offline-bundle');
const { verifyDetached } = require('../../scripts/ed25519-signature');

/**
 * A stand-in for the AWS CLI backed by a local key. It answers the two
 * subcommands the signer uses and rejects anything else, so a change in how
 * the script calls `aws` shows up as a failure instead of passing silently.
 */
function installAwsStub(dir, keyPath) {
  const stub = path.join(dir, 'aws');
  fs.writeFileSync(stub, `#!${process.execPath}
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const key = crypto.createPrivateKey(fs.readFileSync(${JSON.stringify(keyPath)}));
const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
if (args[0] === 'kms' && args[1] === 'sign' && option('--query') === 'Signature') {
  const messageArg = option('--message');
  if (!messageArg.startsWith('fileb://')) process.exit(1);
  const message = fs.readFileSync(messageArg.slice('fileb://'.length));
  process.stdout.write(crypto.sign(null, message, key).toString('base64'));
} else if (args[0] === 'kms' && args[1] === 'get-public-key' && option('--query') === 'PublicKey') {
  process.stdout.write(crypto.createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64'));
} else {
  process.stderr.write('unexpected aws subcommand');
  process.exitCode = 1;
}
`, { mode: 0o755 });
  return stub;
}

function buildWithStubbedKms(dir, extraArgs = []) {
  const keyPath = path.join(dir, 'signing.key');
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(keyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }));
  installAwsStub(dir, keyPath);
  const output = path.join(dir, 'dist');
  const stdout = execFileSync(process.execPath, [
    SCRIPT, '--output', output, '--kms-key-id', 'alias/test-key', ...extraArgs,
  ], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8' });
  return { result: JSON.parse(stdout), keyPath };
}

function verify(publicKey, signature, message) {
  verifyDetached(fs.readFileSync(message), fs.readFileSync(signature), publicKey);
}

describe('offline bundle: KMS 署名', () => {
  // Building the bundle packs a ~10 MB tarball, so do it once and assert the
  // separate properties against that one artifact. Rebuilding per case added
  // about 14 s to a suite that otherwise runs in ~3 s.
  let dir;
  let result;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-kms-'));
    ({ result } = buildWithStubbedKms(dir, ['--region', 'ap-northeast-1']));
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('検証側を変更せずに検証できる署名を出力する', () => {
    // KMS output must be accepted by the normal offline verifier.
    assert.doesNotThrow(() => verify(result.publicKey, result.signature, result.checksum));
    assert.doesNotThrow(() => verifyBundle({
      artifact: result.artifact,
      checksum: result.checksum,
      signature: result.signature,
      'public-key': result.publicKey,
    }));
  });

  it('署名は生のEd25519（64バイト、DER包装なし）', () => {
    assert.equal(fs.statSync(result.signature).size, 64);
  });

  it('公開鍵をPEMで出力し、DERの中間ファイルを残さない', () => {
    assert.match(fs.readFileSync(result.publicKey, 'utf8'), /^-----BEGIN PUBLIC KEY-----/);
    // No intermediate DER file belongs next to the release.
    assert.equal(fs.existsSync(`${result.publicKey}.der`), false);
  });

  it('チェックサムを1バイトでも変えると検証に失敗する', () => {
    const tampered = `${result.checksum}.tampered`;
    fs.copyFileSync(result.checksum, tampered);
    fs.appendFileSync(tampered, 'x');
    assert.throws(() => verify(result.publicKey, result.signature, tampered));
  });
});

describe('offline bundle: 署名オプションの検証', () => {
  it('--kms-key-id だけで署名指定として認める', () => {
    const options = parseArgs(['--output', '/tmp/x', '--kms-key-id', 'alias/k']);
    assert.equal(options['kms-key-id'], 'alias/k');
  });

  it('--private-key と --kms-key-id の同時指定を拒否する', () => {
    // Accepting both would leave which key actually signed the release
    // ambiguous, which is exactly what a signature is supposed to settle.
    assert.throws(
      () => parseArgs(['--output', '/tmp/x', '--private-key', '/tmp/k', '--kms-key-id', 'alias/k']),
      /mutually exclusive/
    );
  });

  it('どちらも無ければ拒否する（--unsigned true の明示を要求）', () => {
    assert.throws(
      () => parseArgs(['--output', '/tmp/x']),
      /--private-key or --kms-key-id is required/
    );
  });

  it('--unsigned true なら署名なしを許す', () => {
    assert.doesNotThrow(() => parseArgs(['--output', '/tmp/x', '--unsigned', 'true']));
  });

  it('--unsigned が true 以外なら署名を要求する', () => {
    for (const value of ['false', 'yes', '1', '']) {
      assert.throws(() => parseArgs(['--output', '/tmp/x', '--unsigned', value]));
    }
  });
});
