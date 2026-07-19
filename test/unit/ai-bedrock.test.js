'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { createBedrockTransport, mapAwsError, extractText } = require('../../src/ai-bedrock');

// Fake AWS SDK runtime module: BedrockRuntimeClient.send returns/throws what the
// test configures, and ConverseCommand just records its input.
function fakeRuntime({ onSend } = {}) {
  const sent = [];
  const constructed = [];
  return {
    sent,
    constructed,
    mod: {
      BedrockRuntimeClient: class {
        constructor(cfg) { constructed.push(cfg); }
        async send(command, opts) { sent.push({ command, opts }); return onSend(command, opts); }
      },
      ConverseCommand: class { constructor(input) { this.input = input; } },
    },
  };
}

function fakeControl({ foundation = [], profiles = [], guardrails = [], failProfiles = false, failGuardrails = false, failAll = false } = {}) {
  return {
    BedrockClient: class {
      constructor(cfg) { this.cfg = cfg; }
      async send(command) {
        if (failAll) throw new Error('control plane down');
        if (command.kind === 'fm') return { modelSummaries: foundation };
        if (command.kind === 'ip') {
          if (failProfiles) throw new Error('no profiles');
          return { inferenceProfileSummaries: profiles };
        }
        if (command.kind === 'gr') {
          if (failGuardrails) throw new Error('no guardrails');
          return { guardrails };
        }
        return {};
      }
    },
    ListFoundationModelsCommand: class { constructor() { this.kind = 'fm'; } },
    ListInferenceProfilesCommand: class { constructor() { this.kind = 'ip'; } },
    ListGuardrailsCommand: class { constructor() { this.kind = 'gr'; } },
  };
}

describe('ai-bedrock: converse', () => {
  it('invokes Converse with region + modelId and returns joined text', async () => {
    const runtime = fakeRuntime({ onSend: () => ({ output: { message: { content: [{ text: '概要' }, { text: '異常なし' }] } } }) });
    const transport = createBedrockTransport({ runtime: runtime.mod });
    const text = await transport.converse({
      region: 'ap-northeast-1',
      modelId: 'jp.anthropic.claude-sonnet-4-5-20250929-v1:0',
      prompt: 'analyze this',
    });
    assert.equal(text, '概要\n異常なし');
    assert.equal(runtime.constructed[0].region, 'ap-northeast-1');
    assert.equal(runtime.sent[0].command.input.modelId, 'jp.anthropic.claude-sonnet-4-5-20250929-v1:0');
    assert.deepEqual(runtime.sent[0].command.input.messages, [{ role: 'user', content: [{ text: 'analyze this' }] }]);
  });

  it('reuses one client per region', async () => {
    const runtime = fakeRuntime({ onSend: () => ({ output: { message: { content: [{ text: 'ok' }] } } }) });
    const transport = createBedrockTransport({ runtime: runtime.mod });
    await transport.converse({ region: 'us-east-1', modelId: 'm', prompt: 'a' });
    await transport.converse({ region: 'us-east-1', modelId: 'm', prompt: 'b' });
    await transport.converse({ region: 'eu-west-1', modelId: 'm', prompt: 'c' });
    assert.equal(runtime.constructed.length, 2); // us-east-1 + eu-west-1
  });

  it('requires region and model before sending', async () => {
    const runtime = fakeRuntime({ onSend: () => ({}) });
    const transport = createBedrockTransport({ runtime: runtime.mod });
    await assert.rejects(transport.converse({ modelId: 'm', prompt: 'a' }), /region is not configured/);
    await assert.rejects(transport.converse({ region: 'us-east-1', prompt: 'a' }), /model is not configured/);
    assert.equal(runtime.sent.length, 0);
  });

  it('enforces the response byte bound', async () => {
    const runtime = fakeRuntime({ onSend: () => ({ output: { message: { content: [{ text: 'x'.repeat(100) }] } } }) });
    const transport = createBedrockTransport({ runtime: runtime.mod });
    await assert.rejects(
      transport.converse({ region: 'us-east-1', modelId: 'm', prompt: 'a', maxBytes: 10 }),
      /too large/,
    );
  });

  it('maps AWS SDK errors to safe messages', async () => {
    const cases = [
      ['AccessDeniedException', /access denied/i],
      ['ThrottlingException', /throttled/i],
      ['CredentialsProviderError', /credentials could not be resolved/i],
      ['TimeoutError', /timed out/i],
      ['ValidationException', /rejected the model or region/i],
      ['AbortError', /cancelled/i],
    ];
    for (const [name, pattern] of cases) {
      const runtime = fakeRuntime({ onSend: () => { const e = new Error('raw'); e.name = name; throw e; } });
      const transport = createBedrockTransport({ runtime: runtime.mod });
      await assert.rejects(transport.converse({ region: 'us-east-1', modelId: 'm', prompt: 'a' }), pattern);
    }
  });

  it('does not leak raw SDK error detail for unknown errors', async () => {
    const runtime = fakeRuntime({ onSend: () => { const e = new Error('arn:aws:...:secret-detail'); e.name = 'WeirdError'; throw e; } });
    const transport = createBedrockTransport({ runtime: runtime.mod });
    await assert.rejects(transport.converse({ region: 'us-east-1', modelId: 'm', prompt: 'a' }),
      error => error.message === 'Bedrock request failed' && !/secret-detail/.test(error.message));
  });

  it('reports a timeout (not cancellation) when the abort reason is a TimeoutError', async () => {
    const runtime = fakeRuntime({ onSend: () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; } });
    const transport = createBedrockTransport({ runtime: runtime.mod });
    const signal = { aborted: true, reason: { name: 'TimeoutError' } };
    await assert.rejects(transport.converse({ region: 'us-east-1', modelId: 'm', prompt: 'a', signal }), /timed out/);
  });

  it('reports cancellation when aborted without a timeout reason', async () => {
    const runtime = fakeRuntime({ onSend: () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; } });
    const transport = createBedrockTransport({ runtime: runtime.mod });
    const signal = { aborted: true, reason: { name: 'AbortError' } };
    await assert.rejects(transport.converse({ region: 'us-east-1', modelId: 'm', prompt: 'a', signal }), /cancelled/);
  });

  it('passes the caller abort signal to the Converse send', async () => {
    const runtime = fakeRuntime({ onSend: () => ({ output: { message: { content: [{ text: 'ok' }] } } }) });
    const transport = createBedrockTransport({ runtime: runtime.mod });
    const signal = { aborted: false };
    await transport.converse({ region: 'us-east-1', modelId: 'm', prompt: 'a', signal });
    assert.equal(runtime.sent[0].opts.abortSignal, signal);
  });

  it('adds guardrailConfig to the command only when a guardrail is provided', async () => {
    const runtime = fakeRuntime({ onSend: () => ({ output: { message: { content: [{ text: 'ok' }] } } }) });
    const transport = createBedrockTransport({ runtime: runtime.mod });

    await transport.converse({ region: 'us-east-1', modelId: 'm', prompt: 'a' });
    assert.equal(runtime.sent[0].command.input.guardrailConfig, undefined);

    await transport.converse({ region: 'us-east-1', modelId: 'm', prompt: 'a', guardrail: { id: 'gr-1', version: '3' } });
    assert.deepEqual(runtime.sent[1].command.input.guardrailConfig, { guardrailIdentifier: 'gr-1', guardrailVersion: '3' });

    await transport.converse({ region: 'us-east-1', modelId: 'm', prompt: 'a', guardrail: { id: 'gr-2' } });
    assert.deepEqual(runtime.sent[2].command.input.guardrailConfig, { guardrailIdentifier: 'gr-2', guardrailVersion: 'DRAFT' });
  });
});

describe('ai-bedrock: listModels (fail-open discovery)', () => {
  it('merges foundation models and inference profiles, sorted + bounded', async () => {
    const control = fakeControl({
      foundation: [{ modelId: 'anthropic.claude-haiku-4-5-v1:0' }],
      profiles: [
        { inferenceProfileId: 'jp.anthropic.claude-sonnet-4-5-20250929-v1:0' },
        { inferenceProfileId: 'us.anthropic.claude-haiku-4-5-v1:0' },
      ],
    });
    const transport = createBedrockTransport({ control });
    const ids = await transport.listModels({ region: 'ap-northeast-1' });
    assert.deepEqual(ids, [
      'anthropic.claude-haiku-4-5-v1:0',
      'jp.anthropic.claude-sonnet-4-5-20250929-v1:0',
      'us.anthropic.claude-haiku-4-5-v1:0',
    ]);
  });

  it('still returns foundation models when inference profile listing fails', async () => {
    const control = fakeControl({ foundation: [{ modelId: 'anthropic.claude-haiku-4-5-v1:0' }], failProfiles: true });
    const transport = createBedrockTransport({ control });
    assert.deepEqual(await transport.listModels({ region: 'us-east-1' }), ['anthropic.claude-haiku-4-5-v1:0']);
  });

  it('returns [] (fail-open) on any control-plane error or missing region', async () => {
    const control = fakeControl({ failAll: true });
    const transport = createBedrockTransport({ control });
    assert.deepEqual(await transport.listModels({ region: 'us-east-1' }), []);
    assert.deepEqual(await transport.listModels({}), []);
  });
});

describe('ai-bedrock: listGuardrails (fail-open discovery)', () => {
  it('groups guardrails by id with versions (always incl. DRAFT)', async () => {
    const control = fakeControl({ guardrails: [
      { id: 'gr-1', arn: 'arn:aws:bedrock:...:guardrail/gr-1', name: 'PII Filter', version: 'DRAFT' },
      { id: 'gr-1', arn: 'arn:aws:bedrock:...:guardrail/gr-1', name: 'PII Filter', version: '2' },
      { id: 'gr-2', arn: 'arn:aws:bedrock:...:guardrail/gr-2', name: 'Toxicity' },
    ] });
    const transport = createBedrockTransport({ control });
    const result = await transport.listGuardrails({ region: 'ap-northeast-1' });
    assert.equal(result.length, 2);
    const first = result.find(g => g.id === 'gr-1');
    assert.equal(first.name, 'PII Filter');
    assert.deepEqual(first.versions, ['DRAFT', '2']);
    const second = result.find(g => g.id === 'gr-2');
    assert.deepEqual(second.versions, ['DRAFT']);
  });

  it('returns [] (fail-open) on error or missing region', async () => {
    assert.deepEqual(await createBedrockTransport({ control: fakeControl({ failGuardrails: true }) })
      .listGuardrails({ region: 'us-east-1' }), []);
    assert.deepEqual(await createBedrockTransport({ control: fakeControl({ failAll: true }) })
      .listGuardrails({ region: 'us-east-1' }), []);
    assert.deepEqual(await createBedrockTransport({ control: fakeControl({}) }).listGuardrails({}), []);
  });

  it('bounds both control-plane calls with an abort signal (timeout)', async () => {
    const opts = [];
    const control = {
      BedrockClient: class {
        async send(command, o) {
          opts.push(o);
          return command.kind === 'fm' ? { modelSummaries: [] } : { inferenceProfileSummaries: [] };
        }
      },
      ListFoundationModelsCommand: class { constructor() { this.kind = 'fm'; } },
      ListInferenceProfilesCommand: class { constructor() { this.kind = 'ip'; } },
    };
    const transport = createBedrockTransport({ control });
    await transport.listModels({ region: 'us-east-1', timeoutMs: 5000 });
    assert.equal(opts.length, 2);
    assert.ok(opts.every(o => o && o.abortSignal), 'both sends receive an abortSignal');
  });
});

describe('ai-bedrock: optional SDK not installed', () => {
  function missingRequire(name) {
    const err = new Error(`Cannot find module '${name}'`);
    err.code = 'MODULE_NOT_FOUND';
    throw err;
  }

  it('converse surfaces a clear "not installed" error (not a mapped/raw error)', async () => {
    const transport = createBedrockTransport({ requireModule: missingRequire });
    await assert.rejects(
      transport.converse({ region: 'us-east-1', modelId: 'm', prompt: 'a' }),
      error => error.code === 'BEDROCK_SDK_MISSING' && /npm install @aws-sdk\/client-bedrock-runtime/.test(error.message),
    );
  });

  it('discovery stays fail-open ([]) when the SDK is not installed', async () => {
    const transport = createBedrockTransport({ requireModule: missingRequire });
    assert.deepEqual(await transport.listModels({ region: 'us-east-1' }), []);
  });

  it('non-MODULE_NOT_FOUND require errors propagate unchanged', async () => {
    const boom = () => { throw new Error('syntax error in dependency'); };
    const transport = createBedrockTransport({ requireModule: boom });
    await assert.rejects(transport.converse({ region: 'us-east-1', modelId: 'm', prompt: 'a' }), /syntax error in dependency/);
  });
});

describe('ai-bedrock: real AWS SDK contract (no network)', () => {
  // The AWS SDK ships as a standard dependency, so verify our usage matches the
  // real API surface. This catches SDK drift without making any network call.
  const runtime = require('@aws-sdk/client-bedrock-runtime');
  const control = require('@aws-sdk/client-bedrock');

  it('exposes the runtime client + Converse command we depend on', () => {
    assert.equal(typeof runtime.BedrockRuntimeClient, 'function');
    assert.equal(typeof runtime.ConverseCommand, 'function');
    const command = new runtime.ConverseCommand({
      modelId: 'jp.anthropic.claude-sonnet-4-5-20250929-v1:0',
      messages: [{ role: 'user', content: [{ text: 'ping' }] }],
      inferenceConfig: { maxTokens: 8 },
    });
    assert.equal(command.input.modelId, 'jp.anthropic.claude-sonnet-4-5-20250929-v1:0');
    assert.equal(command.input.messages[0].content[0].text, 'ping');
  });

  it('exposes the control client + discovery commands we depend on', () => {
    assert.equal(typeof control.BedrockClient, 'function');
    assert.equal(typeof control.ListFoundationModelsCommand, 'function');
    assert.equal(typeof control.ListInferenceProfilesCommand, 'function');
    const command = new control.ListFoundationModelsCommand({ byOutputModality: 'TEXT' });
    assert.equal(command.input.byOutputModality, 'TEXT');
  });

  it('createBedrockTransport() builds against the real SDK without injection', () => {
    const transport = createBedrockTransport();
    assert.equal(typeof transport.converse, 'function');
    assert.equal(typeof transport.listModels, 'function');
  });
});

describe('ai-bedrock: helpers', () => {
  it('extractText joins text content blocks', () => {
    assert.equal(extractText({ output: { message: { content: [{ text: 'a' }, { foo: 1 }, { text: 'b' }] } } }), 'a\nb');
    assert.equal(extractText({}), '');
  });

  it('mapAwsError never returns undefined', () => {
    assert.ok(mapAwsError(null) instanceof Error);
    assert.ok(mapAwsError({ name: 'X', message: 'y' }) instanceof Error);
  });
});
