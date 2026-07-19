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

function fakeControl({ foundation = [], profiles = [], failProfiles = false, failAll = false } = {}) {
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
        return {};
      }
    },
    ListFoundationModelsCommand: class { constructor() { this.kind = 'fm'; } },
    ListInferenceProfilesCommand: class { constructor() { this.kind = 'ip'; } },
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
