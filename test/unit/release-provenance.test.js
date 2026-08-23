'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const provenance = require('../../scripts/build-provenance');
const { verify } = require('../../scripts/verify-provenance');

// A throwaway key, so the whole envelope can be produced and checked without
// AWS. The KMS path differs only in where the Ed25519 signature comes from.
function scratchKey(dir) {
  const priv = path.join(dir, 'key.pem');
  const pub = path.join(dir, 'key.pub.pem');
  execFileSync('openssl', ['genpkey', '-algorithm', 'ed25519', '-out', priv], { stdio: 'ignore' });
  execFileSync('openssl', ['pkey', '-in', priv, '-pubout', '-out', pub], { stdio: 'ignore' });
  return { priv, pub };
}

function signLocally(priv) {
  return ({ message }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-sign-'));
    try {
      const m = path.join(dir, 'm.bin');
      const s = path.join(dir, 's.bin');
      fs.writeFileSync(m, message);
      execFileSync('openssl', ['pkeyutl', '-sign', '-rawin', '-inkey', priv, '-in', m, '-out', s]);
      return fs.readFileSync(s).toString('base64');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-provenance-test-'));
  const artifact = path.join(dir, 'egressview-offline-9.9.9.tar.gz');
  fs.writeFileSync(artifact, 'not really a tarball, but it has a digest\n');
  const { priv, pub } = scratchKey(dir);
  const { envelope } = provenance.build({
    artifact,
    keyId: 'test-key',
    commit: 'a'.repeat(40),
    repository: 'https://github.com/yo1t/egressview',
    builderId: 'https://egressview.com/builders/test/v1',
    buildStartedOn: new Date().toISOString(),
    sign: signLocally(priv),
  });
  const file = `${artifact}.intoto.jsonl`;
  fs.writeFileSync(file, `${JSON.stringify(envelope)}\n`);
  return { dir, artifact, provenanceFile: file, publicKey: pub, envelope };
}

describe('release provenance (P2-88)', () => {
  it('生成した証跡が検証を通る', () => {
    const f = fixture();
    try {
      const result = verify({
        artifact: f.artifact, provenance: f.provenanceFile, publicKey: f.publicKey,
      });
      assert.equal(result.verified, true);
      assert.equal(result.commit, 'a'.repeat(40));
    } finally {
      fs.rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('別の成果物を指す証跡を受け付けない', () => {
    // The check that makes the signature mean something about this file. A
    // valid signature over a statement about a different artifact proves
    // nothing about the one in front of you.
    const f = fixture();
    try {
      fs.writeFileSync(f.artifact, 'a different file entirely\n');
      assert.throws(
        () => verify({ artifact: f.artifact, provenance: f.provenanceFile, publicKey: f.publicKey }),
        /different artifact/
      );
    } finally {
      fs.rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('payloadを差し替えたら落ちる', () => {
    const f = fixture();
    try {
      const tampered = JSON.parse(JSON.stringify(f.envelope));
      const statement = JSON.parse(Buffer.from(tampered.payload, 'base64').toString('utf8'));
      statement.predicate.buildDefinition.externalParameters.commit = 'b'.repeat(40);
      tampered.payload = Buffer.from(JSON.stringify(statement)).toString('base64');
      fs.writeFileSync(f.provenanceFile, `${JSON.stringify(tampered)}\n`);
      assert.throws(
        () => verify({ artifact: f.artifact, provenance: f.provenanceFile, publicKey: f.publicKey })
      );
    } finally {
      fs.rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('payloadTypeの差し替えも落ちる', () => {
    // Why the signature is over the pre-authentication encoding rather than
    // over the payload: otherwise the declared type could be changed while the
    // signature still verified.
    const f = fixture();
    try {
      const tampered = { ...f.envelope, payloadType: 'application/json' };
      fs.writeFileSync(f.provenanceFile, `${JSON.stringify(tampered)}\n`);
      assert.throws(
        () => verify({ artifact: f.artifact, provenance: f.provenanceFile, publicKey: f.publicKey }),
        /payload type/
      );
    } finally {
      fs.rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('hermeticでないことを証跡自身が述べる', () => {
    // The build happens on a workstation, deliberately: moving the signing key
    // into CI would widen who can sign. A reader should be able to see that
    // from the document rather than having to know the project.
    const f = fixture();
    try {
      const statement = JSON.parse(Buffer.from(f.envelope.payload, 'base64').toString('utf8'));
      assert.equal(statement.predicate['x-slsaBuildLevel'], 'SLSA_BUILD_LEVEL_2');
      assert.match(statement.predicate.runDetails.builder.version.note, /not hermetic/);
    } finally {
      fs.rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('tagではなくcommitを記録する', () => {
    // A tag can be moved; a commit cannot.
    const f = fixture();
    try {
      const statement = JSON.parse(Buffer.from(f.envelope.payload, 'base64').toString('utf8'));
      const params = statement.predicate.buildDefinition.externalParameters;
      assert.match(params.commit, /^[0-9a-f]{40}$/);
      assert.equal('tag' in params, false, 'a tag is recorded as if it identified the source');
    } finally {
      fs.rmSync(f.dir, { recursive: true, force: true });
    }
  });
});
