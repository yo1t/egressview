'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  DEPLOYMENT_PROFILES,
  PROFILE_IDS,
  resolveMcpBindConfig,
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

  it('keeps HTTP on IPv4 or IPv6 loopback by default', () => {
    const profile = resolveDeploymentProfile({
      EGRESSVIEW_DEPLOYMENT_PROFILE: 'private-http',
    }, {
      httpEnabled: true,
      authMode: 'token',
    });
    assert.deepEqual(resolveMcpBindConfig({}, profile), {
      address: '127.0.0.1',
      loopback: true,
      explicitlyApproved: false,
    });
    assert.equal(resolveMcpBindConfig({ MCP_BIND_ADDRESS: '::1' }, profile).loopback, true);
  });

  it('requires an explicit profile and approval for non-loopback bind', () => {
    const inferred = resolveDeploymentProfile({}, {
      httpEnabled: true,
      authMode: 'token',
    });
    assert.throws(
      () => resolveMcpBindConfig({
        MCP_BIND_ADDRESS: '192.168.1.20',
        MCP_ALLOW_NON_LOOPBACK: 'true',
      }, inferred),
      /explicit EGRESSVIEW_DEPLOYMENT_PROFILE/
    );

    const configured = resolveDeploymentProfile({
      EGRESSVIEW_DEPLOYMENT_PROFILE: 'private-http',
    }, {
      httpEnabled: true,
      authMode: 'token',
    });
    assert.throws(
      () => resolveMcpBindConfig({ MCP_BIND_ADDRESS: '0.0.0.0' }, configured),
      /MCP_ALLOW_NON_LOOPBACK=true/
    );
    assert.deepEqual(resolveMcpBindConfig({
      MCP_BIND_ADDRESS: '0.0.0.0',
      MCP_ALLOW_NON_LOOPBACK: 'true',
    }, configured), {
      address: '0.0.0.0',
      loopback: false,
      explicitlyApproved: true,
    });
  });

  it('rejects hostnames and malformed bind addresses', () => {
    const profile = resolveDeploymentProfile({
      EGRESSVIEW_DEPLOYMENT_PROFILE: 'private-http',
    }, {
      httpEnabled: true,
      authMode: 'token',
    });
    for (const address of ['localhost', 'private.example', '192.168.1.999']) {
      assert.throws(
        () => resolveMcpBindConfig({ MCP_BIND_ADDRESS: address }, profile),
        /must be an IPv4 or IPv6 address/
      );
    }
  });
});
