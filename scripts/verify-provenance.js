#!/usr/bin/env node
'use strict';

/**
 * Verify a release's provenance against the artifact it claims to describe.
 *
 * Needs neither AWS access nor the AWS CLI, like the bundle verification it
 * sits beside: the signature is Ed25519 over the DSSE pre-authentication
 * encoding, checked with the shipped public key.
 *
 * Two things are checked, and the second is the one that matters. That the
 * envelope's signature is valid, and that the digest inside it is the digest
 * of the artifact on disk. A valid signature over a statement about a
 * different file proves nothing about this one.
 */

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { pae, PAYLOAD_TYPE, PREDICATE_TYPE, STATEMENT_TYPE } = require('./build-provenance');

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--artifact') options.artifact = argv[++i];
    else if (flag === '--provenance') options.provenance = argv[++i];
    else if (flag === '--public-key') options.publicKey = argv[++i];
    else throw new Error(`Unknown option: ${flag}`);
  }
  for (const required of ['artifact', 'provenance', 'publicKey']) {
    if (!options[required]) throw new Error(`--${required.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`);
  }
  return options;
}

function verify(options) {
  const lines = fs.readFileSync(options.provenance, 'utf8').split('\n').filter(Boolean);
  if (lines.length !== 1) throw new Error(`Expected one envelope, found ${lines.length}`);
  const envelope = JSON.parse(lines[0]);

  if (envelope.payloadType !== PAYLOAD_TYPE) {
    throw new Error(`Unexpected payload type: ${envelope.payloadType}`);
  }
  if (!envelope.signatures?.length) throw new Error('Envelope carries no signature');

  const payload = Buffer.from(envelope.payload, 'base64').toString('utf8');
  const message = pae(envelope.payloadType, payload);

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-provenance-'));
  try {
    const messagePath = path.join(scratch, 'pae.bin');
    const signaturePath = path.join(scratch, 'sig.bin');
    fs.writeFileSync(messagePath, message);
    fs.writeFileSync(signaturePath, Buffer.from(envelope.signatures[0].sig, 'base64'));
    execFileSync('openssl', [
      'pkeyutl', '-verify', '-rawin', '-pubin',
      '-inkey', options.publicKey,
      '-sigfile', signaturePath,
      '-in', messagePath,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  const statement = JSON.parse(payload);
  if (statement._type !== STATEMENT_TYPE) throw new Error(`Unexpected statement type: ${statement._type}`);
  if (statement.predicateType !== PREDICATE_TYPE) {
    throw new Error(`Unexpected predicate type: ${statement.predicateType}`);
  }

  // The check that makes the signature mean something about this file.
  const actual = crypto.createHash('sha256')
    .update(fs.readFileSync(options.artifact)).digest('hex');
  const subject = statement.subject.find(
    (s) => s.name === path.basename(options.artifact)
  );
  if (!subject) {
    throw new Error(`Provenance describes ${statement.subject.map((s) => s.name).join(', ')}, not ${path.basename(options.artifact)}`);
  }
  if (subject.digest.sha256 !== actual) {
    throw new Error('Provenance describes a different artifact than the one given');
  }

  return {
    verified: true,
    subject: subject.name,
    commit: statement.predicate.buildDefinition.externalParameters.commit,
    builder: statement.predicate.runDetails.builder.id,
    buildLevel: statement.predicate['x-slsaBuildLevel'],
  };
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(verify(parseArgs(process.argv.slice(2))))}\n`);
  } catch (error) {
    process.stderr.write(`Provenance verification failed: ${error.message}\n`);
    process.exit(1);
  }
}

module.exports = { verify, parseArgs };
