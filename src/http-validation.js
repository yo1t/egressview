'use strict';

const capture = require('./request-schema-capture');

function formatValidationError(error) {
  const issue = error?.issues?.[0];
  if (!issue) return 'invalid request';
  const field = issue.path?.length ? `"${issue.path.join('.')}" ` : '';
  return `invalid ${field}${issue.message}`.trim();
}

function parseRequest(schema, value, res, errorBody = null) {
  // Off in every ordinary run; see request-schema-capture.js.
  if (capture.isEnabled()) capture.record(schema, value, res);
  const result = schema.safeParse(value ?? {});
  if (result.success) return { ok: true, data: result.data };
  res.status(400).json(errorBody || { error: formatValidationError(result.error) });
  return { ok: false, error: result.error };
}

module.exports = { formatValidationError, parseRequest };
