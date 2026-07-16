'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  compareInventory,
  extractInnerHtmlAssignments,
  runAudit,
} = require('../../scripts/check-frontend-innerhtml');

describe('frontend innerHTML audit', () => {
  it('extracts assignments from nested templates without matching other DOM APIs', () => {
    const source = `
      target.innerHTML = \`<div>\${condition ? \`<span>\${value}</span>\` : ''}</div>\`;
      target['innerHTML'] += suffix;
      target.textContent = value;
      target.insertAdjacentHTML('beforeend', value);
    `;
    const assignments = extractInnerHtmlAssignments(source, 'fixture.js');
    assert.equal(assignments.length, 2);
    assert.equal(assignments[0].line, 2);
    assert.equal(assignments[0].target, 'target.innerHTML');
    assert.equal(assignments[0].operator, '=');
    assert.match(assignments[0].value, /condition/);
    assert.equal(assignments[1].target, "target['innerHTML']");
    assert.equal(assignments[1].operator, '+=');
  });

  it('fails when reviewed assignment content changes', () => {
    const inventory = {
      'example.js': { count: 1, fingerprint: 'new', assignments: [{ line: 4, target: 'el.innerHTML' }] },
    };
    const allowlist = {
      totalAssignments: 1,
      files: {
        'example.js': { count: 1, fingerprint: 'old', categories: ['static-markup'], reason: 'Reviewed.' },
      },
    };
    const result = compareInventory(inventory, allowlist);
    assert.match(result.errors.join('\n'), /reviewed assignment content changed/);
    assert.match(result.errors.join('\n'), /example\.js:4 el\.innerHTML/);
  });

  it('rejects new files and allowlist entries without review context', () => {
    const inventory = {
      'example.js': { count: 1, fingerprint: 'same', assignments: [{ line: 1, target: 'el.innerHTML' }] },
      'new-file.js': { count: 1, fingerprint: 'new', assignments: [{ line: 7, target: 'row.innerHTML' }] },
    };
    const allowlist = {
      totalAssignments: 2,
      files: {
        'example.js': { count: 1, fingerprint: 'same', categories: [], reason: '' },
      },
    };
    const result = compareInventory(inventory, allowlist);
    assert.match(result.errors.join('\n'), /new-file\.js: contains 1 unreviewed/);
    assert.match(result.errors.join('\n'), /example\.js: allowlist entry must include categories and a review reason/);
  });

  it('matches the reviewed production inventory', () => {
    const result = runAudit();
    assert.equal(result.total, 15);
    assert.equal(result.fileCount, 6);
    assert.deepEqual(result.errors, []);
  });
});
