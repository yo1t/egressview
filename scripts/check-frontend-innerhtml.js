'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Linter } = require('eslint');

const ROOT = path.join(__dirname, '..');
const JS_DIR = path.join(ROOT, 'public', 'js');
const ALLOWLIST_PATH = path.join(__dirname, 'frontend-innerhtml-allowlist.json');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function extractInnerHtmlAssignments(source, filename = 'input.js') {
  const assignments = [];
  const captureRule = {
    meta: { type: 'problem', schema: [] },
    create(context) {
      const sourceCode = context.sourceCode;
      return {
        AssignmentExpression(node) {
          if (node.left.type !== 'MemberExpression') return;
          const propertyName = node.left.computed
            ? node.left.property.value
            : node.left.property.name;
          if (propertyName !== 'innerHTML') return;
          const target = sourceCode.getText(node.left);
          const value = sourceCode.getText(node.right).replace(/\r\n/g, '\n');
          assignments.push({
            line: node.loc.start.line,
            operator: node.operator,
            target,
            value,
            fingerprint: sha256(`${target}\n${node.operator}\n${value}`),
          });
        },
      };
    },
  };
  const linter = new Linter();
  const messages = linter.verify(source, [{
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    plugins: { audit: { rules: { 'capture-innerhtml': captureRule } } },
    rules: { 'audit/capture-innerhtml': 'error' },
  }], { filename });
  const parseError = messages.find(message => message.fatal);
  if (parseError) throw new Error(`${filename}:${parseError.line}:${parseError.column} ${parseError.message}`);
  return assignments;
}

function buildInventory(jsDir = JS_DIR) {
  const inventory = {};
  for (const file of fs.readdirSync(jsDir).filter(name => name.endsWith('.js')).sort()) {
    const source = fs.readFileSync(path.join(jsDir, file), 'utf8');
    const assignments = extractInnerHtmlAssignments(source, file);
    if (!assignments.length) continue;
    inventory[file] = {
      count: assignments.length,
      fingerprint: sha256(assignments.map(item => item.fingerprint).join('\n')),
      assignments,
    };
  }
  return inventory;
}

function compareInventory(inventory, allowlist) {
  const errors = [];
  const currentFiles = Object.keys(inventory).sort();
  const allowedFiles = Object.keys(allowlist.files || {}).sort();
  const total = currentFiles.reduce((sum, file) => sum + inventory[file].count, 0);

  if (total !== allowlist.totalAssignments) {
    errors.push(`total assignments changed: expected ${allowlist.totalAssignments}, found ${total}`);
  }
  for (const file of currentFiles.filter(file => !allowlist.files?.[file])) {
    errors.push(`${file}: contains ${inventory[file].count} unreviewed innerHTML assignment(s)`);
  }
  for (const file of allowedFiles.filter(file => !inventory[file])) {
    errors.push(`${file}: allowlist entry is stale; file has no innerHTML assignments`);
  }
  for (const file of currentFiles.filter(file => allowlist.files?.[file])) {
    const current = inventory[file];
    const allowed = allowlist.files[file];
    if (!Array.isArray(allowed.categories) || !allowed.categories.length || !allowed.reason?.trim()) {
      errors.push(`${file}: allowlist entry must include categories and a review reason`);
    }
    if (current.count !== allowed.count) {
      errors.push(`${file}: expected ${allowed.count} assignment(s), found ${current.count}`);
    }
    if (current.fingerprint !== allowed.fingerprint) {
      const locations = current.assignments.map(item => `${file}:${item.line} ${item.target} ${item.operator}`).join('\n  ');
      errors.push(`${file}: reviewed assignment content changed\n  ${locations}`);
    }
  }
  return { errors, total, fileCount: currentFiles.length };
}

function formatInventory(inventory, allowlist = null) {
  return Object.entries(inventory).map(([file, data]) => {
    const categories = allowlist?.files?.[file]?.categories?.join(', ') || 'unclassified';
    const lines = data.assignments.map(item => item.line).join(',');
    return `${file}: ${data.count} [${categories}] lines ${lines}`;
  }).join('\n');
}

function loadAllowlist(allowlistPath = ALLOWLIST_PATH) {
  return JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));
}

function runAudit({ jsDir = JS_DIR, allowlistPath = ALLOWLIST_PATH } = {}) {
  const inventory = buildInventory(jsDir);
  const allowlist = loadAllowlist(allowlistPath);
  const result = compareInventory(inventory, allowlist);
  return { ...result, inventory, allowlist };
}

if (require.main === module) {
  try {
    const inventory = buildInventory();
    if (process.argv.includes('--inventory')) {
      const baseline = Object.fromEntries(Object.entries(inventory).map(([file, data]) => [file, {
        count: data.count,
        fingerprint: data.fingerprint,
        lines: data.assignments.map(item => item.line),
      }]));
      process.stdout.write(`${JSON.stringify(baseline, null, 2)}\n`);
    } else {
      const allowlist = loadAllowlist();
      const result = compareInventory(inventory, allowlist);
      if (result.errors.length) {
        process.stderr.write(`Frontend innerHTML audit failed:\n- ${result.errors.join('\n- ')}\n\n`);
        process.stderr.write(`${formatInventory(inventory, allowlist)}\n`);
        process.exitCode = 1;
      } else {
        process.stdout.write(`Frontend innerHTML audit passed: ${result.total} reviewed assignments in ${result.fileCount} files.\n`);
        process.stdout.write(`${formatInventory(inventory, allowlist)}\n`);
      }
    }
  } catch (error) {
    process.stderr.write(`Frontend innerHTML audit error: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  buildInventory,
  compareInventory,
  extractInnerHtmlAssignments,
  formatInventory,
  loadAllowlist,
  runAudit,
};
