import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CircuitRenderer, CIRCUIT_STAGES } from '../public/modules/renderer.js';

test('restored backplane retains detailed mechanical geometry and exactly six business components', async () => {
  const svg = await readFile(new URL('../public/assets/circuit-backplane.svg', import.meta.url), 'utf8');
  assert.equal((svg.match(/<path\b/g) || []).length, 2399);
  assert.equal((svg.match(/<circle\b/g) || []).length, 16);
  assert.deepEqual([...svg.matchAll(/data-component="([^"]+)"/g)].map(match => match[1]).sort(), [...CIRCUIT_STAGES].sort());
  assert.deepEqual([...svg.matchAll(/data-route="([^"]+)"/g)].map(match => match[1]).sort(), [...CIRCUIT_STAGES].sort());
  assert.equal((svg.match(/route-forward/g) || []).length >= 6, true);
  assert.match(svg, /Mechanical support 1.*?Passive graphic structure/);
  assert.match(svg, /Mechanical support 2.*?Passive graphic structure/);
  assert.doesNotMatch(svg, /OHMIUM|Agent component|is-runtime-online|https?:\/\/(?!www\.w3\.org)/i);
});

function rendererShell() {
  const renderer = Object.create(CircuitRenderer.prototype);
  Object.assign(renderer, {
    destroyed: false, asset: 'floorplan', pendingAsset: null, loadId: 0,
    assetViews: new Map(), view: { zoom: 1.4, x: 13, y: 20 },
    abort: new AbortController(), options: {}, svg: {},
    selected: 'capacitor', result: { id: 'selected-trace', count: 12 }, replayStep: 2,
    stopParticles() {},
  });
  return renderer;
}

test('asset API accepts only the two local asset names and preserves shared selection/Trace', async () => {
  const renderer = rendererShell();
  renderer.load = async (name) => { renderer.asset = name; renderer.pendingAsset = null; return renderer; };
  assert.throws(() => renderer.setAsset('https://elsewhere.invalid/asset.svg'), /floorplan or backplane/);
  assert.throws(() => renderer.setAsset('__proto__'), /floorplan or backplane/);
  await renderer.setAsset('backplane');
  assert.equal(renderer.selected, 'capacitor');
  assert.equal(renderer.result.id, 'selected-trace');
  assert.equal(renderer.replayStep, 2);
  assert.deepEqual(renderer.assetViews.get('floorplan'), { zoom: 1.4, x: 13, y: 20 });
});

test('repeated and rapid asset switches abort outdated requests without duplicating loads', async () => {
  const renderer = rendererShell(), requests = [];
  renderer.load = (name, id) => new Promise(resolve => requests.push({name, id, signal: renderer.abort.signal, resolve}));
  const first = renderer.setAsset('backplane');
  const repeated = renderer.setAsset('backplane');
  assert.equal(first, repeated);
  const last = renderer.setAsset('floorplan');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(requests[1].signal.aborted, false);
  assert.equal(requests[1].id > requests[0].id, true);
  requests.forEach(request => request.resolve(null));
  await Promise.all([first, last]);
});

test('zoom anchors use each asset viewBox rather than the old floorplan dimensions', () => {
  const renderer = rendererShell();
  renderer.bounds = {x: 0, y: 0, width: 980, height: 560};
  renderer.view = {zoom: 1, x: 0, y: 0};
  renderer.applyView = () => {};
  renderer.zoom(1);
  assert.deepEqual(renderer.view, {zoom: 2, x: -490, y: -280});
  renderer.resetView();
  assert.deepEqual(renderer.view, {zoom: 1, x: 0, y: 0});
});

test('panning suppresses component clicks and unrelated touch pointers cannot end the active drag', () => {
  class Surface extends EventTarget {
    constructor() { super(); this.style = {}; this.capture = null; }
    setPointerCapture(id) { this.capture = id; }
    hasPointerCapture(id) { return this.capture === id; }
    releasePointerCapture() { this.capture = null; }
    getBoundingClientRect() { return { width: 720, height: 510 }; }
  }
  const originalDocument = globalThis.document;
  globalThis.document = new Surface();
  try {
    const renderer = rendererShell(), component = new Surface(), clicks = [];
    Object.assign(renderer, { svg: new Surface(), mount: new Surface(), reducedMotion: new Surface(),
      components: new Map([['sensor', component]]), cleanups: [], bounds: { width: 720, height: 510 },
      view: { zoom: 1, x: 0, y: 0 }, select(id) { clicks.push(id); }, hover() {}, applyView() {},
    });
    renderer.bindInteractions();
    const pointer = (type, pointerId, clientX = 0, clientY = 0) => {
      const event = new Event(type); Object.assign(event, { pointerId, button: 0, clientX, clientY });
      renderer.svg.dispatchEvent(event);
    };
    pointer('pointerdown', 1); pointer('pointermove', 1, 20, 10);
    pointer('pointerdown', 2, 100, 100); pointer('pointerup', 2);
    assert.equal(renderer.drag.pointer, 1);
    pointer('pointermove', 1, 30, 20);
    assert.deepEqual(renderer.view, { zoom: 1, x: 30, y: 20 });
    pointer('pointerup', 1, 30, 20); component.dispatchEvent(new Event('click'));
    assert.deepEqual(clicks, []);
    pointer('pointerdown', 1); pointer('pointerup', 1); component.dispatchEvent(new Event('click'));
    assert.deepEqual(clicks, ['sensor']);
    renderer.cleanups.forEach(cleanup => cleanup());
  } finally { globalThis.document = originalDocument; }
});
