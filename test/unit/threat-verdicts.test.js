'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { memoThreatIntel, forEachInSlices } = require('../../src/threat-verdicts');
const { tallyThreats, tallyThreatsInSlices } = require('../../src/ai-facts');
const { buildAiContextAsync } = require('../../src/ai-context');
const { createAiProvider } = require('../../src/ai-provider');
const { createBedrockTransport } = require('../../src/ai-bedrock');

// P3-190: a day's AI notification matched 7,512 destinations twice on the
// request thread, about 75 ms each pass, in a minute with a 489 ms loop delay.
describe('threat verdicts for the AI facts and context', () => {
  it('同じ宛先は1回だけ照合する', () => {
    const asked = [];
    const memo = memoThreatIntel({ matchThreatIntel: ip => { asked.push(ip); return ip === '203.0.113.9' ? { confidence: 'high' } : null; } });
    assert.deepEqual(memo.matchThreatIntel('203.0.113.9', 'evil.example'), { confidence: 'high' });
    assert.equal(memo.matchThreatIntel('203.0.113.9', 'evil.example').confidence, 'high');
    assert.equal(memo.matchThreatIntel('198.51.100.1', '198.51.100.1'), null);
    assert.equal(memo.matchThreatIntel('198.51.100.1', '198.51.100.1'), null);
    assert.deepEqual(asked, ['203.0.113.9', '198.51.100.1']);
  });

  it('照合器が無ければそのまま返す', () => {
    assert.equal(memoThreatIntel(null), null);
  });

  it('小分けにして、合間にループを返す', async () => {
    const seen = [];
    const slices = [];
    let yields = 0;
    await forEachInSlices([1, 2, 3, 4, 5], row => seen.push(row), {
      sliceRows: 2,
      measure: fn => { slices.push(seen.length); fn(); },
      yieldToLoop: async () => { yields += 1; },
    });
    assert.deepEqual(seen, [1, 2, 3, 4, 5]);
    assert.deepEqual(slices, [0, 2, 4]);
    assert.equal(yields, 2, '最後の小分けの後は返さない');
  });

  it('小分けの集計は、一度に数えた結果と同じ', async () => {
    const groups = Array.from({ length: 1203 }, (_, i) => ({ dst: `10.0.${i >> 8}.${i & 255}`, dstHost: null, cnt: i % 7 + 1 }));
    const threatIntel = { matchThreatIntel: ip => (ip.endsWith('.3') ? { confidence: 'low' } : ip.endsWith('.9') ? { confidence: 'high' } : null) };
    assert.deepEqual(await tallyThreatsInSlices(groups, threatIntel, { yieldToLoop: async () => {} }), tallyThreats(groups, threatIntel));
  });

  it('事実と文脈で共有すると、今期の宛先は1回ずつしか照合しない', async () => {
    const asked = new Map();
    const memo = memoThreatIntel({ matchThreatIntel: ip => { asked.set(ip, (asked.get(ip) || 0) + 1); return null; } });
    const dsts = [{ dst: '198.51.100.1', dstHost: null, cnt: 1 }, { dst: '198.51.100.2', dstHost: null, cnt: 2 }];
    const read = async fn => (fn === 'groupDstByTimeRange' ? dsts : []);
    await tallyThreatsInSlices(dsts, memo);
    await buildAiContextAsync({
      facts: { range: {}, previousRange: {}, collection: {}, current: {}, previous: {} },
      read, from: 1, to: 2, threatIntel: memo,
    });
    assert.deepEqual([...asked.values()], [1, 1]);
  });
});

describe('Bedrock is made ready before it is needed', () => {
  it('Bedrockが選ばれていれば、地域を渡して準備する', async () => {
    const warmed = [];
    const provider = createAiProvider({ bedrock: { warm: async args => { warmed.push(args); return true; } } });
    assert.equal(await provider.warmUp(), false, '未設定では何もしない');
    provider.configure({ provider: 'bedrock', region: 'ap-northeast-1' });
    assert.equal(await provider.warmUp(), true);
    assert.deepEqual(warmed, [{ region: 'ap-northeast-1' }]);
  });

  it('SDKを読み、地域のクライアントを作り、認証情報を解決する。失敗しても投げない', async () => {
    const constructed = [];
    let resolved = 0;
    const runtime = {
      BedrockRuntimeClient: class {
        constructor(cfg) { constructed.push(cfg); this.config = { credentials: async () => { resolved += 1; throw new Error('no credentials'); } }; }
      },
    };
    const transport = createBedrockTransport({ runtime });
    assert.equal(await transport.warm({ region: 'ap-northeast-1' }), true);
    assert.deepEqual(constructed, [{ region: 'ap-northeast-1' }]);
    assert.equal(resolved, 1);
    assert.equal(await transport.warm({ region: '' }), false);
  });
});
