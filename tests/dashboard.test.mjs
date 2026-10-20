import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExample, finalizeWindow } from '../public/modules/engine.js';
import { CircuitDashboard } from '../public/modules/dashboard.js';

class Mount extends EventTarget {
  innerHTML = '';
  querySelectorAll() { return []; }
}

test('dashboard reports exact subrange totals even when its curve retains a larger plotting bucket', () => {
  const mount = new Mount(), dashboard = new CircuitDashboard([mount]);
  const trace = finalizeWindow(buildExample('burst'));
  dashboard.update(trace, { rangeStart: trace.window.start + 1100, rangeEnd: trace.window.start + 1600, bucketMs: 5000 });
  assert.equal((mount.innerHTML.match(/<strong>1 <small>Pulse \/ selection<\/small>/g) || []).length, 2);
  assert.doesNotMatch(mount.innerHTML, /NaN|undefined/);
  dashboard.destroy();
});

test('incomplete waveform readouts and grid tooltips explicitly identify observed lower bounds', () => {
  const mount = new Mount(), dashboard = new CircuitDashboard([mount]);
  const trace = finalizeWindow({ ...buildExample('single'), coverage: 'partial' });
  dashboard.update(trace);
  assert.equal((mount.innerHTML.match(/<strong>1 <small>observed \/ window<\/small>/g) || []).length, 2);
  assert.match(mount.innerHTML, /OBSERVED LOWER BOUND/);
  assert.match(mount.innerHTML, /incomplete coverage · 1 valid Pulses observed \(lower bound\)/);
  assert.match(mount.innerHTML, /stroke-dasharray="3 3"/);
  dashboard.destroy();
});

test('clearing a Trace removes its waveform and prior event numbers', () => {
  const mount = new Mount(), dashboard = new CircuitDashboard([mount]);
  dashboard.update(finalizeWindow(buildExample('burst')));
  dashboard.update(null);
  assert.match(mount.innerHTML, /No selected window/);
  assert.match(mount.innerHTML, /No synthetic waveform is shown/);
  assert.doesNotMatch(mount.innerHTML, /<polyline|>12<|NaN|undefined/);
  dashboard.destroy();
});
