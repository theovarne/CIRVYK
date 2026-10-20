import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExample, finalizeWindow } from '../public/modules/engine.js';
import { buildInstrumentModel } from '../public/modules/instruments.js';

const fixture = kind => finalizeWindow(buildExample(kind || 'burst'));
const liveSource = { mode: 'live', label: 'Read-only observed accounts', network: 'mainnet-beta', mint: 'A'.repeat(32), accounts: ['B'.repeat(32)], scopeId: 'test-live' };
const live = () => {
  const request = buildExample('single');
  const input = { id: 'first', signature: 'C'.repeat(88), mint: liveSource.mint, slot: 42, timestamp: request.windowStart + 1000, kind: 'Transfer', source: 'live', verified: true, scopeId: liveSource.scopeId, address: 'D'.repeat(32), accounts: ['E'.repeat(32)] };
  return finalizeWindow({ ...request, source: liveSource, inputs: [input, { ...input, id: 'same-transaction-second-operation' }], baseline: [] });
};

test('instruments are pure and deterministic, leaving the engine result intact', () => {
  const trace = fixture(), before = JSON.stringify(trace);
  assert.deepEqual(buildInstrumentModel(trace), buildInstrumentModel(structuredClone(trace)));
  assert.equal(JSON.stringify(trace), before);
});

test('empty instruments do not present unknown observation as zero activity', () => {
  const model = buildInstrumentModel(null, { componentId: 'sensor' });
  assert.equal(model.available, false);
  assert.equal(model.metrics.inputCount, null);
  assert.equal(model.components[0].relativeActivity, null);
  assert.equal(model.components[0].selected, true);
  assert.deepEqual(model.activityGrid, []);
});

test('six distinct stages retain actual engine input/output and meaningful processing units', () => {
  const trace = fixture(), model = buildInstrumentModel(trace, { componentId: 'capacitor' });
  assert.deepEqual(model.components.map(component => component.processCount), [12, 12, 12, 1, 1, 1]);
  assert.equal(new Set(model.components.map(component => component.unit)).size, 6);
  assert.deepEqual(model.components.map(component => component.windowInputCount), trace.steps.map(step => step.inputCount));
  assert.equal(model.components.filter(component => component.selected).length, 1);
  assert.equal(model.components.find(component => component.selected).id, 'capacitor');
  assert.equal(model.components[3].wholeWindow, true);
  assert.match(model.metrics.intensityLabel, /no hardware/);
});

test('duplicate signatures count once as accepted, with a separate filter event', () => {
  const model = buildInstrumentModel(live(), { locallyObserved: true });
  assert.equal(model.metrics.inputCount, 2);
  assert.equal(model.metrics.acceptedCount, 1);
  assert.equal(model.metrics.filteredCount, 1);
  assert.equal(model.events.filter(event => event.accepted).length, 1);
  assert.match(model.events.find(event => event.filtered).reason, /Duplicate/);
  assert.equal(model.activityGrid.reduce((sum, bin) => sum + bin.count, 0), 1);
});

test('identical duplicate objects use multiplicity, rather than marking both accepted', () => {
  const request = buildExample('single'), trace = finalizeWindow({ ...request, inputs: [request.inputs[0], request.inputs[0]] });
  const model = buildInstrumentModel(trace);
  assert.deepEqual(model.events.map(event => event.accepted), [true, false]);
  assert.match(model.events[1].reason, /Duplicate example/);
  assert.equal(new Set(model.events.map(event => event.id)).size, 2);
});

test('complete empty bins are known zero; partial and missing bins remain unknown', () => {
  const request = buildExample('single');
  const quiet = buildInstrumentModel(finalizeWindow({ ...request, inputs: [] }));
  assert.ok(quiet.activityGrid.every(bin => bin.complete && bin.count === 0));
  for (const coverage of ['partial', 'missing']) {
    const model = buildInstrumentModel(finalizeWindow({ ...request, coverage }));
    assert.ok(model.activityGrid.every(bin => !bin.complete && bin.count === null && bin.intensity === null));
    assert.equal(model.activityGrid.reduce((sum, bin) => sum + bin.acceptedCount, 0), 1);
    assert.ok(model.waveform.series.every(series => series.values.every(point => point.value === null)));
    assert.equal(model.result.path, null);
  }
});

test('unfinalized and incompletely parsed traces do not claim concluded processing or coverage', () => {
  const request = buildExample('single');
  for (const change of [{ now: request.windowStart + 30_000 }, { parsingComplete: false }]) {
    const model = buildInstrumentModel(finalizeWindow({ ...request, ...change }));
    assert.equal(model.coverage.complete, false);
    assert.deepEqual(model.components.slice(3).map(component => component.processCount), [0, 0, 0]);
    assert.deepEqual(model.events[0].completedPath, ['sensor', 'resistor', 'capacitor']);
  }
});

test('grid uses explicit UTC half-open buckets and distinct input and accepted series', () => {
  const trace = live(), model = buildInstrumentModel(trace, { bucketMs: 10_000 });
  assert.equal(model.activityGrid.length, 6);
  assert.equal(model.activityGrid[0].end - model.activityGrid[0].start, 10_000);
  assert.equal(model.activityGrid[0].startUtc, new Date(trace.window.start).toISOString());
  assert.equal(model.waveform.unit, 'Pulse / bucket');
  assert.deepEqual(model.waveform.series.map(series => series.values[0].value), [2, 1]);
});

test('bucket boundary puts input in exactly one later bucket', () => {
  const request = buildExample('single');
  const trace = finalizeWindow({ ...request, inputs: [{ ...request.inputs[0], timestamp: request.windowStart + 10_000 }] });
  const bins = buildInstrumentModel(trace, { bucketMs: 10_000 }).activityGrid;
  assert.equal(bins[0].count, 0);
  assert.equal(bins[1].count, 1);
  assert.equal(bins.reduce((sum, bin) => sum + bin.count, 0), 1);
});

test('time selection filters events and component counts without recomputing the route', () => {
  const trace = fixture('flow'), start = trace.window.start;
  const model = buildInstrumentModel(trace, { rangeStart: start + 10_000, rangeEnd: start + 20_000, bucketMs: 5_000 });
  assert.equal(model.events.length, 1);
  assert.equal(model.metrics.acceptedCount, 1);
  assert.equal(model.components[2].processCount, 1);
  assert.equal(model.result.path, trace.path);
  assert.equal(model.result.wholeWindow, true);
  assert.equal(model.activityGrid.filter(bin => bin.selected).length, 2);
  assert.equal(model.activityGrid.length, 12);
});

test('waveform selection totals use exact timestamps rather than whole overlapping bins', () => {
  const trace = fixture('burst'), start = trace.window.start;
  const model = buildInstrumentModel(trace, { rangeStart: start + 1100, rangeEnd: start + 1600, bucketMs: 5000 });
  // All burst inputs share the first plotting bucket, but only one belongs to
  // this half-open selection. A selected-bucket sum would incorrectly show 12.
  assert.equal(model.metrics.acceptedCount, 1);
  assert.equal(model.waveform.series[0].selectedCount, 1);
  assert.equal(model.waveform.series[1].selectedCount, 1);
  assert.equal(model.bins.filter(bin => bin.selected).reduce((sum, bin) => sum + bin.acceptedCount, 0), 12);
});

test('waveform totals exclude untimestamped or out-of-window rejected inputs', () => {
  const request = buildExample('single');
  const trace = finalizeWindow({ ...request, inputs: [request.inputs[0], null, { ...request.inputs[0], id: 'outside', timestamp: request.windowStart - 1 }] });
  const model = buildInstrumentModel(trace);
  assert.equal(model.metrics.inputCount, 3);
  assert.equal(model.waveform.series[0].selectedCount, 1);
  assert.equal(model.waveform.series[1].selectedCount, 1);
  assert.ok(model.waveform.series.every(series => series.values.every(point => point.end > point.timestamp)));
});

test('invalid or disjoint ranges are bounded and never introduce fake inputs', () => {
  const trace = fixture();
  const model = buildInstrumentModel(trace, { rangeStart: trace.window.end + 5000, rangeEnd: trace.window.end + 10_000 });
  assert.equal(model.range.start, trace.window.end);
  assert.equal(model.range.end, trace.window.end);
  assert.equal(model.events.length, 0);
  assert.equal(model.metrics.acceptedCount, 0);
  assert.ok(model.activityGrid.every(bin => !bin.selected));
});

test('event type, selected component and public address are real intersecting filters', () => {
  const trace = live();
  assert.equal(buildInstrumentModel(trace, { componentId: 'resistor', eventType: 'filtered' }).events.length, 1);
  assert.equal(buildInstrumentModel(trace, { componentId: 'capacitor', eventType: 'filtered' }).events.length, 0);
  assert.equal(buildInstrumentModel(trace, { eventType: 'Transfer', address: 'E'.repeat(32) }).events.length, 2);
  assert.equal(buildInstrumentModel(trace, { address: 'Z'.repeat(32) }).events.length, 0);
  assert.equal(buildInstrumentModel(trace, { eventType: 'Buy' }).events.length, 0);
});

test('example origin remains explicit even when caller requests live', () => {
  const model = buildInstrumentModel(fixture(), { sourceMode: 'live', locallyObserved: true });
  assert.equal(model.source.mode, 'example');
  assert.ok(model.events.every(event => event.sourceMode === 'example' && event.signature === null));
});

test('live source claims in imports cannot create a live observation badge', () => {
  const trace = live();
  assert.equal(buildInstrumentModel(trace).source.mode, 'historical');
  assert.equal(buildInstrumentModel(trace, { locallyObserved: true }).source.mode, 'live');
  assert.equal(buildInstrumentModel(trace, { imported: true, locallyObserved: true, sourceMode: 'live' }).source.mode, 'historical');
  assert.equal(buildInstrumentModel(trace, { locallyObserved: true, context: 'replay' }).source.mode, 'historical');
  assert.equal(buildInstrumentModel(trace, { locallyObserved: true, sourceMode: 'historical' }).source.mode, 'historical');
});

test('invalid timestamp and out-of-window supplied inputs remain inspectable but never become waveform data', () => {
  const request = buildExample('single');
  const trace = finalizeWindow({ ...request, inputs: [request.inputs[0], null, { ...request.inputs[0], id: 'outside', timestamp: request.windowStart - 1 }] });
  const model = buildInstrumentModel(trace);
  assert.equal(model.events.length, 3);
  assert.equal(model.metrics.inputCount, 3);
  assert.equal(model.metrics.bucketedInputCount, 1);
  assert.equal(model.metrics.unbucketedInputCount, 2);
  assert.equal(model.activityGrid.reduce((sum, bin) => sum + bin.observedInputCount, 0), 1);
  assert.equal(model.events.find(event => event.input === null).timeUtc, null);
});

test('bucket count remains bounded for large windows and tiny requested intervals', () => {
  const request = buildExample('single');
  const trace = finalizeWindow({ ...request, rules: { ...request.rules, windowMs: 86_400_000 } });
  const model = buildInstrumentModel(trace, { bucketMs: 1 });
  assert.ok(model.activityGrid.length <= 240);
  assert.equal(model.activityGrid[0].start, trace.window.start);
  assert.equal(model.activityGrid.at(-1).end, trace.window.end);
});

test('inspector and topology use one range readout across rendering and route changes', async () => {
  const {resolveComponentReadout}=await import('../public/modules/instruments.js');
  const trace=finalizeWindow(buildExample('burst'));
  const options={rangeStart:trace.window.start+1000,rangeEnd:trace.window.start+2000,componentId:'capacitor',context:'replay'};
  for(let render=0;render<3;render++){
    const model=buildInstrumentModel(trace,options);
    const detail=resolveComponentReadout(trace,model,'capacitor');
    assert.equal(detail.inputCount,3);assert.equal(detail.outputCount,3);assert.equal(detail.scope,'selected Eastern range');
    const decision=resolveComponentReadout(trace,model,'comparator');
    assert.equal(decision.inputCount,trace.count);assert.equal(decision.scope,'whole window');
    assert.equal(trace.path,'SURGE');
  }
});
