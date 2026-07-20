'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const routeDir = path.join(root, 'src', 'routes');
const apiDocs = ['docs/api-reference.md', 'docs/api-reference.ja.md'];
const architectureDocs = ['docs/architecture.md', 'docs/architecture.ja.md'];

function implementedRoutes() {
  const routes = [];
  for (const file of fs.readdirSync(routeDir).filter(name => name.endsWith('.js')).sort()) {
    const source = fs.readFileSync(path.join(routeDir, file), 'utf8');
    const pattern = /router\.(get|post|put|delete|patch)\(\s*['"]([^'"]+)['"]/g;
    for (const match of source.matchAll(pattern)) {
      routes.push(`${match[1].toUpperCase()} /api${match[2]}`);
    }
  }
  return [...new Set(routes)].sort();
}

function publicRoutes() {
  const routes = [];
  for (const file of fs.readdirSync(routeDir).filter(name => name.endsWith('.js')).sort()) {
    const lines = fs.readFileSync(path.join(routeDir, file), 'utf8').split('\n');
    for (const line of lines) {
      const match = line.match(/router\.(get|post|put|delete|patch)\(\s*['"]([^'"]+)['"]/);
      if (match && !line.includes('requireAdmin')) {
        routes.push(`${match[1].toUpperCase()} /api${match[2]}`);
      }
    }
  }
  return routes.sort();
}

function documentedRoutes(source) {
  return [...source.matchAll(/`(GET|POST|PUT|DELETE|PATCH) (\/api\/[^`?\s]+)`/g)]
    .map(match => `${match[1]} ${match[2]}`);
}

describe('REST API documentation', () => {
  it('lists every implemented endpoint and no nonexistent endpoint in both languages', () => {
    const implemented = implementedRoutes();
    assert.equal(implemented.length, 69, 'review the API reference when the route count changes');

    for (const file of apiDocs) {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      const documented = [...new Set(documentedRoutes(source))].sort();
      assert.deepEqual(documented, implemented, `${file} has drifted from src/routes`);
    }
  });

  it('documents authentication and bounded query/export behavior', () => {
    assert.deepEqual(publicRoutes(), [
      'POST /api/admin/verify',
      'POST /api/auth/login',
    ]);
    for (const file of apiDocs) {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      for (const value of ['X-Admin-Token', '64 KB', '1,000', '50,000', '60', '100 MB']) {
        assert(source.includes(value), `${file} must document ${value}`);
      }
    }
  });

  it('keeps architecture diagrams and documentation entry points linked', () => {
    for (const file of architectureDocs) {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      assert(source.includes('```mermaid'));
      for (const component of ['src/router-manager.js', 'src/router-poll-scheduler.js', 'src/db-bootstrap.js']) {
        assert(source.includes(component), `${file} must mention ${component}`);
      }
    }

    for (const file of ['README.md', 'README.ja.md', 'site/index.html', 'site/index.ja.html']) {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      assert(source.includes('api-reference'), `${file} must link the API reference`);
      assert(source.includes('architecture'), `${file} must link the architecture guide`);
    }
  });

  it('documents Bedrock production hardening in both languages', () => {
    for (const file of ['docs/setup-bedrock.md', 'docs/setup-bedrock.ja.md']) {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      for (const value of [
        'bedrock:InvokeModel',
        'bedrock:ApplyGuardrail',
        'Model invocation logging',
        'com.amazonaws.REGION.bedrock-runtime',
        'AWS_RETRY_MODE=standard',
        'AWS_MAX_ATTEMPTS=3',
      ]) {
        assert(source.includes(value), `${file} must document ${value}`);
      }
    }
  });
});
