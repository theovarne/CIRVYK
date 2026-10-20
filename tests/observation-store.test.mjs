import test from 'node:test';
import assert from 'node:assert/strict';
import { ObservationStore } from '../public/modules/observation-store.js';
import { buildExample, finalizeWindow } from '../public/modules/engine.js';

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 9, 17, 0, 8, 30);
const CURRENT = Math.floor(NOW / MINUTE) * MINUTE;
const MINT = 'So11111111111111111111111111111111111111112';
const ACCOUNT = '11111111111111111111111111111111';
const SCOPE = { id: 'fixture-live-scope', mint: MINT, network: 'mainnet-beta', observedAccounts: [ACCOUNT], source: 'Solana JSON-RPC' };
const CONFIG = { status: 'configured', scope: SCOPE, pollingMs: 15_000 };
const utc = value => new Date(value).toISOString();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function signature(number) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let suffix = '';
  do { suffix = alphabet[number % 58] + suffix; number = Math.floor(number / 58); } while (number);
  return '3'.repeat(80) + suffix;
}
const pulse = (number, timestamp = CURRENT - MINUTE + 1000) => ({ id: `input-${number}`, signature: signature(number), mint: MINT, slot: 12345 + number, timestamp, kind: 'Activity', source: 'live', verified: true, scopeId: SCOPE.id, accounts: [ACCOUNT] });
function batch(overrides = {}) {
  return { status: 'live', scope: SCOPE, lastChecked: utc(NOW), latestEventUTC: null, pulses: [], pending: { count: 0, reasons: [] }, coverage: 'complete', cursor: 'cursor-1', reconciledFrom: utc(CURRENT - 8 * MINUTE), reconciledUntil: utc(CURRENT), ...overrides };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
function fixture(responses = [batch()], config = CONFIG) {
  const calls = [];
  let index = 0;
  return {
    calls,
    fetcher: async (url) => {
      calls.push(url);
      if (url === '/api/config') return json(config);
      const item = responses[Math.min(index++, responses.length - 1)];
      if (item instanceof Error) throw item;
      return item instanceof Response ? item.clone() : json(item);
    },
  };
}
class FakeDocument extends EventTarget {
  hidden = false;
  visibilityState = 'visible';
  hide(value) { this.hidden = value; this.visibilityState = value ? 'hidden' : 'visible'; this.dispatchEvent(new Event('visibilitychange')); }
}

test('unconfigured start reads only config, with no observation polling', async () => {
  const rpc = fixture([], { status: 'unconfigured', scope: { ...SCOPE, mint: null, observedAccounts: [] }, missing: ['CIRCUIT_MINT', 'CIRCUIT_OBSERVED_ACCOUNTS'] });
  const store = new ObservationStore({ fetcher: rpc.fetcher, clock: () => NOW, pollMs: 5, document: new FakeDocument() });
  try {
    await store.start();
    await wait(20);
    assert.deepEqual(rpc.calls, ['/api/config']);
    assert.equal(store.state.status, 'unconfigured');
    assert.equal(store.state.trace.path, null);
    assert.equal(store.state.traces.length, 0);
  } finally { store.stop(); }
});

test('Home and Circuit refreshes coalesce one in-flight observation request', async () => {
  let release;
  const calls = [];
  const store = new ObservationStore({ clock: () => NOW, fetcher: async url => {
    calls.push(url);
    if (url === '/api/config') return json(CONFIG);
    await new Promise(resolve => { release = resolve; });
    return json(batch({ pulses: [pulse(1)] }));
  } });
  const started = store.start();
  await wait(0);
  const first = store.refresh(), second = store.refresh();
  assert.equal(first, second);
  release();
  try {
    await started;
    await first;
    assert.equal(calls.filter(url => url.startsWith('/api/observation')).length, 1);
    assert.equal(store.state.pulses.length, 1);
  } finally { store.stop(); }
});

test('incremental batches accumulate and duplicate signature/mint never increases the count', async () => {
  const rpc = fixture([batch({ pulses: [pulse(1)] }), batch({ pulses: [pulse(1), pulse(2)], cursor: 'cursor-2' }), batch({ pulses: [] })]);
  const store = new ObservationStore({ fetcher: rpc.fetcher, clock: () => NOW });
  await store.refresh();
  await store.refresh();
  await store.refresh();
  assert.equal(store.state.pulses.length, 2);
  assert.equal(store.state.traces[0].count, 2);
  assert.equal(rpc.calls[2], '/api/observation?cursor=cursor-1');
  assert.equal(rpc.calls[3], '/api/observation?cursor=cursor-2');
  assert.equal(store.state.trace.path, null);
  assert.equal(store.state.trace.status, 'accumulating');
});

test('network failure keeps genuine check/event times, previous inputs and final records', async () => {
  const event = pulse(1);
  const rpc = fixture([batch({ pulses: [event], latestEventUTC: utc(event.timestamp) }), new Error('Offline')]);
  let current = NOW;
  const store = new ObservationStore({ fetcher: rpc.fetcher, clock: () => current });
  await store.refresh();
  const records = store.state.traces.map(trace => trace.id);
  current += 15_000;
  await store.refresh();
  assert.equal(store.state.status, 'error');
  assert.equal(store.state.coverage, 'unavailable');
  assert.equal(store.state.lastChecked, utc(NOW));
  assert.equal(store.state.lastSuccess, utc(NOW));
  assert.equal(store.state.latestEvent, utc(event.timestamp));
  assert.equal(store.state.pulses.length, 1);
  assert.deepEqual(store.state.traces.map(trace => trace.id), records);
  assert.equal(store.state.trace.path, null);
  assert.match(store.state.error, /Offline/);
});

test('429 retains inputs and check time while explicitly reporting rate limiting', async () => {
  const rpc = fixture([batch({ pulses: [pulse(1)] }), json({ error: 'Retry after 12 seconds.' }, 429)]);
  const store = new ObservationStore({ fetcher: rpc.fetcher, clock: () => NOW });
  await store.refresh();
  await store.refresh();
  assert.equal(store.state.status, 'rate_limited');
  assert.equal(store.state.lastChecked, utc(NOW));
  assert.equal(store.state.pulses.length, 1);
  assert.match(store.state.error, /12 seconds/);
});

test('expired cursor clears once and retries without losing previous inputs', async () => {
  const rpc = fixture([batch({ pulses: [pulse(1)] }), json({ status: 'cursor_expired' }, 409), batch({ pulses: [pulse(2)], cursor: 'new-cursor' })]);
  const store = new ObservationStore({ fetcher: rpc.fetcher, clock: () => NOW });
  await store.refresh();
  await store.refresh();
  assert.equal(store.state.status, 'live');
  assert.equal(store.state.pulses.length, 2);
  assert.deepEqual(rpc.calls.slice(2), ['/api/observation?cursor=cursor-1', '/api/observation']);
  const rejected = fixture([json({ error: 'Expired' }, 409)]);
  const failedStore = new ObservationStore({ fetcher: rejected.fetcher, clock: () => NOW });
  await failedStore.refresh();
  assert.equal(failedStore.state.status, 'error');
  assert.equal(rejected.calls.filter(url => url.startsWith('/api/observation')).length, 2);
});

test('partial, missing parsing evidence and unavailable data cannot produce QUIET', async () => {
  for (const override of [{ coverage: 'partial' }, { coverage: 'unavailable' }, { pending: { count: 1, reasons: ['Parsing'] } }, { pending: undefined }, { reconciledUntil: null }]) {
    const rpc = fixture([batch(override)]);
    const store = new ObservationStore({ fetcher: rpc.fetcher, clock: () => NOW });
    await store.refresh();
    assert.equal(store.state.traces.length, 0);
    assert.equal(store.state.trace.path, null);
  }
});

test('only proved closed empty windows become QUIET; current window stays open', async () => {
  const rpc = fixture();
  const saved = [];
  const store = new ObservationStore({ fetcher: rpc.fetcher, clock: () => NOW, onTrace: trace => saved.push(trace) });
  await store.refresh();
  assert.equal(store.state.traces.length, 8);
  assert.equal(saved.length, 8);
  assert.ok(saved.every(trace => trace.status === 'final' && trace.path === 'QUIET' && trace.count === 0 && trace.window.end <= CURRENT));
  assert.equal(store.state.trace.window.start, CURRENT);
  assert.equal(store.state.trace.path, null);
  assert.equal(store.state.trace.coverage, 'partial');
  assert.equal(store.state.traces[0].baselineReady, true);
  assert.equal(store.state.traces[0].growthRatio, null);
});

test('proof intervals merge without inventing a complete window across an uncovered gap', async () => {
  const from = CURRENT - 2 * MINUTE;
  const rpc = fixture([
    batch({ reconciledFrom: utc(from), reconciledUntil: utc(from + 20_000) }),
    batch({ reconciledFrom: utc(from + 30_000), reconciledUntil: utc(from + MINUTE) }),
    batch({ reconciledFrom: utc(from + 20_000), reconciledUntil: utc(from + 30_000) }),
  ]);
  const store = new ObservationStore({ fetcher: rpc.fetcher, clock: () => NOW });
  await store.refresh();
  await store.refresh();
  assert.equal(store.state.traces.length, 0);
  await store.refresh();
  assert.equal(store.state.traces.length, 1);
  assert.equal(store.state.traces[0].window.start, from);
});

test('late data upserts the same Trace and recomputes dependent baseline evidence', async () => {
  const earlyTime = CURRENT - 5 * MINUTE + 1000;
  const firstInputs = [pulse(1, earlyTime), ...Array.from({ length: 12 }, (_, index) => pulse(index + 10))];
  const rpc = fixture([batch({ pulses: firstInputs }), batch({ pulses: [pulse(2, earlyTime)] }), batch()]);
  let current = NOW;
  const updates = [];
  const store = new ObservationStore({ fetcher: rpc.fetcher, clock: () => current, onTrace: trace => updates.push(trace) });
  await store.refresh();
  const original = store.state.traces.find(trace => trace.window.start === CURRENT - 5 * MINUTE);
  const dependent = store.state.traces[0];
  const initialCount = updates.length;
  current += 1000;
  await store.refresh();
  const revised = store.state.traces.find(trace => trace.id === original.id);
  assert.equal(revised.count, 2);
  assert.equal(store.state.traces.length, 8);
  assert.equal(updates.filter(trace => trace.id === original.id).length, 2);
  assert.equal(updates.filter(trace => trace.id === dependent.id).length, 2);
  assert.ok(updates.length > initialCount);
  const afterRevision = updates.length;
  current += 1000;
  await store.refresh();
  assert.equal(updates.length, afterRevision);
});

test('visibility pauses polling and resumes one shared foreground check', async () => {
  const document = new FakeDocument();
  const rpc = fixture();
  const store = new ObservationStore({ fetcher: rpc.fetcher, clock: () => NOW, document, pollMs: 10 });
  try {
    await store.start();
    document.hide(true);
    const pausedCount = rpc.calls.length;
    await wait(35);
    assert.equal(rpc.calls.length, pausedCount);
    document.hide(false);
    await wait(2);
    assert.equal(rpc.calls.length, pausedCount + 1);
    store.stop();
    const stoppedCount = rpc.calls.length;
    await wait(20);
    assert.equal(rpc.calls.length, stoppedCount);
  } finally { store.stop(); }
});

test('retention invalidates the whole dropped window instead of finalizing a smaller count', async () => {
  const oldStart = CURRENT - 2 * MINUTE;
  const rpc = fixture([batch({ pulses: [pulse(1, oldStart + 1000), pulse(2, oldStart + 2000), pulse(3, oldStart + MINUTE + 1000)] })]);
  const store = new ObservationStore({ fetcher: rpc.fetcher, clock: () => NOW, maxInputs: 2 });
  await store.refresh();
  assert.equal(store.state.pulses.length, 2);
  assert.ok(!store.state.traces.some(trace => trace.window.start === oldStart));
  assert.equal(store.state.traces[0].count, 1);
  assert.equal(store.state.coverage, 'partial');
  assert.match(store.state.pending.reasons.join(' '), /retention/);
});

test('workbench examples are isolated and cannot enter live state', async () => {
  const example = buildExample('burst');
  const rpc = fixture([batch({ pulses: [pulse(1), ...example.inputs] })]);
  const store = new ObservationStore({ fetcher: rpc.fetcher, clock: () => NOW });
  await store.refresh();
  const before = JSON.stringify(store.state);
  const result = finalizeWindow(example);
  assert.equal(result.source.mode, 'example');
  assert.equal(result.count, 12);
  assert.equal(JSON.stringify(store.state), before);
  assert.equal(store.state.pulses.length, 1);
  assert.ok(store.state.traces.every(trace => trace.source.mode === 'live'));
});

test('subscriptions get updates and can unsubscribe; failing save callback has feedback', async () => {
  const rpc = fixture();
  let calls = 0;
  const store = new ObservationStore({ fetcher: rpc.fetcher, clock: () => NOW, onTrace: () => { throw new Error('Browser storage is full.'); } });
  const unsubscribe = store.subscribe(() => calls++);
  await store.refresh();
  assert.ok(calls > 1);
  assert.match(store.state.error, /storage is full/);
  unsubscribe();
  const previous = calls;
  await store.refresh();
  assert.equal(calls, previous);
});

test('fetch is called with the global receiver required by native browser fetch', async () => {
  const store = new ObservationStore({ clock: () => NOW, fetcher: function(url) {
    assert.equal(this, globalThis);
    return Promise.resolve(json(url === '/api/config' ? CONFIG : batch()));
  } });
  await store.refresh();
  assert.equal(store.state.status, 'live');
});
