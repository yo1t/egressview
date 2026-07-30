'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  DEPLOYMENT_PROFILES,
  PROFILE_IDS,
  resolveDeploymentProfile,
} = require('../../src/deployment-profile');

describe('deployment profile contract', () => {
  it('defines the four portable deployment profiles', () => {
    assert.deepEqual(PROFILE_IDS, [
      'local-stdio',
      'private-http',
      'private-oauth',
      'public-oauth',
    ]);
    assert.equal(DEPLOYMENT_PROFILES['local-stdio'].internetRequired, false);
    assert.equal(DEPLOYMENT_PROFILES['private-http'].internetExposure, 'prohibited');
    assert.equal(DEPLOYMENT_PROFILES['private-oauth'].identityProvider, 'internal-oidc');
    assert.equal(DEPLOYMENT_PROFILES['public-oauth'].offlineCapable, false);
  });

  it('infers backward-compatible profiles when none is configured', () => {
    assert.equal(resolveDeploymentProfile({}, {
      httpEnabled: false,
      authMode: null,
    }).id, 'local-stdio');
    assert.equal(resolveDeploymentProfile({}, {
      httpEnabled: true,
      authMode: 'token',
    }).id, 'private-http');
    assert.equal(resolveDeploymentProfile({}, {
      httpEnabled: true,
      authMode: 'oauth',
    }).id, 'public-oauth');
  });

  it('accepts private OAuth without requiring a public deployment', () => {
    const profile = resolveDeploymentProfile({
      EGRESSVIEW_DEPLOYMENT_PROFILE: 'private-oauth',
    }, {
      httpEnabled: true,
      authMode: 'oauth',
    });
    assert.equal(profile.internetRequired, false);
    assert.equal(profile.internetExposure, 'prohibited');
    assert.equal(profile.configured, true);
  });

  it('rejects transport and authentication mismatches', () => {
    assert.throws(
      () => resolveDeploymentProfile({
        EGRESSVIEW_DEPLOYMENT_PROFILE: 'private-http',
      }, {
        httpEnabled: false,
        authMode: null,
      }),
      /requires HTTP transport/
    );
    assert.throws(
      () => resolveDeploymentProfile({
        EGRESSVIEW_DEPLOYMENT_PROFILE: 'public-oauth',
      }, {
        httpEnabled: true,
        authMode: 'token',
      }),
      /requires MCP_AUTH_MODE=oauth/
    );
  });

  it('rejects unknown profile names', () => {
    assert.throws(
      () => resolveDeploymentProfile({
        EGRESSVIEW_DEPLOYMENT_PROFILE: 'aws-only',
      }, {
        httpEnabled: true,
        authMode: 'oauth',
      }),
      /must be one of/
    );
  });
});
