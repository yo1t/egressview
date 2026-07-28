#!/usr/bin/env node
'use strict';

const {
  loadGateConfig,
  runPublicationGate,
  writeReport,
} = require('../src/mcp-publication-gate');

async function main(env = process.env) {
  const config = loadGateConfig(env);
  const report = await runPublicationGate(config);
  writeReport(config.reportPath, report);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.stdout.write(
    'MCP publication gate passed. DNS remains unpublished; manual review is still required.\n'
  );
  return report;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`MCP publication gate FAILED: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main };
