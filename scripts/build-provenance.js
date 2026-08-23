#!/usr/bin/env node
'use strict';

/**
 * Build and sign SLSA provenance for a release artifact (P2-88).
 *
 * The signature already published says the artifact is the one this project
 * signed. It says nothing about where the artifact came from. Provenance is
 * the second statement: this commit, built this way, by this builder.
 *
 * **The build is not hermetic and this document does not claim it is.** The
 * release is produced on a maintainer workstation, deliberately -- moving the
 * signing key into CI would widen who can sign from a person holding an SSO
 * session to anything that executes in a workflow. That choice caps this at
 * SLSA Build L2: the provenance exists, is authenticated, and is distributed
 * with the artifact, but the builder is not a hosted, isolated service. The
 * predicate says so rather than leaving a reader to assume otherwise.
 *
 * The envelope is DSSE, and the signature is over the pre-authentication
 * encoding rather than over the raw payload, so the payload type cannot be
 * swapped for another while keeping the signature valid.
 */

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PAYLOAD_TYPE = 'application/vnd.in-toto+json';
const STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
const PREDICATE_TYPE = 'https://slsa.dev/provenance/v1';
const BUILD_TYPE = 'https://egressview.com/buildtypes/offline-bundle/v1';
// SLSA build level this can honestly claim. The builder is a workstation, so
// L3 -- which requires a hosted, isolated build service -- is not available
// without moving the signing key, and that trade has been declined.
const BUILD_LEVEL = 'SLSA_BUILD_LEVEL_2';
const KMS_MAX_RAW_MESSAGE_BYTES = 4096;

function run(command, args) {
  return execFileSync(command, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * DSSE pre-authentication encoding. Signing the payload alone would let the
 * declared type be changed while the signature still verified.
 */
function pae(payloadType, payload) {
  const type = Buffer.from(payloadType, 'utf8');
  const body = Buffer.from(payload, 'utf8');
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${type.length} `, 'utf8'), type,
    Buffer.from(` ${body.length} `, 'utf8'), body,
  ]);
}

function statement({ artifact, artifactName, commit, repository, builderId, buildStartedOn }) {
  return {
    _type: STATEMENT_TYPE,
    subject: [{ name: artifactName, digest: { sha256: sha256(artifact) } }],
    predicateType: PREDICATE_TYPE,
    predicate: {
      buildDefinition: {
        buildType: BUILD_TYPE,
        externalParameters: {
          repository,
          // The tag is not recorded here: a tag can be moved, a commit cannot.
          commit,
        },
        resolvedDependencies: [{
          uri: `git+${repository}@${commit}`,
          digest: { gitCommit: commit },
        }],
      },
      runDetails: {
        builder: {
          id: builderId,
          // Stated, not implied. A reader comparing this against a hosted
          // builder's provenance should be able to see the difference without
          // having to know the project.
          version: { note: 'Maintainer workstation; the build is not hermetic' },
        },
        metadata: {
          invocationId: crypto.randomUUID(),
          startedOn: buildStartedOn,
          finishedOn: new Date().toISOString(),
        },
      },
      'x-slsaBuildLevel': BUILD_LEVEL,
    },
  };
}

function signWithKms({ keyId, region, message }) {
  if (message.length > KMS_MAX_RAW_MESSAGE_BYTES) {
    throw new Error(
      `Pre-authentication encoding is ${message.length} bytes, above the KMS RAW limit `
      + `of ${KMS_MAX_RAW_MESSAGE_BYTES}`
    );
  }
  const tmp = path.join(
    fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'egressview-pae-')), 'pae.bin'
  );
  try {
    fs.writeFileSync(tmp, message, { mode: 0o600 });
    return run('aws', [
      'kms', 'sign', ...(region ? ['--region', region] : []),
      '--key-id', keyId,
      '--message', `fileb://${tmp}`,
      '--message-type', 'RAW',
      '--signing-algorithm', 'ED25519_SHA_512',
      '--query', 'Signature', '--output', 'text',
    ]).trim();
  } finally {
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  }
}

function build({ artifact, keyId, region, commit, repository, builderId, buildStartedOn, sign }) {
  const artifactName = path.basename(artifact);
  const payloadObject = statement({
    artifact, artifactName, commit, repository, builderId, buildStartedOn,
  });
  const payload = JSON.stringify(payloadObject);
  const encoded = Buffer.from(payload, 'utf8').toString('base64');
  const signature = (sign || signWithKms)({ keyId, region, message: pae(PAYLOAD_TYPE, payload) });
  return {
    envelope: {
      payloadType: PAYLOAD_TYPE,
      payload: encoded,
      signatures: [{ keyid: keyId, sig: signature }],
    },
    statement: payloadObject,
  };
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--artifact') options.artifact = argv[++i];
    else if (flag === '--output') options.output = argv[++i];
    else if (flag === '--kms-key-id') options.keyId = argv[++i];
    else if (flag === '--region') options.region = argv[++i];
    else if (flag === '--commit') options.commit = argv[++i];
    else if (flag === '--repository') options.repository = argv[++i];
    else if (flag === '--builder-id') options.builderId = argv[++i];
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (!options.artifact) throw new Error('--artifact is required');
  if (!options.keyId) throw new Error('--kms-key-id is required');
  options.output = options.output || `${options.artifact}.intoto.jsonl`;
  options.repository = options.repository || 'https://github.com/yo1t/egressview';
  options.builderId = options.builderId || 'https://egressview.com/builders/maintainer-workstation/v1';
  return options;
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  const commit = options.commit || run('git', ['rev-parse', 'HEAD']).trim();
  const { envelope } = build({
    ...options, commit, buildStartedOn: new Date().toISOString(),
  });
  // One JSON object per line: the .jsonl the ecosystem, and OpenSSF
  // Scorecard's Signed-Releases check, expect to find beside a release.
  fs.writeFileSync(options.output, `${JSON.stringify(envelope)}\n`, { mode: 0o644 });
  process.stdout.write(`${JSON.stringify({ provenance: options.output })}\n`);
}

module.exports = {
  build, pae, statement, parseArgs,
  PAYLOAD_TYPE, PREDICATE_TYPE, STATEMENT_TYPE, BUILD_TYPE, BUILD_LEVEL,
};
