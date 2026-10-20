import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {DISPLAY_TIME_ZONE,formatEasternDateTime,formatEasternTime,formatEasternRange,easternZone,displayTimeDescription} from '../public/modules/time.js';
import {buildInstrumentModel,resolveComponentReadout} from '../public/modules/instruments.js';
import {buildWorkbenchTrace} from '../public/modules/workbench.js';
import {CircuitDashboard} from '../public/modules/dashboard.js';
import {mountSourceWorkspace} from '../public/modules/source-workspace.js';
import {sourceDocument} from './helpers/source-dom.mjs';
import {exportTrace,importTrace} from '../public/modules/memory.js';

test('Eastern winter and summer display use the correct date, abbreviation and offset',()=>{
  assert.equal(DISPLAY_TIME_ZONE,'America/New_York');
  assert.equal(formatEasternDateTime('2026-01-15T02:30:00.000Z',{offset:true}),'2026-01-14 21:30:00 EST (UTC-05:00)');
  assert.equal(formatEasternDateTime('2026-07-15T12:30:00.000Z',{offset:true}),'2026-07-15 08:30:00 EDT (UTC-04:00)');
  assert.equal(formatEasternDateTime('2026-07-04T04:00:00Z'),'2026-07-04 00:00:00 EDT');
  assert.equal(formatEasternTime('2026-07-15T08:30:00-04:00'),'08:30:00 EDT');
});

test('spring DST boundary skips the nonexistent local hour',()=>{
  assert.equal(formatEasternDateTime('2026-03-08T06:59:59Z'),'2026-03-08 01:59:59 EST');
  assert.equal(formatEasternDateTime('2026-03-08T07:00:00Z'),'2026-03-08 03:00:00 EDT');
  assert.equal(easternZone('2026-03-08T07:00:00Z',{offset:true}),'EDT (UTC-04:00)');
});

test('fall DST repeated hour remains distinguishable and ranges show both offsets',()=>{
  assert.equal(formatEasternDateTime('2026-11-01T05:30:00Z'),'2026-11-01 01:30:00 EDT');
  assert.equal(formatEasternDateTime('2026-11-01T06:30:00Z'),'2026-11-01 01:30:00 EST');
  assert.equal(formatEasternRange('2026-11-01T05:30:00Z','2026-11-01T06:30:00Z'),'2026-11-01 01:30:00 EDT (UTC-04:00) – 01:30:00 EST (UTC-05:00)');
});

test('ranges preserve both Eastern dates at midnight rather than mixing a UTC date with an Eastern clock',()=>{
  assert.equal(formatEasternRange('2026-07-15T03:59:59Z','2026-07-15T04:00:01Z'),'2026-07-14 23:59:59 EDT – 2026-07-15 00:00:01 EDT (UTC-04:00)');
  assert.equal(formatEasternRange('2026-01-15T12:00:00Z','2026-01-15T12:01:00Z',{offset:false}),'2026-01-15 07:00:00 EST – 07:01:00 EST');
});

test('invalid and missing instants never fall back to host-local time or epoch zero',()=>{
  for(const value of [null,undefined,''])assert.equal(formatEasternDateTime(value),'—');
  for(const value of [NaN,Infinity,8_640_000_000_000_001,'bad','2026-07-15 12:00:00','2026-07-15T12:00:00',{},false])assert.equal(formatEasternDateTime(value),'Invalid timestamp');
  assert.equal(formatEasternTime(0),'19:00:00 EST');
  assert.equal(formatEasternRange(null,'bad'),'— – Invalid timestamp');
});

test('formatting does not depend on the browser host timezone',()=>{
  const moduleUrl=new URL('../public/modules/time.js',import.meta.url).href;
  const script=`import {formatEasternDateTime} from ${JSON.stringify(moduleUrl)};process.stdout.write(formatEasternDateTime('2026-10-16T00:05:00Z'));`;
  const expected='2026-10-15 20:05:00 EDT';
  for(const timezone of ['Asia/Shanghai','UTC','Pacific/Honolulu'])assert.equal(execFileSync(process.execPath,['--input-type=module','-e',script],{env:{...process.env,TZ:timezone},encoding:'utf8'}),expected);
});

test('instrument presentation uses Eastern ranges while model epochs and Trace JSON remain unchanged',()=>{
  const trace=buildWorkbenchTrace(),before=JSON.stringify(trace);
  const model=buildInstrumentModel(trace,{rangeStart:trace.window.start+1000,rangeEnd:trace.window.start+2000,componentId:'capacitor'});
  assert.equal(model.waveform.axis,DISPLAY_TIME_ZONE);
  assert.match(model.source.rangeLabel,/2026-10-15 20:05:00 EDT/);
  assert.equal(model.window.start,trace.window.start);
  assert.equal(model.window.startUtc,'2026-10-16T00:05:00.000Z');
  assert.match(resolveComponentReadout(trace,model,'capacitor').detail,/Selected range 2026-10-15 20:05:01 EDT/);
  assert.equal(resolveComponentReadout(trace,model,'capacitor').scope,'selected Eastern range');
  assert.equal(JSON.stringify(trace),before);
  const values=new Map();
  const storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
  const imported=importTrace(exportTrace(trace),storage);
  assert.equal(imported.error,null);
  assert.deepEqual(imported.trace,trace);
  assert.match(displayTimeDescription('3 valid inputs in a 60-second UTC window.'),/60-second processing window/);
});

test('actual dashboard markup labels grid cells, axes and event evidence in Eastern time',()=>{
  const root={innerHTML:'',querySelectorAll:()=>[],addEventListener(){},removeEventListener(){}};
  const dashboard=new CircuitDashboard([root]);
  dashboard.update(buildWorkbenchTrace());
  assert.match(root.innerHTML,/VALID INPUTS \/ EASTERN GRID/);
  assert.match(root.innerHTML,/Filter 2026-10-15 20:05:00 EDT – 20:05:01 EDT \(UTC-04:00\)/);
  assert.match(root.innerHTML,/20:06:00 EDT/);
  assert.doesNotMatch(root.innerHTML,/UTC GRID|BUCKET · UTC|<span>UTC<\/span>|2026-10-16T/);
  dashboard.destroy();
});

test('Source generated build timestamp is rendered in Eastern while manifest ISO remains unchanged',async()=>{
  const document=sourceDocument(),root=document.createElement('div');
  const content='export const sample = 1;\n';
  const manifest={schema:'living-circuit.public-source.v1',generatedAt:'2026-10-16T00:05:00.000Z',stats:{files:1,lines:1,bytes:content.length},files:[{path:'public/modules/engine.js',language:'javascript',content,lines:1,bytes:content.length}]};
  const workspace=mountSourceWorkspace(root,{fetch:async()=>({ok:true,text:async()=>JSON.stringify(manifest)})});
  const loaded=await workspace.ready;
  assert.ok(loaded);
  assert.match(root.textContent,/Generated · US Eastern2026-10-15 20:05:00 EDT/);
  assert.equal(loaded.generatedAt,manifest.generatedAt);
  assert.match(root.querySelectorAll('dd').at(-1).title,/UTC-04:00/);
  workspace.destroy();
});
