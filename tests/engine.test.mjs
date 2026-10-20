import { BRAND_NAME } from '../public/config/site.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { RULES, buildExample, finalizeWindow, validateTrace } from '../public/modules/engine.js';

const fixture = () => buildExample('burst');
const liveSource = { mode: 'live', label: 'Observed accounts', network: 'solana-mainnet', mint: 'A'.repeat(32), accounts: ['B'.repeat(32)], scopeId: 'test-live' };
const liveInput = (windowStart, fields = {}) => ({ id: 'operation-1', signature: 'C'.repeat(88), mint: liveSource.mint, slot: 123, timestamp: windowStart + 1000, kind: 'Transfer', source: 'live', verified: true, scopeId: liveSource.scopeId, ...fields });

test('same inputs, baseline and rules produce the same complete result', () => {
  const request = fixture();
  assert.deepEqual(finalizeWindow(request), finalizeWindow(structuredClone(request)));
  assert.equal(finalizeWindow(request).path, 'SURGE');
  assert.equal(validateTrace(finalizeWindow(request)).valid, true);
});

test('input order does not affect deterministic output', () => {
  const request = fixture();
  assert.deepEqual(finalizeWindow(request), finalizeWindow({ ...request, inputs: [...request.inputs].reverse() }));
});

test('one signature for one mint counts once even with multiple transaction operations', () => {
  const request = fixture();
  const first = liveInput(request.windowStart);
  const trace = finalizeWindow({ ...request, source: liveSource, inputs: [first, { ...first, id: 'operation-2', kind: 'Activity' }] });
  assert.equal(trace.count, 1);
  assert.equal(trace.filtered.length, 1);
  assert.match(trace.filtered[0].reason, /Duplicate transaction/);
});

test('only supported, verified and in-scope events enter valid inputs', () => {
  const request = fixture();
  const trace = finalizeWindow({ ...request, inputs: [request.inputs[0], { ...request.inputs[1], verified: false }, { ...request.inputs[2], kind: 'Buy' }, { ...request.inputs[3], scopeId: 'another-scope' }, { ...request.inputs[4], timestamp: request.windowStart - 1 }] });
  assert.equal(trace.count, 1);
  assert.equal(trace.filtered.length, 4);
});

test('complete empty window is QUIET; failures, partial coverage and unfinished parsing have no path', () => {
  const request = { ...fixture(), inputs: [] };
  assert.equal(finalizeWindow(request).path, 'QUIET');
  for (const change of [{ coverage: 'missing' }, { coverage: 'partial' }, { parsingComplete: false }]) {
    const trace = finalizeWindow({ ...request, ...change });
    assert.equal(trace.path, null);
    assert.equal(trace.status, 'incomplete');
  }
});

test('an open window only accumulates and cannot select any path', () => {
  const request = fixture();
  const trace = finalizeWindow({ ...request, now: request.windowStart + 30_000 });
  assert.equal(trace.path, null);
  assert.equal(trace.status, 'accumulating');
  assert.equal(trace.progress, 0.5);
  assert.equal(trace.growthRatio, null);
});

test('an unconfigured live scope cannot be concluded as zero activity', () => {
  const trace = finalizeWindow({ ...fixture(), inputs: [], source: { mode: 'live' } });
  assert.equal(trace.status, 'incomplete');
  assert.equal(trace.path, null);
  assert.match(trace.reason, /scope is not configured/);
});

test('five preceding consecutive complete windows are required; no invented ratio', () => {
  const request = fixture();
  for (const baseline of [[], request.baseline.slice(1), request.baseline.filter((_, index) => index !== 2)]) {
    const trace = finalizeWindow({ ...request, baseline });
    assert.equal(trace.path, 'FLOW');
    assert.equal(trace.growthRatio, null);
    assert.equal(trace.baselineReady, false);
  }
});

test('baseline must use the same data scope and rules', () => {
  const request = fixture();
  const baseline = request.baseline.map(trace => ({ ...trace, source: { ...trace.source, scopeId: 'wrong-scope' } }));
  assert.equal(finalizeWindow({ ...request, baseline }).baselineEvidence.length, 0);
  assert.equal(finalizeWindow({ ...request, rules: { ...RULES, version: 'another-version' } }).baselineReady, false);
});

test('a zero baseline never fabricates an infinite growth ratio', () => {
  const request = fixture();
  const baseline = request.baseline.map(trace => finalizeWindow({ ...request, inputs: [], baseline: [], windowStart: trace.window.start, now: trace.window.end }));
  const trace = finalizeWindow({ ...request, baseline });
  assert.equal(trace.baselineReady, true);
  assert.equal(trace.baselineAverage, 0);
  assert.equal(trace.growthRatio, null);
  assert.equal(trace.path, 'SURGE');
});

test('UTC alignment and fixed-window identities survive retries and late data', () => {
  const request = buildExample('single');
  const first = finalizeWindow({ ...request, coverage: 'partial' });
  const reconciled = finalizeWindow({ ...request, inputs: [...request.inputs, { ...request.inputs[0], id: 'late-pulse', timestamp: request.windowStart + 50_000 }], now: request.now + 15_000 });
  assert.equal(first.id, reconciled.id);
  assert.equal(first.count, 1);
  assert.equal(reconciled.count, 2);
  assert.equal(finalizeWindow({ ...request, windowStart: request.windowStart + 1234 }).window.start, request.windowStart);
  assert.equal(finalizeWindow({ ...request, source: { ...request.source, label: 'Renamed display label' } }).id, first.id);
});

test('example fixtures are explicit, fixed, and never contain signatures', () => {
  const ids = [];
  for (const kind of ['single', 'burst', 'flow']) {
    const request = buildExample(kind);
    assert.deepEqual(request, buildExample(kind));
    assert.equal(request.source.mode, 'example');
    assert.ok(request.inputs.every(input => !input.signature));
    ids.push(finalizeWindow(request).id);
  }
  assert.equal(new Set(ids).size, 3);
  assert.equal(finalizeWindow(buildExample('single')).path, 'FLOW');
  assert.equal(finalizeWindow(buildExample('flow')).path, 'FLOW');
});

test('import validator rejects tampered output, unknown fields and invalid baseline', () => {
  const trace = finalizeWindow(fixture());
  assert.equal(validateTrace({ ...trace, path: 'QUIET' }).valid, false);
  assert.equal(validateTrace({ ...trace, html: '<script>bad()</script>' }).valid, false);
  assert.equal(validateTrace({ ...trace, baselineEvidence: [{ count: 0 }] }).valid, false);
  assert.equal(validateTrace({ ...trace, rules: { ...trace.rules, run: 'alert(1)' } }).valid, false);
});

test('root window dates outside the JavaScript UTC date range are rejected', () => {
  const request = fixture(), trace = finalizeWindow(request), extreme = 9_000_000_000_000_000;
  assert.throws(() => finalizeWindow({ ...request, windowStart: extreme, now: extreme + RULES.windowMs }), /supported date range/);
  assert.throws(() => finalizeWindow({ ...request, now: extreme }), /supported date range/);
  assert.throws(() => finalizeWindow({ ...request, windowStart: 8_640_000_000_000_000, now: 8_640_000_000_000_000 }), /Window end/);
  const forgedObservedAt = validateTrace({ ...trace, observedAt: extreme });
  assert.equal(forgedObservedAt.valid, false);
  assert.match(forgedObservedAt.errors.join(' '), /supported date range/);
  assert.equal(validateTrace({ ...trace, window: { ...trace.window, start: extreme, end: extreme + RULES.windowMs }, observedAt: extreme }).valid, false);
});

test('invalid Trace branding follows the application name without changing the trace protocol', () => {
  assert.deepEqual(validateTrace({}).errors, [`Not a valid ${BRAND_NAME} Trace.`]);
  assert.equal(finalizeWindow(fixture()).schema, 'circuit.trace.v1');
  assert.equal(RULES.version, 'living-circuit.v1');
});
