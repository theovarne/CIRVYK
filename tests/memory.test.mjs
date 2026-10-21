import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExample, finalizeWindow, RULES } from '../public/modules/engine.js';
import { MEMORY_KEY, MEMORY_LIMITS, loadTraces, saveTrace, removeTrace, exportTrace, importTrace, assertUniqueImportIds, summarizeImportResult, prepareTraceImport } from '../public/modules/memory.js';

class Storage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
}
const makeTrace = (offset = 0) => {
  const request = buildExample('single');
  const shift = offset * RULES.windowMs;
  return finalizeWindow({ ...request, baseline: [], windowStart: request.windowStart + shift, now: request.now + shift, inputs: request.inputs.map(input => ({ ...input, timestamp: input.timestamp + shift })) });
};

test('save, restore, JSON export and JSON import preserve replay inputs and baseline evidence', () => {
  const storage = new Storage();
  const trace = finalizeWindow(buildExample('burst'));
  assert.equal(saveTrace(trace, storage).error, null);
  assert.deepEqual(loadTraces(storage).traces, [trace]);
  const json = exportTrace(trace);
  assert.deepEqual(JSON.parse(json).baselineEvidence, trace.baselineEvidence);
  const restoredStorage = new Storage();
  assert.equal(importTrace(json, restoredStorage).error, null);
  assert.deepEqual(loadTraces(restoredStorage).traces, [trace]);
  assert.equal(removeTrace(trace.id, restoredStorage).traces.length, 0);
});

test('late reconciliations upsert one window instead of appending duplicate records', () => {
  const storage = new Storage();
  const request = buildExample('single');
  const first = finalizeWindow({ ...request, coverage: 'partial' });
  const later = finalizeWindow(request);
  assert.equal(saveTrace(first, storage).error, null);
  assert.equal(saveTrace(later, storage).error, null);
  assert.equal(loadTraces(storage).traces.length, 1);
  assert.equal(loadTraces(storage).traces[0].status, 'final');
});

test('malformed JSON and executable/HTML-shaped records are rejected as data', () => {
  const storage = new Storage();
  for (const value of ['{', 'null', 'alert(1)', '{"schema":"circuit.trace.v1","html":"<script>bad()</script>"}', '{"__proto__":{"polluted":true}}']) {
    assert.ok(importTrace(value, storage).error);
    assert.equal(loadTraces(storage).traces.length, 0);
  }
  assert.equal({}.polluted, undefined);
  const trace = makeTrace();
  assert.ok(importTrace(JSON.stringify({ ...trace, count: 100 }), storage).error);
});

test('record limit retains at most 30 newest windows and makes older imports explicit', () => {
  const storage = new Storage();
  for (let index = 0; index < 32; index++) assert.equal(saveTrace(makeTrace(index), storage).error, null);
  const loaded = loadTraces(storage);
  assert.equal(loaded.error, null);
  assert.equal(loaded.traces.length, MEMORY_LIMITS.maxRecords);
  assert.equal(loaded.traces[0].window.start, makeTrace(31).window.start);
  assert.equal(loaded.traces.at(-1).window.start, makeTrace(2).window.start);
  assert.ok(saveTrace(makeTrace(0), storage).error);
});

test('byte limit rejects oversized JSON before parsing', () => {
  const storage = new Storage();
  const oversized = ' '.repeat(MEMORY_LIMITS.maxBytes + 1);
  assert.match(importTrace(oversized, storage).error, /3 MB/);
  storage.setItem(MEMORY_KEY, oversized);
  assert.match(loadTraces(storage).error, /3 MB/);
});

test('aggregate byte limit evicts oldest records before writing storage', () => {
  const storage = new Storage();
  const request = buildExample('single');
  for (let index = 0; index < 9; index++) {
    const windowStart = request.windowStart + index * RULES.windowMs;
    const inputs = Array.from({ length: 600 }, (_, i) => ({ ...request.inputs[0], id: `input-${i}`, address: 'A'.repeat(256), timestamp: windowStart + i * 80 }));
    const trace = finalizeWindow({ ...request, baseline: [], windowStart, now: windowStart + RULES.windowMs, inputs });
    assert.equal(saveTrace(trace, storage).error, null);
  }
  const loaded = loadTraces(storage);
  assert.equal(loaded.error, null);
  assert.ok(loaded.traces.length < 9);
  assert.ok(new TextEncoder().encode(storage.getItem(MEMORY_KEY)).byteLength <= MEMORY_LIMITS.maxBytes);
  assert.equal(loaded.traces[0].window.start, request.windowStart + 8 * RULES.windowMs);
});

test('a near-limit saved Trace exports compactly and round trips below the import limit', () => {
  const storage = new Storage(), request = buildExample('single');
  const inputs = Array.from({ length: 3600 }, (_, i) => ({ ...request.inputs[0], id: `input-${i}`, address: 'A'.repeat(256), timestamp: request.windowStart + i * 14 }));
  const trace = finalizeWindow({ ...request, baseline: [], inputs });
  assert.ok(new TextEncoder().encode(JSON.stringify(trace, null, 2)).byteLength > MEMORY_LIMITS.maxBytes);
  assert.equal(saveTrace(trace, storage).error, null);
  const exported = exportTrace(trace);
  assert.ok(new TextEncoder().encode(exported).byteLength <= MEMORY_LIMITS.maxBytes);
  const restored = importTrace(exported, new Storage());
  assert.equal(restored.error, null);
  assert.deepEqual(restored.trace, trace);
});

test('storage errors report failure and preserve the previous result', () => {
  const storage = new Storage();
  saveTrace(makeTrace(), storage);
  storage.setItem = () => { throw new Error('QuotaExceededError'); };
  const result = saveTrace(makeTrace(1), storage);
  assert.match(result.error, /QuotaExceededError/);
  assert.equal(result.traces.length, 1);
  assert.equal(loadTraces(storage).traces.length, 1);
});

test('corrupted saved memory cannot silently overwrite existing records', () => {
  const storage = new Storage();
  storage.setItem(MEMORY_KEY, '{"schema":"circuit.memory.v1","traces":[{}]}');
  assert.ok(loadTraces(storage).error);
  assert.ok(saveTrace(makeTrace(), storage).error);
  assert.ok(storage.getItem(MEMORY_KEY).includes('[{}]'));
});

test('loading and importing never change the source trace object', () => {
  const storage = new Storage();
  const trace = finalizeWindow(buildExample('burst'));
  const before = JSON.stringify(trace);
  saveTrace(trace, storage);
  loadTraces(storage);
  importTrace(exportTrace(trace), storage);
  assert.equal(JSON.stringify(trace), before);
});

test('batch import summary reports an incoming Trace evicted by a later item in the same batch', () => {
  const storage = new Storage();
  const scopedTrace = (offset, scopeId) => {
    const request = buildExample('single'), shift = offset * RULES.windowMs;
    return finalizeWindow({...request, baseline: [], source: {...request.source, scopeId}, windowStart: request.windowStart + shift, now: request.now + shift, inputs: request.inputs.map(input => ({...input, scopeId, timestamp: input.timestamp + shift}))});
  };
  for (let index = 1; index <= 30; index++) assert.equal(saveTrace(scopedTrace(index, 'base'), storage).error, null);
  const previous = loadTraces(storage).traces;
  const requested = [scopedTrace(2, 'new-scope-0'), scopedTrace(31, 'new-scope-0')];
  const before = JSON.stringify({requested, previous});
  for (const trace of requested) assert.equal(saveTrace(trace, storage).error, null);
  const next = loadTraces(storage).traces;
  assert.deepEqual(summarizeImportResult(requested, previous, next), {
    retainedIds: [requested[1].id], notRetainedIds: [requested[0].id], evictedIds: [scopedTrace(1, 'base').id],
  });
  assert.equal(JSON.stringify({requested, previous}), before);
});

test('duplicate imported window IDs are rejected before writes and cannot inflate batch statistics', () => {
  const trace = makeTrace(), storage = new Storage();
  saveTrace(makeTrace(1), storage); const raw = storage.getItem(MEMORY_KEY);
  const requested = [trace, {...trace}];
  assert.throws(() => assertUniqueImportIds(requested), /duplicate Trace IDs/);
  assert.throws(() => summarizeImportResult(requested, [], [trace]), /duplicate Trace IDs/);
  assert.equal(storage.getItem(MEMORY_KEY), raw);
  assert.deepEqual(assertUniqueImportIds([trace]), [trace.id]);
});

test('batch summary distinguishes retained upserts from removed previous records', () => {
  const first = makeTrace(), second = makeTrace(1), third = makeTrace(2);
  assert.deepEqual(summarizeImportResult([first, third], [first, second], [third, first]), {
    retainedIds: [first.id, third.id], notRetainedIds: [], evictedIds: [second.id],
  });
  assert.throws(() => assertUniqueImportIds([{}]), /valid ID/);
});

test('whole-batch planning is independent of import order at the record limit', () => {
  const previous = Array.from({length: 29}, (_, index) => makeTrace(index + 1));
  const incoming = [makeTrace(0), makeTrace(30)], before = JSON.stringify({previous, incoming});
  const first = prepareTraceImport(incoming, previous);
  const reversed = prepareTraceImport([...incoming].reverse(), previous);
  assert.deepEqual(first, reversed);
  assert.equal(first.traces.length, 30);
  assert.deepEqual(first.retainedIds, [incoming[1].id]);
  assert.deepEqual(first.notRetainedIds, [incoming[0].id]);
  assert.equal(first.traces[0].id, incoming[1].id);
  assert.equal(JSON.stringify({previous, incoming}), before);
});

test('whole-batch planning applies the byte limit once and reports discarded inputs consistently', () => {
  const storage = new Storage(), request = buildExample('single');
  const heavy = offset => {
    const start = request.windowStart + offset * RULES.windowMs;
    return finalizeWindow({...request, baseline: [], windowStart: start, now: start + RULES.windowMs,
      inputs: Array.from({length: 600}, (_, index) => ({...request.inputs[0], id: `large-${index}`, address: 'A'.repeat(256), timestamp: start + index * 80}))});
  };
  for (let index = 1; index <= 9; index++) assert.equal(saveTrace(heavy(index), storage).error, null);
  const previous = loadTraces(storage).traces, raw = storage.getItem(MEMORY_KEY);
  const incoming = [heavy(0), heavy(10)];
  const first = prepareTraceImport(incoming, previous), reversed = prepareTraceImport([...incoming].reverse(), previous);
  assert.deepEqual(first, reversed);
  assert.ok(new TextEncoder().encode(first.serialized).byteLength <= MEMORY_LIMITS.maxBytes);
  assert.equal(first.traces[0].id, incoming[1].id);
  assert.ok(first.notRetainedIds.includes(incoming[0].id));
  assert.equal(storage.getItem(MEMORY_KEY), raw);
});

test('whole-batch planning rejects duplicates or any invalid record without changing its inputs', () => {
  const previous = [makeTrace(1)], valid = makeTrace(2), invalid = {...makeTrace(3), count: 99};
  const before = JSON.stringify(previous);
  assert.throws(() => prepareTraceImport([valid, {...valid}], previous), /duplicate Trace IDs/);
  assert.throws(() => prepareTraceImport([valid, invalid], previous), /deterministic engine/);
  assert.throws(() => prepareTraceImport([], previous), /Invalid saved-traces/);
  assert.equal(JSON.stringify(previous), before);
});
