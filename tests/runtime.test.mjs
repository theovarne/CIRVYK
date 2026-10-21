import test from 'node:test';
import assert from 'node:assert/strict';
import {buildExample,finalizeWindow,stableStringify,COMPONENTS} from '../public/modules/engine.js';
import {buildInstrumentModel,resolveComponentReadout} from '../public/modules/instruments.js';
import {buildRuntimeModel} from '../public/modules/runtime.js';

const fixture=(kind='burst',changes={})=>finalizeWindow({...buildExample(kind),...changes});
const runtime=(trace,options={},instrumentOptions={})=>buildRuntimeModel(trace,buildInstrumentModel(trace,instrumentOptions),options);
const values=card=>card.series.map(entry=>entry.value??entry.observedValue??0);

test('Runtime reads the same six stages and exact engine readouts as Core',()=>{
 const trace=fixture(),model=buildInstrumentModel(trace),view=buildRuntimeModel(trace,model,{selected:'comparator'});
 assert.deepEqual(view.cards.map(card=>card.id),COMPONENTS.map(component=>component.id));
 assert.equal(view.processedStages,6);assert.equal(view.inputCount,12);assert.equal(view.path,'SURGE');
 for(const card of view.cards){const readout=resolveComponentReadout(trace,model,card.id);assert.equal(card.inputCount,readout.inputCount);assert.equal(card.outputCount,readout.outputCount);assert.equal(card.status,readout.status);assert.equal(card.detail,readout.detail);}
 assert.equal(view.card.id,'comparator');assert.equal(view.card.selected,true);
});

test('received, filtered and accumulated signals represent distinct derived measurements',()=>{
 const seed=buildExample('burst');seed.inputs.push({...seed.inputs[0]});const trace=finalizeWindow(seed),view=runtime(trace);
 const [sensor,resistor,capacitor]=view.cards;
 assert.equal(trace.inputs.length,13);assert.equal(trace.count,12);assert.equal(trace.filtered.length,1);
 assert.equal(values(sensor).reduce((sum,value)=>sum+value,0),13);
 assert.equal(values(resistor).reduce((sum,value)=>sum+value,0),1);
 assert.equal(values(capacitor).at(-1),12);
 for(let index=1;index<capacitor.series.length;index++)assert.ok(values(capacitor)[index]>=values(capacitor)[index-1]);
 assert.notDeepEqual(values(sensor),values(resistor));assert.notDeepEqual(values(sensor),values(capacitor));
 assert.equal(resistor.processCount,13);assert.equal(resistor.processUnit,'filter checks');
 assert.equal(resistor.signalLabel,'FILTERED / BUCKET');
});

test('whole-window decisions have a completion marker instead of fabricated per-input waveforms',()=>{
 const view=runtime(fixture());
 for(const card of view.cards.slice(3)){assert.equal(card.wholeWindow,true);assert.equal(card.processCount,1);assert.equal(card.decisionComplete,true);assert.equal(card.signalAvailable,false);assert.deepEqual(card.series,[]);assert.equal(card.signalUnit,'one decision / window');}
});

test('partial and accumulating windows leave decision stages pending',()=>{
 const seed=buildExample('single');
 for(const trace of [finalizeWindow({...seed,coverage:'partial'}),finalizeWindow({...seed,now:seed.windowStart+1500})]){
  const view=runtime(trace);assert.equal(view.processedStages,3);assert.equal(view.path,'PENDING');
  assert.match(view.coverage,/lower bounds/);
  for(const card of view.cards.slice(3)){assert.equal(card.processCount,0);assert.equal(card.decisionComplete,false);assert.equal(card.signalAvailable,false);assert.deepEqual(card.series,[]);}
  for(const card of view.cards.slice(0,3))assert.equal(card.incomplete,true);
 }
});

test('no selected Trace removes all prior activity, evidence and signals',()=>{
 const view=runtime(null);
 assert.equal(view.available,false);assert.equal(view.inputCount,null);assert.equal(view.processedStages,0);assert.equal(view.traceId,null);assert.equal(view.sourceLabel,'No selected Trace');
 assert.equal(view.range,'No selected window');assert.equal(view.coverage,'No activity implied');assert.deepEqual(view.events,[]);
 for(const card of view.cards){assert.equal(card.inputCount,null);assert.equal(card.outputCount,null);assert.equal(card.processCount,null);assert.equal(card.signalAvailable,false);assert.equal(card.decisionComplete,false);}
});

test('range selection changes bounded input counts while whole-window decisions and curves retain their scope',()=>{
 const trace=fixture(),model=buildInstrumentModel(trace,{rangeStart:trace.window.start+1100,rangeEnd:trace.window.start+1600,bucketMs:5000}),view=buildRuntimeModel(trace,model,{selected:'resistor'});
 assert.equal(view.inputCount,1);assert.equal(view.card.inputCount,1);assert.equal(view.card.outputCount,1);assert.equal(view.card.scope,'selected Eastern range');
 assert.match(view.selectedRange,/EDT/);assert.equal(view.selectionLabel,'COUNTS / SELECTED RANGE');
 for(const card of view.cards.slice(3)){assert.equal(card.inputCount,12);assert.equal(card.outputCount,12);assert.equal(card.scope,'whole window');assert.equal(card.processCount,1);}
 assert.equal(values(view.cards[0]).reduce((sum,value)=>sum+value,0),12);
 assert.equal(view.path,trace.path);assert.equal(view.cards[0].signalLabel,'RECEIVED / BUCKET');
});

test('example replay keeps its explicit source identity and never implies live observations',()=>{
 const trace=fixture('single');
 assert.equal(runtime(trace,{context:'example'}).sourceLabel,'Local example');
 const replay=runtime(trace,{context:'replay'});assert.equal(replay.sourceMode,'example');assert.equal(replay.sourceLabel,'Historical replay · example');assert.doesNotMatch(replay.sourceLabel,/live|online/i);
});

test('a declared live source is historical unless the shared model establishes current observation',()=>{
 const seed=buildExample('single'),trace=finalizeWindow({...seed,source:{...seed.source,mode:'live',network:'mainnet-beta',mint:'11111111111111111111111111111111',accounts:['11111111111111111111111111111111']}});
 assert.equal(runtime(trace).sourceMode,'historical');
 assert.equal(runtime(trace,{}, {locallyObserved:true,context:'live'}).sourceMode,'live');
 assert.equal(runtime(trace,{context:'replay'}, {locallyObserved:true,context:'replay'}).sourceMode,'historical');
 assert.equal(runtime(trace,{}, {locallyObserved:true,imported:true,context:'live'}).sourceMode,'historical');
});

test('event evidence is the most recent eight of the exact matching total',()=>{
 const trace=fixture(),view=runtime(trace,{selected:'sensor'});
 assert.equal(view.matchingEventCount,12);assert.equal(view.events.length,8);
 assert.equal(new Set(view.events.map(event=>event.id)).size,8);
 for(let index=1;index<view.events.length;index++)assert.ok(view.events[index-1].timestamp>=view.events[index].timestamp);
 assert.ok(view.events.every(event=>trace.inputs.some(input=>input.id===event.inputId)));
});

test('component selection respects rejected paths and shared address filters',()=>{
 const seed=buildExample('single');seed.inputs.push({...seed.inputs[0],id:'rejected-input',verified:false});const trace=finalizeWindow(seed);
 const filterModel=buildInstrumentModel(trace,{componentId:'resistor',eventType:'filtered'}),filter=buildRuntimeModel(trace,filterModel,{selected:'resistor'});
 assert.equal(filter.matchingEventCount,1);assert.equal(filter.events[0].accepted,false);
 const decision=buildRuntimeModel(trace,filterModel,{selected:'comparator'});assert.equal(decision.matchingEventCount,0);assert.deepEqual(decision.events,[]);
 const missing=runtime(trace,{selected:'sensor'},{address:'11111111111111111111111111111111'});assert.equal(missing.matchingEventCount,0);assert.deepEqual(missing.events,[]);
});

test('selection and playback highlights follow shared state without creating records or activity',()=>{
 const trace=fixture(),model=buildInstrumentModel(trace,{componentId:'switch'}),before=stableStringify({trace,model});
 const view=buildRuntimeModel(trace,model,{playback:{step:2,playing:true}});
 assert.equal(view.selected,'switch');assert.deepEqual(view.cards.filter(card=>card.replaying).map(card=>card.id),['capacitor']);assert.equal(view.playing,true);
 assert.equal(stableStringify({trace,model}),before);
 const stopped=buildRuntimeModel(trace,model,{selected:'not-a-component',playback:{step:-1,playing:false}});assert.equal(stopped.selected,'switch');assert.equal(stopped.cards.some(card=>card.replaying),false);
});

test('window labels use US Eastern and descriptions avoid misleading UTC display labels',()=>{
 const view=runtime(fixture('single'),{selected:'capacitor'});
 assert.match(view.range,/2026-10-15 20:05:00 EDT/);assert.doesNotMatch(view.range,/UTC|Z\b/);
 assert.match(view.card.detail,/processing window/);assert.doesNotMatch(view.card.detail,/UTC window/);
});
