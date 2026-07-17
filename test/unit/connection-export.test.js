'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  CSV_COLUMNS,
  csvCell,
  exportFilename,
  exportRow,
  streamConnectionExport,
} = require('../../src/connection-export');

class FakeResponse extends EventEmitter {
  constructor({ backpressureOnce = false } = {}) {
    super();
    this.headers = {};
    this.chunks = [];
    this.destroyed = false;
    this.writableEnded = false;
    this.backpressureOnce = backpressureOnce;
  }

  set(values) { Object.assign(this.headers, values); return this; }
  type(value) { this.headers['Content-Type'] = value; return this; }
  write(chunk) {
    this.chunks.push(String(chunk));
    if (this.backpressureOnce) {
      this.backpressureOnce = false;
      setImmediate(() => this.emit('drain'));
      return false;
    }
    return true;
  }
  end() { this.writableEnded = true; }
  body() { return this.chunks.join(''); }
}

function makeHistory(rows) {
  return {
    countByTimeRange: () => rows.length,
    queryByTimeRangePaged: (_from, _to, limit, offset) => rows.slice(offset, offset + limit),
  };
}

describe('connection export formatting', () => {
  it('neutralizes spreadsheet formulas and quotes CSV values', () => {
    assert.equal(csvCell('=HYPERLINK("https://example.test")'), '"\'=HYPERLINK(""https://example.test"")"');
    assert.equal(csvCell('  +SUM(1,2)'), '"\'  +SUM(1,2)"');
    assert.equal(csvCell('line1\r\nline2'), '"line1\nline2"');
  });

  it('normalizes optional fields without changing JSON timestamps', () => {
    const row = exportRow({
      src: '192.0.2.1', dst: '198.51.100.1', dport: 443, proto: 'TCP',
      firstSeen: 1000, lastSeen: 2000, observedBy: ['yamaha1'],
      threat: { confidence: 'high', source: 'feed', tag: 'test' },
    });
    assert.equal(row.firstSeen, 1000);
    assert.deepEqual(row.observedBy, ['yamaha1']);
    assert.equal(row.threatConfidence, 'high');
    assert.deepEqual(Object.keys(row), CSV_COLUMNS);
  });

  it('uses an ASCII-only timestamped attachment filename', () => {
    assert.equal(
      exportFilename('csv', new Date('2026-07-18T01:02:03.456Z')),
      'egressview-connections-20260718T010203Z.csv'
    );
  });
});

describe('streamConnectionExport', () => {
  const rows = [
    { src: '192.0.2.1', dst: '198.51.100.1', dport: 443, proto: 'TCP', lastSeen: 20 },
    { src: '192.0.2.2', dst: '198.51.100.2', dport: 53, proto: 'UDP', lastSeen: 10 },
  ];

  it('streams valid JSON in pages and waits for response backpressure', async () => {
    const res = new FakeResponse({ backpressureOnce: true });
    const result = await streamConnectionExport({
      res,
      history: makeHistory(rows),
      from: 1,
      to: 30,
      format: 'json',
      pageSize: 1,
      now: () => 1_000,
    });

    const body = JSON.parse(res.body());
    assert.equal(body.meta.total, 2);
    assert.equal(body.meta.truncated, false);
    assert.equal(body.connections.length, 2);
    assert.equal(result.written, 2);
    assert.equal(res.headers['X-Export-Truncated'], 'false');
    assert.equal(res.writableEnded, true);
  });

  it('streams CSV with a BOM, header, threat fields, and a fixed row limit', async () => {
    const res = new FakeResponse();
    const result = await streamConnectionExport({
      res,
      history: makeHistory(rows),
      threatIntel: {
        matchThreatIntel: dst => dst.endsWith('.1')
          ? { confidence: 'high', source: 'fixture', tag: '=unsafe' }
          : null,
      },
      from: 1,
      to: 30,
      format: 'csv',
      limit: 1,
      now: () => 1_000,
    });

    assert.match(res.body(), /^\uFEFFsrc,srcMac/);
    assert.match(res.body(), /"high","fixture","'=unsafe"/);
    assert.equal(result.written, 1);
    assert.equal(result.truncated, true);
    assert.equal(res.headers['X-Export-Count'], '1');
  });

  it('fails an export that exceeds its execution deadline', async () => {
    const res = new FakeResponse();
    const times = [0, 61_000];
    await assert.rejects(
      streamConnectionExport({
        res,
        history: makeHistory(rows),
        from: 1,
        to: 30,
        format: 'json',
        timeoutMs: 60_000,
        now: () => times.shift() ?? 61_000,
      }),
      /timed out/
    );
    assert.equal(res.writableEnded, false);
  });

  it('stops waiting for backpressure when the client disconnects', async () => {
    const res = new FakeResponse({ backpressureOnce: true });
    res.write = function write(chunk) {
      this.chunks.push(String(chunk));
      setImmediate(() => this.emit('close'));
      return false;
    };

    await assert.rejects(
      streamConnectionExport({
        res,
        history: makeHistory(rows),
        from: 1,
        to: 30,
        format: 'json',
        now: () => 1_000,
      }),
      /client disconnected/
    );
    assert.equal(res.listenerCount('drain'), 0);
    assert.equal(res.listenerCount('close'), 0);
    assert.equal(res.listenerCount('error'), 0);
  });
});
