'use strict';

// Amazon Bedrock transport for the AI provider: Converse API generation plus
// optional (fail-open) model/inference-profile discovery. This module isolates
// the AWS SDK so ai-provider.js stays transport-agnostic and unit-testable.
//
// Authentication is delegated entirely to the AWS SDK default credential
// provider chain. This module never reads, stores, logs, or accepts AWS keys —
// only a region and a model/inference-profile id (which may be a foundation
// model id, a geographic cross-region inference profile us./eu./apac./jp./au.,
// a Global profile, or an ARN).

// The AWS SDK ships as a standard dependency. Keep a clear fallback error for
// incomplete production installs instead of surfacing a raw MODULE_NOT_FOUND.
const BEDROCK_NOT_INSTALLED =
  'Amazon Bedrock support is not installed. Run: '
  + 'npm install @aws-sdk/client-bedrock-runtime @aws-sdk/client-bedrock';

function bedrockNotInstalledError() {
  const error = new Error(BEDROCK_NOT_INSTALLED);
  error.code = 'BEDROCK_SDK_MISSING';
  return error;
}

// Map AWS SDK errors to plain, non-sensitive Error messages. Never surface raw
// SDK metadata (which can include ARNs/account ids) beyond the short reason.
function mapAwsError(err) {
  const name = String(err?.name || '');
  if (err?.name === 'AbortError') return new Error('Bedrock request was cancelled');
  if (/Timeout/i.test(name)) return new Error('Bedrock request timed out');
  if (/CredentialsProviderError|CredentialsError|Credentials/i.test(name)) {
    return new Error('AWS credentials could not be resolved (check SDK credential chain / SSO login)');
  }
  if (/AccessDenied|Forbidden|Unauthorized/i.test(name)) {
    return new Error('Bedrock access denied — verify bedrock:InvokeModel permission for this model/region');
  }
  if (/Throttling|TooManyRequests|LimitExceeded/i.test(name)) {
    return new Error('Bedrock throttled the request — retry later');
  }
  if (/ValidationException|ResourceNotFound|NotFound/i.test(name)) {
    return new Error('Bedrock rejected the model or region (unsupported model/inference profile for this region)');
  }
  return new Error('Bedrock request failed');
}

function extractText(output) {
  const blocks = output?.output?.message?.content || [];
  return blocks.map(block => block?.text).filter(Boolean).join('\n');
}

function createBedrockTransport({ runtime = null, control = null, requireModule = require } = {}) {
  const runtimeClients = new Map(); // region -> BedrockRuntimeClient

  function loadModule(name) {
    try {
      return requireModule(name);
    } catch (err) {
      if (err && err.code === 'MODULE_NOT_FOUND') throw bedrockNotInstalledError();
      throw err;
    }
  }
  const getRuntime = () => runtime || loadModule('@aws-sdk/client-bedrock-runtime');
  const getControl = () => control || loadModule('@aws-sdk/client-bedrock');

  function runtimeClient(region) {
    const { BedrockRuntimeClient } = getRuntime();
    if (!runtimeClients.has(region)) runtimeClients.set(region, new BedrockRuntimeClient({ region }));
    return runtimeClients.get(region);
  }

  async function converse({ region, modelId, prompt, maxTokens = 2048, maxBytes = 1024 * 1024, guardrail = null, signal, onUsage }) {
    if (!region) throw new Error('AWS region is not configured');
    if (!modelId) throw new Error('Bedrock model is not configured');
    const { ConverseCommand } = getRuntime();
    const commandInput = {
      modelId,
      messages: [{ role: 'user', content: [{ text: prompt }] }],
      inferenceConfig: { maxTokens },
    };
    // Optional Bedrock Guardrails. NOTE: a cross-region (geographic) guardrail
    // profile routes across the whole geography and there is no Japan-only
    // profile, so enabling this can break in-Japan data residency — the caller
    // is responsible for warning the user. This module just forwards the config.
    if (guardrail?.id) {
      commandInput.guardrailConfig = {
        guardrailIdentifier: guardrail.id,
        guardrailVersion: guardrail.version || 'DRAFT',
      };
    }
    let output;
    try {
      output = await runtimeClient(region).send(
        new ConverseCommand(commandInput),
        { abortSignal: signal },
      );
    } catch (err) {
      // AbortSignal.timeout() surfaces as an AbortError; distinguish a real
      // timeout (reason is a TimeoutError) from a caller cancellation before
      // falling back to the generic SDK error mapping.
      if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
        if (err?.name === 'TimeoutError' || signal?.reason?.name === 'TimeoutError') {
          throw new Error('Bedrock request timed out', { cause: err });
        }
        throw new Error('Bedrock request was cancelled', { cause: err });
      }
      throw mapAwsError(err);
    }
    const text = extractText(output);
    if (maxBytes && Buffer.byteLength(text) > maxBytes) throw new Error('Bedrock response was too large');
    if (typeof onUsage === 'function') {
      onUsage({
        inputTokens: output?.usage?.inputTokens,
        outputTokens: output?.usage?.outputTokens,
        totalTokens: output?.usage?.totalTokens,
      });
    }
    return text;
  }

  // Best-effort discovery. Any failure returns [] so the caller falls back to
  // direct model/inference-profile id entry (fail-open by design). A timeout
  // bounds the two control-plane calls so "test connection" never hangs.
  async function listModels({ region, timeoutMs = 10_000 }) {
    if (!region) return [];
    const abortSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
    try {
      const { BedrockClient, ListFoundationModelsCommand, ListInferenceProfilesCommand } = getControl();
      const client = new BedrockClient({ region });
      const ids = new Set();
      const fm = await client.send(new ListFoundationModelsCommand({ byOutputModality: 'TEXT' }), { abortSignal });
      for (const model of fm?.modelSummaries || []) if (model?.modelId) ids.add(model.modelId);
      // Inference profiles (incl. geographic CRIS) are optional; ignore failure.
      try {
        const profiles = await client.send(new ListInferenceProfilesCommand({}), { abortSignal });
        for (const p of profiles?.inferenceProfileSummaries || []) {
          if (p?.inferenceProfileId) ids.add(p.inferenceProfileId);
        }
      } catch { /* inference profile listing is optional */ }
      return [...ids].sort((a, b) => a.localeCompare(b)).slice(0, 200);
    } catch {
      return [];
    }
  }

  // Best-effort Guardrail discovery for the settings UI. Returns one entry per
  // guardrail with the versions seen (always incl. DRAFT). Any failure (incl.
  // missing bedrock:ListGuardrails permission) returns [] so the UI falls back
  // to manual id/version entry (fail-open by design).
  async function listGuardrails({ region, timeoutMs = 10_000 }) {
    if (!region) return [];
    const abortSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
    try {
      const { BedrockClient, ListGuardrailsCommand } = getControl();
      const client = new BedrockClient({ region });
      const byId = new Map();
      let nextToken;
      // Ten pages is a defensive upper bound for best-effort UI discovery. It
      // also protects against a broken service repeatedly returning new tokens.
      for (let page = 0; page < 10; page++) {
        const out = await client.send(new ListGuardrailsCommand({
          maxResults: 100,
          ...(nextToken ? { nextToken } : {}),
        }), { abortSignal });
        for (const guardrail of out?.guardrails || []) {
          if (!guardrail?.id) continue;
          const entry = byId.get(guardrail.id) || {
            id: guardrail.id,
            arn: guardrail.arn || null,
            name: guardrail.name || guardrail.id,
            versions: new Set(),
          };
          if (guardrail.version) entry.versions.add(String(guardrail.version));
          byId.set(guardrail.id, entry);
        }
        const returnedToken = out?.nextToken;
        if (!returnedToken || returnedToken === nextToken) break;
        nextToken = returnedToken;
      }
      return [...byId.values()].map(entry => {
        const versions = [...entry.versions];
        if (!versions.includes('DRAFT')) versions.unshift('DRAFT');
        return { id: entry.id, arn: entry.arn, name: entry.name, versions };
      }).slice(0, 100);
    } catch {
      return [];
    }
  }

  return { converse, listModels, listGuardrails };
}

module.exports = { createBedrockTransport, mapAwsError, extractText, bedrockNotInstalledError, BEDROCK_NOT_INSTALLED };
