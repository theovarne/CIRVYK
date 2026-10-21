import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildWorkbenchTrace, normalizeWorkbenchParameters, workbenchSignalBins, WORKBENCH_LIMITS, mountWorkbench } from '../public/modules/workbench.js';
import { RULES, validateTrace, stableStringify } from '../public/modules/engine.js';
import { saveTrace, loadTraces, exportTrace, importTrace } from '../public/modules/memory.js';

test('all supported local parameter combinations reproduce valid Trace records', () => {
  const identities = new Set();
  for (const scenario of WORKBENCH_LIMITS.scenarios) for (const windowSeconds of WORKBENCH_LIMITS.windows) for (let multiplier = 1; multiplier <= 5; multiplier++) {
    const trace = buildWorkbenchTrace({ scenario, windowSeconds, multiplier });
    assert.equal(validateTrace(trace).valid, true);
    assert.equal(trace.window.durationMs, windowSeconds * 1000);
    assert.equal(trace.window.start % trace.window.durationMs, 0);
    assert.equal(trace.status, 'final');
    assert.equal(trace.source.mode, 'example');
    assert.equal(trace.source.network, 'example');
    assert.equal(trace.source.mint, null);
    assert.deepEqual(trace.source.accounts, []);
    assert.equal(trace.inputs.some(input => 'signature' in input), false);
    assert.equal(trace.filtered.length, 0);
    assert.ok(trace.count >= 1 && trace.count <= WORKBENCH_LIMITS.maxInputs);
    assert.equal(identities.has(trace.id), false);
    identities.add(trace.id);
  }
  assert.equal(identities.size, 45);
});

test('local parameter changes never mutate the shared live rules', () => {
  const before = stableStringify(RULES);
  buildWorkbenchTrace({ windowSeconds: 300, multiplier: 5 });
  assert.equal(stableStringify(RULES), before);
  assert.equal(RULES.windowMs, 60000);
});

test('fixture data and output are deterministic across repeated execution', () => {
  assert.deepEqual(buildWorkbenchTrace({ scenario: 'burst', multiplier: 4, windowSeconds: 120 }), buildWorkbenchTrace({ scenario: 'burst', multiplier: 4, windowSeconds: 120 }));
});

test('each local window retains five consecutive same-scope baseline windows', () => {
  const trace = buildWorkbenchTrace({ scenario: 'burst', multiplier: 5, windowSeconds: 300 });
  assert.equal(trace.count, 60);
  assert.equal(trace.path, 'SURGE');
  assert.equal(trace.baselineAverage, 3);
  assert.equal(trace.growthRatio, 20);
  trace.baselineEvidence.forEach((evidence, index) => {
    assert.equal(evidence.count, 3);
    assert.equal(evidence.source.scopeId, trace.source.scopeId);
    assert.equal(evidence.window.start, trace.window.start - (5 - index) * trace.rules.windowMs);
  });
});

test('single and flow keep the engine thresholds; no random path selection', () => {
  assert.equal(buildWorkbenchTrace({ scenario: 'single' }).path, 'FLOW');
  assert.equal(buildWorkbenchTrace({ scenario: 'flow' }).path, 'FLOW');
  assert.equal(buildWorkbenchTrace({ scenario: 'flow', multiplier: 2 }).path, 'SURGE');
});

test('waveforms are distinct aggregates and their count totals match the record', () => {
  const trace = buildWorkbenchTrace({ scenario: 'flow', multiplier: 3 });
  const bins = workbenchSignalBins(trace);
  assert.equal(bins.length, 24);
  assert.equal(bins.reduce((sum, bin) => sum + bin.received, 0), trace.inputs.length);
  assert.equal(bins.reduce((sum, bin) => sum + bin.accepted, 0), trace.count);
  assert.equal(bins.at(-1).accumulated, trace.count);
  assert.equal(bins[0].start, trace.window.start);
  assert.equal(bins.at(-1).end, trace.window.end);
  for (let i = 1; i < bins.length; i++) assert.ok(bins[i].accumulated >= bins[i - 1].accumulated);
  assert.notDeepEqual(bins.map(bin => bin.received), bins.map(bin => bin.accumulated));
});

test('unsupported local settings are rejected instead of silently creating data', () => {
  for (const value of [{ scenario: 'live' }, { multiplier: 0 }, { multiplier: 6 }, { multiplier: 1.5 }, { multiplier: NaN }, { windowSeconds: 90 }, { windowSeconds: Infinity }]) assert.throws(() => normalizeWorkbenchParameters(value));
  for (const bins of [0, -1, 121, 1.5, NaN]) assert.throws(() => workbenchSignalBins(buildWorkbenchTrace(), bins));
});

test('the recovered chassis retains seven physical trays but no old identity or active node claims', () => {
  const svg = readFileSync(new URL('../public/assets/workbench-chassis.svg', import.meta.url), 'utf8');
  assert.equal((svg.match(/data-wb-slot=/g) || []).length, 7);
  assert.ok((svg.match(/<path/g) || []).length > 100);
  for (const component of ['sensor', 'resistor', 'capacitor', 'comparator', 'switch', 'memory', 'bus']) assert.ok(svg.includes(`data-wb-slot="${component}"`));
  assert.equal(/ohmium|\bOHM\b|UP 0\/7|<script|<foreignObject|\son\w+=/i.test(svg), false);
});

test('local 120 and 300 second records round-trip through unchanged V1 Memory', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  for (const windowSeconds of [120, 300]) {
    const trace = buildWorkbenchTrace({ scenario: 'burst', windowSeconds, multiplier: 5 });
    const saved = saveTrace(trace, storage);
    assert.equal(saved.error, null);
    const json = exportTrace(trace);
    assert.equal(importTrace(json, storage).error, null);
    assert.deepEqual(loadTraces(storage).traces.find(value => value.id === trace.id), trace);
  }
  assert.equal(loadTraces(storage).traces.length, 2);
});

// A small DOM surface exercises the actual mounted controller and timer
// callbacks. It does not implement layout or stand in for browser visual QA.
class BenchElement {
  constructor(document) {
    this.ownerDocument = document; this.children = []; this.dataset = {}; this.attributes = {};
    this.listeners = new Map(); this.value = ''; this.textContent = '';
    const classes = new Set();
    this.classList = { add: value => classes.add(value), remove: value => classes.delete(value), toggle(value, force) { if (force ?? !classes.has(value)) classes.add(value); else classes.delete(value); } };
  }
  addEventListener(type, handler, options = {}) {
    const values = this.listeners.get(type) || new Set(); values.add(handler); this.listeners.set(type, values);
    options.signal?.addEventListener('abort', () => values.delete(handler), { once: true });
  }
  dispatch(type, target = this, properties = {}) {
    const event = { target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...properties };
    for (const handler of this.listeners.get(type) || []) handler(event);
    return event;
  }
  matches(selector) {
    return selector === '[data-wb-slot]' && typeof this.dataset.wbSlot === 'string'
      || selector === '[data-wb-component]' && typeof this.dataset.wbComponent === 'string'
      || selector === '[data-wb-action]' && typeof this.dataset.wbAction === 'string';
  }
  closest(selector) { return this.matches(selector) ? this : null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  append(...values) { this.children.push(...values); }
  replaceChildren(...values) { this.children = values; }
  focus() {} scrollIntoView() {}
}
function mountedBench(t) {
  let now = 0, nextTimer = 0;
  const tasks = new Map();
  t.mock.method(globalThis, 'setTimeout', (run, ms) => { const id = ++nextTimer; tasks.set(id, { run, at: now + ms }); return id; });
  t.mock.method(globalThis, 'clearTimeout', id => tasks.delete(id));
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false }));
  const document = new BenchElement();
  document.createElement = () => new BenchElement(document);
  document.createElementNS = () => new BenchElement(document);
  document.createTextNode = value => ({ textContent: value });
  document.defaultView = new BenchElement(document); document.defaultView.location = { hash: '#workbench' };
  const root = new BenchElement(document), nodes = new Map();
  const slots = ['sensor', 'resistor', 'capacitor', 'comparator', 'switch', 'memory', 'bus'].map(id => {
    const slot = new BenchElement(document); slot.dataset.wbSlot = id; return slot;
  });
  root.querySelector = selector => { if (!nodes.has(selector)) nodes.set(selector, new BenchElement(document)); return nodes.get(selector); };
  root.querySelectorAll = selector => selector === '[data-wb-component]' ? root.querySelector('.wb-stage-rail').children : selector === '[data-wb-slot]' ? slots : [];
  const form = root.querySelector('.wb-form');
  form.elements = Object.fromEntries(Object.entries({ scenario: 'burst', windowSeconds: '60', multiplier: '1', speed: '1', replayMode: 'auto' }).map(([name, value]) => [name, Object.assign(new BenchElement(document), { name, value })]));
  const events = [];
  const callbacks = Object.fromEntries(['onTrace', 'onPlay', 'onPause', 'onStep', 'onReset', 'onSelect', 'onSpeed'].map(name => [name, (...args) => events.push({ name, args })]));
  const bench = mountWorkbench(root, callbacks);
  t.after(() => bench.destroy());
  return { bench, root, document, events, slots, pending: () => tasks.size,
    input(name, value) { const input = form.elements[name]; input.value = String(value); form.dispatch('input', input); },
    tick(ms) {
      const until = now + ms;
      while (true) {
        const pending = [...tasks].sort((a, b) => a[1].at - b[1].at)[0];
        if (!pending || pending[1].at > until) break;
        tasks.delete(pending[0]); now = pending[1].at; pending[1].run();
      }
      now = until;
    },
  };
}

test('mounted automatic playback owns one timer, pauses, resumes, and stops exactly at Memory', t => {
  const { bench, events, tick, pending } = mountedBench(t);
  bench.play();
  assert.equal(bench.getPlaybackState().step, 0);
  assert.equal(bench.getPlaybackState().playing, true);
  assert.equal(pending(), 1);
  tick(900); assert.equal(bench.getPlaybackState().step, 1);
  bench.pause(); tick(9000);
  assert.equal(bench.getPlaybackState().step, 1); assert.equal(pending(), 0);
  bench.play(); assert.equal(bench.getPlaybackState().step, 2);
  tick(9000);
  assert.equal(bench.getPlaybackState().step, 5); assert.equal(bench.getPlaybackState().playing, false); assert.equal(pending(), 0);
  assert.deepEqual(events.filter(value => value.name === 'onStep').map(value => value.args[0]), [0, 1, 2, 3, 4, 5]);
  assert.equal(events.at(-1).name, 'onPause');
});

test('mounted Workbench displays Eastern window and waveform dates without shifting its deterministic record', t => {
  const {bench,root}=mountedBench(t);
  assert.equal(root.querySelector('[data-wb-window]').textContent,'2026-10-15 20:05:00 EDT');
  assert.equal(root.querySelector('[data-wb-signal-start]').textContent,'2026-10-15 20:05:00 EDT');
  assert.equal(root.querySelector('[data-wb-signal-end]').textContent,'2026-10-15 20:06:00 EDT');
  const waveform=root.querySelector('[data-wb-wave]').children[0];
  const labels=waveform.children.flatMap(node=>node.children).map(node=>node.textContent).join('\n');
  assert.match(labels,/2026-10-15 20:05:00 EDT/);
  assert.match(labels,/UTC-04:00/);
  assert.equal(bench.getTrace().window.start,1792109100000);
  assert.equal(bench.getTrace().id,'trace-4b3e7836fc74f16c');
});

test('mobile heading retains word separation when its desktop line break is hidden',t=>{
  const {root}=mountedBench(t);
  const heading=root.innerHTML.match(/<h2>([\s\S]*?)<\/h2>/)?.[1];
  assert.ok(heading?.includes('<br>'),'the existing desktop line break remains');
  assert.equal(heading.replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim(),'Shape a signal. Inspect its route.');
});

test('mounted speed changes replace the pending timer without changing Trace data', t => {
  const { bench, tick, input, pending } = mountedBench(t), before = bench.getTrace();
  bench.play(); tick(500); input('speed', 4);
  assert.equal(pending(), 1); tick(224); assert.equal(bench.getPlaybackState().step, 0);
  tick(1); assert.equal(bench.getPlaybackState().step, 1);
  bench.setSpeed(0.5); assert.equal(pending(), 1);
  tick(1799); assert.equal(bench.getPlaybackState().step, 1);
  tick(1); assert.equal(bench.getPlaybackState().step, 2);
  assert.deepEqual(bench.getTrace(), before);
  assert.throws(() => bench.setSpeed(3), /supported replay speed/);
});

test('mounted manual execution and shared Step/Reset APIs remain timer-free and retain parameters', t => {
  const { bench, tick, input, pending, events } = mountedBench(t);
  input('windowSeconds', 300); input('multiplier', 5); input('replayMode', 'step');
  const trace = bench.getTrace();
  bench.play(); tick(9000);
  assert.equal(bench.getPlaybackState().step, 0); assert.equal(bench.getPlaybackState().playing, false); assert.equal(pending(), 0);
  bench.step(); assert.equal(bench.getPlaybackState().step, 1); assert.equal(pending(), 0);
  bench.resetPlayback();
  assert.deepEqual(bench.getPlaybackState(), { step: -1, playing: false, speed: 1, selected: 'sensor', replayMode: 'step' });
  assert.deepEqual(bench.getTrace(), trace); assert.equal(trace.count, 60); assert.equal(trace.window.durationMs, 300000);
  assert.deepEqual(events.slice(-2).map(value => value.name), ['onReset', 'onSelect']);
});

test('mounted parameter changes cancel playback and synchronize every new record before replay', t => {
  const { bench, input, tick, pending, events, root } = mountedBench(t);
  bench.play(); input('scenario', 'flow'); input('windowSeconds', 120); input('multiplier', 3); tick(9000);
  assert.equal(bench.getPlaybackState().step, -1); assert.equal(bench.getPlaybackState().playing, false); assert.equal(pending(), 0);
  assert.equal(bench.getTrace().count, 18); assert.equal(bench.getTrace().window.durationMs, 120000);
  assert.equal(root.querySelector('[data-wb-count]').textContent, '18');
  assert.equal(root.querySelector('[data-wb-duration]').textContent, '120s');
  assert.deepEqual(events.slice(-2).map(value => value.name), ['onTrace', 'onReset']);
});

test('mounted route exit and background visibility cancel pending work; reset restores Ready on return', t => {
  const { bench, document, tick, pending } = mountedBench(t);
  bench.play(); document.defaultView.location.hash = '#home'; document.defaultView.dispatch('hashchange'); tick(9000);
  assert.equal(bench.getPlaybackState().step, 0); assert.equal(bench.getPlaybackState().playing, false); assert.equal(pending(), 0);
  document.defaultView.location.hash = '#workbench'; bench.resetPlayback();
  assert.equal(bench.getPlaybackState().step, -1);
  bench.play(); document.hidden = true; document.dispatch('visibilitychange'); tick(9000);
  assert.equal(bench.getPlaybackState().step, 0); assert.equal(pending(), 0);
  bench.destroy(); bench.destroy(); bench.play(); bench.step(); bench.resetPlayback(); bench.setSelection('switch');
  assert.equal(pending(), 0);
});

test('clicking a chassis slot pins the component and cancels automatic playback', t => {
  const { bench, root, slots, events, tick, pending } = mountedBench(t);
  bench.play();
  root.dispatch('click', slots.find(slot => slot.dataset.wbSlot === 'memory'));
  assert.equal(bench.getPlaybackState().playing, false);
  assert.equal(bench.getPlaybackState().selected, 'memory');
  assert.equal(pending(), 0);
  assert.deepEqual(events.slice(-2).map(value => value.name), ['onPause', 'onSelect']);
  tick(9000);
  assert.equal(bench.getPlaybackState().step, 0);
  assert.equal(bench.getPlaybackState().selected, 'memory');
  assert.match(root.querySelector('[data-wb-feedback]').textContent, /Memory selected for inspection/);
});

test('clicking a six-stage button pins selection without a later timer overriding it', t => {
  const { bench, root, tick, pending } = mountedBench(t);
  bench.play(); tick(900);
  const button = root.querySelector('.wb-stage-rail').children.find(value => value.dataset.wbComponent === 'switch');
  root.dispatch('click', button);
  assert.equal(bench.getPlaybackState().playing, false);
  assert.equal(bench.getPlaybackState().selected, 'switch');
  assert.equal(pending(), 0);
  tick(9000);
  assert.equal(bench.getPlaybackState().step, 1);
  assert.equal(bench.getPlaybackState().selected, 'switch');
});

test('Enter and Space pin SVG slot selection while unrelated keys and the decorative bus do not stop playback', t => {
  const { bench, root, slots, tick, pending } = mountedBench(t);
  const slot = id => slots.find(value => value.dataset.wbSlot === id);
  bench.play();
  assert.equal(root.dispatch('keydown', slot('memory'), { key: 'ArrowRight' }).defaultPrevented, false);
  root.dispatch('click', slot('bus'));
  assert.equal(bench.getPlaybackState().playing, true); assert.equal(pending(), 1);
  for (const [key, id] of [['Enter', 'capacitor'], [' ', 'comparator']]) {
    if (!bench.getPlaybackState().playing) bench.play();
    const step = bench.getPlaybackState().step;
    assert.equal(root.dispatch('keydown', slot(id), { key }).defaultPrevented, true);
    tick(9000);
    assert.equal(bench.getPlaybackState().playing, false);
    assert.equal(bench.getPlaybackState().selected, id);
    assert.equal(bench.getPlaybackState().step, step);
    assert.equal(pending(), 0);
  }
});

test('the six interactive SVG slots expose pressed selection and leave the decorative bus without pressed state', t => {
  const { bench, root, slots } = mountedBench(t);
  const assertSelected = id => {
    for (const slot of slots) assert.equal(slot.attributes['aria-pressed'], slot.dataset.wbSlot === 'bus' ? undefined : String(slot.dataset.wbSlot === id));
    for (const button of root.querySelector('.wb-stage-rail').children) assert.equal(button.attributes['aria-pressed'], String(button.dataset.wbComponent === id));
  };
  assertSelected('sensor');
  bench.setSelection('memory'); assertSelected('memory');
  bench.play(); assertSelected('sensor');
  root.dispatch('click', slots.find(slot => slot.dataset.wbSlot === 'switch')); assertSelected('switch');
  bench.resetPlayback(); assertSelected('sensor');
});
