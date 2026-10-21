import {formatEasternDateTime,formatEasternTime,formatEasternRange,displayTimeDescription} from '../public/modules/time.js';
import test from 'node:test';
import { BRAND_NAME } from '../public/config/site.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {COMPONENTS, buildExample, finalizeWindow, validateTrace, stableStringify} from '../public/modules/engine.js';
import {buildWorkbenchTrace} from '../public/modules/workbench.js';
import {buildInstrumentModel, resolveComponentReadout} from '../public/modules/instruments.js';
import {MEMORY_KEY, MEMORY_LIMITS, loadTraces, saveTrace, removeTrace, prepareTraceImport} from '../public/modules/memory.js';
import {ObservationStore} from '../public/modules/observation-store.js';

// Execute the shipped application functions, with only browser I/O replaced.
// Browser QA separately verifies event wiring, layout and actual focus behavior.
const app = fs.readFileSync(new URL('../public/modules/app.js', import.meta.url), 'utf8');
function shipped(name) {
 const start=app.indexOf(`function ${name}(`);
 assert.notEqual(start,-1,`Missing application function ${name}`);
 const lineEnd=app.indexOf('\n',start), first=app.slice(start,lineEnd);
 if(first.endsWith('}'))return first;
 const end=app.indexOf('\n}',lineEnd);
 assert.notEqual(end,-1,`Missing function boundary for ${name}`);
 return app.slice(start,end+2);
}
function fixture(trace=buildWorkbenchTrace(), functions=[]) {
 const nodes=new Map(),timers=new Map(),messages=[],renders=[];
 const storage=new Map();
 const localStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,String(value)),removeItem:key=>storage.delete(key)};
 const $=selector=>{
  if(!nodes.has(selector))nodes.set(selector,{textContent:'',value:'',hidden:false,disabled:false,attributes:{},style:{},classList:{toggle(){}},setAttribute(name,value){this.attributes[name]=String(value);},focus(){this.focused=true;},scrollIntoView(){this.scrolled=true;}});
  return nodes.get(selector);
 };
 const state={page:'home',context:'example',selected:'sensor',example:trace,activeTrace:null,observation:null,saved:[],detailId:null,selectedEvent:null,rangeStart:null,rangeEnd:null,rangeTraceId:null,importedIds:new Set(),observedIds:new Set(),filter:{time:'all',type:'all',address:''},playback:{step:-1,playing:false,speed:1,timer:null}};
 let now=trace?.window.end??Date.now();
 const context={BRAND_NAME,S:state,COMPONENTS,symbols:['↗','─▯─','││','≷','⌁','▤'],buildInstrumentModel,resolveComponentReadout,stableStringify,MEMORY_KEY,MEMORY_LIMITS,prepareTraceImport,PROVENANCE_KEY:'imported',TRUSTED_KEY:'observed',localStorage,
  loadTraces:()=>loadTraces(localStorage),removeTrace:id=>removeTrace(id,localStorage),$: $,$$:()=>[],Date:{now:()=>now},Number,Set,JSON,Blob,
  esc:value=>String(value??''),eastern:formatEasternDateTime,time:formatEasternTime,formatEasternRange,displayTimeDescription,short:value=>value,
  currentTrace:()=>state.context==='replay'?state.activeTrace:state.context==='live'?state.observation?.trace:state.example,
  renderer:{setReplayStep(step){renders.push(['renderer',step]);}},workbench:null,
  clearTimeout:id=>timers.delete(id),setTimeout:callback=>{const id=timers.size+1;timers.set(id,callback);return id;},
  renderUnified(){renders.push(['dashboard',buildInstrumentModel(context.currentTrace(),context.instrumentOptions?.()??{})]);},
  renderEvents(){},renderStage(){},renderInspector(){},renderMemory(){renders.push(['memory']);},renderPlayback(){},playPause(){},schedulePlayback(){},
  saveProvenance(){},notify:message=>messages.push(message),go:hash=>renders.push(['route',hash]),
  selectComponent:id=>{state.selected=id;},isPublicAddress:()=>true};
 vm.createContext(context);
 vm.runInContext(functions.map(shipped).join('\n'),context);
 return {context,state,$,nodes,timers,messages,renders,localStorage,setNow:value=>{now=value;}};
}
const playback=['playbackTrace','replayLimit','pausePlayback','renderPlayback','advance','schedulePlayback','resetPlayback'];

test('selecting an Eastern time cell immediately refreshes the inspector, not just the dashboard',()=>{
 const f=fixture(undefined,['instrumentOptions','liveTimeRange','stageStatus','renderInspector',...playback,'selectTimeRange']);
 f.context.selectTimeRange(f.state.example.window.start+1000,f.state.example.window.start+2000);
 assert.equal(f.$('#inspectorInput').textContent,3);
 assert.equal(f.$('#inspectorOutput').textContent,3);
 assert.equal(f.renders.findLast(r=>r[0]==='dashboard')[1].metrics.acceptedCount,3);
 assert.equal(f.state.rangeTraceId,f.state.example.id);
});

test('partial Memory cannot jump to a stage beyond its processed path',()=>{
 const trace=finalizeWindow({...buildExample('flow'),coverage:'partial'});
 assert.equal(validateTrace(trace).valid,true);
 const f=fixture(trace,[...playback,'jumpToMemoryStep']);
 Object.assign(f.state,{page:'memory',context:'replay',saved:[trace],detailId:trace.id,activeTrace:trace});
 for(const index of [3,4,5,NaN,-1]){f.context.jumpToMemoryStep(index);assert.equal(f.state.playback.step,-1);}
 f.context.jumpToMemoryStep(2);
 assert.equal(f.state.selected,'capacitor');
 assert.equal(f.$('#memoryProgress').textContent,'Step 3 / 3 · Capacitor · 6 outputs');
 f.state.playback.step=99;f.context.renderPlayback();
 assert.equal(f.state.playback.step,2);
 assert.doesNotMatch(f.$('#memoryProgress').textContent,/Step [45] \/ 3/);
});

test('deleting a playing Trace clears its pending timer and leaves replay context',()=>{
 const trace=buildWorkbenchTrace(),f=fixture(trace,[...playback,'removeSavedTrace']);
 saveTrace(trace,f.localStorage);
 Object.assign(f.state,{page:'memory',context:'replay',saved:[trace],detailId:trace.id,activeTrace:trace});
 f.state.playback.playing=true;f.state.playback.step=0;
 f.context.schedulePlayback();assert.equal(f.timers.size,1);
 f.context.removeSavedTrace(trace);
 assert.equal(f.timers.size,0);assert.equal(f.state.playback.playing,false);assert.equal(f.state.playback.timer,null);
 assert.equal(f.state.activeTrace,null);assert.equal(f.state.context,'example');
 assert.equal(loadTraces(f.localStorage).traces.length,0);
 assert.deepEqual(f.messages,['Local Trace removed.']);
});

test('Memory rereads another tab before display and observes storage changes',()=>{
 const trace=buildWorkbenchTrace(),f=fixture(trace,['readProvenance','syncSavedMemory','handleStorageChange']);
 assert.equal(f.state.saved.length,0);
 saveTrace(trace,f.localStorage);f.localStorage.setItem('imported',JSON.stringify([trace.id]));
 f.context.handleStorageChange({key:MEMORY_KEY,storageArea:f.localStorage});
 assert.equal(f.state.saved.length,1);assert.equal(f.state.importedIds.has(trace.id),true);
 removeTrace(trace.id,f.localStorage);
 f.context.handleStorageChange({key:MEMORY_KEY,storageArea:f.localStorage});
 assert.equal(f.state.saved.length,0);
 assert.equal(f.renders.filter(r=>r[0]==='memory').length,2);
});

test('a record removed by another tab stops the active replay and closes its detail',()=>{
 const trace=buildWorkbenchTrace(),f=fixture(trace,[...playback,'readProvenance','syncSavedMemory','handleStorageChange']);
 Object.assign(f.state,{page:'memory',context:'replay',saved:[trace],detailId:trace.id,activeTrace:trace});
 f.state.playback.playing=true;f.context.schedulePlayback();
 f.context.handleStorageChange({key:MEMORY_KEY,storageArea:f.localStorage});
 assert.equal(f.state.detailId,null);assert.equal(f.state.activeTrace,null);assert.equal(f.timers.size,0);
 assert.deepEqual(f.renders.find(r=>r[0]==='route'),['route','#memory']);
});

test('exporting Memory reads records saved by another tab instead of a stale cached list',async()=>{
 const trace=buildWorkbenchTrace(),f=fixture(trace,['readProvenance','syncSavedMemory','exportSavedMemory']);
 let exported;f.context.download=(blob,name)=>{exported={blob,name};};
 saveTrace(trace,f.localStorage);assert.equal(f.state.saved.length,0);
 f.context.exportSavedMemory();
 assert.equal(exported.name,'cirvyk-saved-traces.json');
 const value=JSON.parse(await exported.blob.text());
 assert.equal(value.traces.length,1);assert.equal(value.traces[0].id,trace.id);
});

test('Memory detail disables unprocessed buttons while final records retain all six',()=>{
 const partial=finalizeWindow({...buildExample('flow'),coverage:'partial'});
 const f=fixture(partial,['renderDetail']);f.context.traceLabel=()=> 'Example inputs';
 Object.assign(f.state,{page:'memory',saved:[partial],detailId:partial.id});
 f.context.renderDetail(partial.id);
 const partialHtml=f.$('#memoryDetail').innerHTML;
 assert.match(partialHtml,/<button data-memory-step="2">/);
 assert.match(partialHtml,/<button data-memory-step="3" disabled/);
 assert.match(partialHtml,/<button data-memory-step="5" disabled/);
 const final=buildWorkbenchTrace();f.state.saved=[final];f.state.detailId=final.id;
 f.context.renderDetail(final.id);
 assert.doesNotMatch(f.$('#memoryDetail').innerHTML,/data-memory-step="\d" disabled/);
});

test('skip navigation focuses the current main without changing the route',()=>{
 const f=fixture(undefined,['skipToContent']);let prevented=0;
 f.context.location={hash:'#source'};
 f.context.skipToContent({preventDefault(){prevented++;}});
 assert.equal(prevented,1);assert.equal(f.context.location.hash,'#source');
 assert.equal(f.$('#main').focused,true);assert.equal(f.$('#main').scrolled,true);
});

test('relative Live time filters are recalculated as the selected window advances',()=>{
 const example=buildExample('single');
 const first=finalizeWindow(example),second=finalizeWindow({...example,windowStart:example.windowStart+60000,now:example.now+60000,inputs:example.inputs.map(p=>({...p,timestamp:p.timestamp+60000})),baseline:[]});
 const f=fixture(first,['liveTimeRange','instrumentOptions']);
 Object.assign(f.state,{context:'live',observation:{config:{status:'configured'},trace:first}});f.state.filter.time='5';
 f.setNow(first.window.end);
 assert.equal(buildInstrumentModel(first,f.context.instrumentOptions()).events.length,1);
 f.state.observation.trace=second;f.setNow(second.window.end);
 const options=f.context.instrumentOptions();
 assert.equal(options.rangeStart,second.window.start);assert.equal(options.rangeEnd,second.window.end);
 assert.equal(buildInstrumentModel(second,options).events.length,1);
 f.state.filter.time='all';assert.equal(f.context.liveTimeRange(),null);
});

test('moving from a relative Live filter to full window removes its old bounds',()=>{
 const f=fixture(undefined,['applyEventFilters']);f.context.resetPlayback=()=>{};
 f.state.context='live';f.state.filter.time='5';f.state.rangeStart=1;f.state.rangeEnd=2;
 f.$('#eventTime').value='all';f.$('#eventType').value='all';f.$('#eventAddress').value='';
 f.context.applyEventFilters();assert.equal(f.state.rangeStart,null);assert.equal(f.state.rangeEnd,null);
});

test('a new Live window closes an old event and manual range instead of mixing Traces',()=>{
 const f=fixture(undefined,['syncLiveSelection']);f.context.resetPlayback=()=>{f.state.playback.playing=false;};
 Object.assign(f.state,{context:'live',observation:{trace:{id:'new-window'}},selectedEvent:{traceId:'old-window'},rangeTraceId:'old-window',rangeStart:1,rangeEnd:2});
 f.state.playback.playing=true;f.context.syncLiveSelection();
 assert.equal(f.state.selectedEvent,null);assert.equal(f.state.rangeStart,null);assert.equal(f.state.playback.playing,false);assert.equal(f.$('#eventDetail').hidden,true);
});

test('a real 429 ObservationStore response renders CHECK FAILED without inventing a path',async()=>{
 const scope={id:'test-scope',mint:'So11111111111111111111111111111111111111112',network:'mainnet-beta',observedAccounts:['11111111111111111111111111111111']};
 const store=new ObservationStore({fetcher:async url=>new Response(JSON.stringify(url==='/api/config'?{status:'configured',scope,pollingMs:15000}:{error:'Rate limited'}),{status:url==='/api/config'?200:429})});
 await store.refresh();assert.equal(store.state.status,'rate_limited');
 const f=fixture(undefined,['stageStatus']);f.state.context='live';f.state.observation=store.state;
 assert.equal(f.context.stageStatus(),'CHECK FAILED');assert.equal(store.state.trace.path,null);store.stop();
});

const memoryWindow = offset => {
 const request=buildExample('single'),shift=offset*request.rules.windowMs;
 return finalizeWindow({...request,baseline:[],windowStart:request.windowStart+shift,now:request.now+shift,inputs:request.inputs.map(input=>({...input,timestamp:input.timestamp+shift}))});
};
function mountMemoryImport(f){
 const start=app.indexOf("$('#importTrace').onchange=async e=>"),end=app.indexOf('\nasync function exportSnapshot',start);
 assert.ok(start>=0&&end>start);vm.runInContext(app.slice(start,end),f.context);
 return async traces=>{
  const text=JSON.stringify({schema:'circuit.memory.v1',traces}),target={files:[{size:new TextEncoder().encode(text).byteLength,text:async()=>text}],value:'memory.json'};
  await f.$('#importTrace').onchange({target});assert.equal(target.value,'');
 };
}

test('the actual Memory import handler merges both array orders once and prunes provenance to retained records',async()=>{
 const outcomes=[];
 for(const offsets of [[0,30],[30,0]]){
  const f=fixture(undefined,['readProvenance','syncSavedMemory']);
  for(let index=1;index<=29;index++)assert.equal(saveTrace(memoryWindow(index),f.localStorage).error,null);
  f.localStorage.setItem('observed',JSON.stringify(loadTraces(f.localStorage).traces.map(trace=>trace.id)));
  const writes=[],set=f.localStorage.setItem.bind(f.localStorage);f.localStorage.setItem=(key,value)=>{writes.push(key);set(key,value);};
  await mountMemoryImport(f)(offsets.map(memoryWindow));
  assert.equal(writes.filter(key=>key===MEMORY_KEY).length,1);
  const saved=loadTraces(f.localStorage).traces;assert.equal(saved.length,30);assert.equal(saved[0].id,memoryWindow(30).id);
  assert.deepEqual(JSON.parse(f.localStorage.getItem('imported')),[memoryWindow(30).id]);
  assert.equal(JSON.parse(f.localStorage.getItem('observed')).length,29);
  assert.ok(!f.state.importedIds.has(memoryWindow(0).id));
  assert.match(f.messages.at(-1),/1 \/ 2 validated Trace\(s\) retained/);
  outcomes.push({memory:f.localStorage.getItem(MEMORY_KEY),route:f.renders.findLast(value=>value[0]==='route')?.[1]});
 }
 assert.deepEqual(outcomes[0],outcomes[1]);
});

test('the actual Memory import handler performs no writes for invalid or duplicate records',async()=>{
 for(const requested of [[memoryWindow(2),{...memoryWindow(3),count:999}],[memoryWindow(2),memoryWindow(2)]]){
  const f=fixture(undefined,['readProvenance','syncSavedMemory']);saveTrace(memoryWindow(1),f.localStorage);
  const raw=f.localStorage.getItem(MEMORY_KEY),writes=[],set=f.localStorage.setItem.bind(f.localStorage);
  f.localStorage.setItem=(key,value)=>{writes.push(key);set(key,value);};
  await mountMemoryImport(f)(requested);
  assert.deepEqual(writes,[]);assert.equal(f.localStorage.getItem(MEMORY_KEY),raw);
  assert.match(f.messages.at(-1),/^Import rejected:/);
 }
});

test('reimported identities lose observed provenance and evicted records leave neither provenance list',async()=>{
 const f=fixture(undefined,['readProvenance','syncSavedMemory']);
 for(let index=1;index<=30;index++)saveTrace(memoryWindow(index),f.localStorage);
 f.localStorage.setItem('observed',JSON.stringify(loadTraces(f.localStorage).traces.map(trace=>trace.id)));
 const previous=memoryWindow(15),replacement=finalizeWindow({inputs:[...previous.inputs,{...previous.inputs[0],id:'imported-second',timestamp:previous.inputs[0].timestamp+10}],windowStart:previous.window.start,now:previous.observedAt,coverage:previous.coverage,parsingComplete:previous.parsingComplete,source:previous.source,rules:previous.rules});
 assert.equal(previous.id,replacement.id);
 await mountMemoryImport(f)([replacement,memoryWindow(31)]);
 const saved=loadTraces(f.localStorage).traces,imported=JSON.parse(f.localStorage.getItem('imported')),observed=JSON.parse(f.localStorage.getItem('observed'));
 assert.equal(saved.find(trace=>trace.id===replacement.id).count,2);
 assert.ok(imported.includes(replacement.id));assert.ok(!observed.includes(replacement.id));
 assert.ok(!saved.some(trace=>trace.id===memoryWindow(1).id));assert.ok(!imported.includes(memoryWindow(1).id));assert.ok(!observed.includes(memoryWindow(1).id));
 assert.equal(imported.length,2);assert.equal(observed.length,28);
});

test('failed import writes restore Memory and both provenance keys together',async()=>{
 for(const failureKey of ['imported','observed',MEMORY_KEY]){
  const f=fixture(undefined,['readProvenance','syncSavedMemory']),previous=memoryWindow(1);
  saveTrace(previous,f.localStorage);f.localStorage.setItem('imported','[]');f.localStorage.setItem('observed',JSON.stringify([previous.id]));
  const keys=[MEMORY_KEY,'imported','observed'],before=keys.map(key=>f.localStorage.getItem(key)),set=f.localStorage.setItem.bind(f.localStorage);
  let failed=false;f.localStorage.setItem=(key,value)=>{if(!failed&&key===failureKey){failed=true;throw new Error('QuotaExceededError');}set(key,value);};
  await mountMemoryImport(f)([memoryWindow(2)]);
  assert.ok(failed);assert.deepEqual(keys.map(key=>f.localStorage.getItem(key)),before);
  assert.equal(f.state.saved.length,1);assert.equal(f.state.saved[0].id,previous.id);
  assert.deepEqual([...f.state.importedIds],[]);assert.deepEqual([...f.state.observedIds],[previous.id]);
  assert.match(f.messages.at(-1),/Import rejected: QuotaExceededError/);
 }
});

test('a Core replay follows a replaced saved identity and resets stale event and range selections',()=>{
 const request=buildExample('single'),previous=finalizeWindow(request),updated=finalizeWindow({...request,inputs:[...request.inputs,{...request.inputs[0],id:'late-second',timestamp:request.inputs[0].timestamp+10}]});
 assert.equal(previous.id,updated.id);
 const f=fixture(previous,[...playback,'readProvenance','syncSavedMemory','handleStorageChange']);
 saveTrace(previous,f.localStorage);
 Object.assign(f.state,{page:'circuit',context:'replay',detailId:null,activeTrace:previous,saved:[previous],selectedEvent:{id:'stale',traceId:previous.id},rangeStart:previous.window.start+1000,rangeEnd:previous.window.start+2000,rangeTraceId:previous.id});
 f.state.playback.playing=true;f.state.playback.step=2;f.context.schedulePlayback();assert.equal(f.timers.size,1);
 saveTrace(updated,f.localStorage);let renderedCount;f.context.renderStage=()=>{renderedCount=buildInstrumentModel(f.context.currentTrace()).metrics.acceptedCount;};
 f.context.handleStorageChange({key:MEMORY_KEY,storageArea:f.localStorage});
 assert.equal(f.state.activeTrace.count,2);assert.equal(renderedCount,2);assert.equal(f.state.saved[0].count,2);
 assert.equal(f.timers.size,0);assert.equal(f.state.playback.playing,false);assert.equal(f.state.playback.step,-1);
 assert.equal(f.state.selectedEvent,null);assert.equal(f.state.rangeStart,null);assert.equal(f.state.rangeEnd,null);assert.equal(f.state.rangeTraceId,null);assert.equal(f.$('#eventDetail').hidden,true);
});

test('removing the active saved identity clears Core replay while preserving other records',()=>{
 const trace=memoryWindow(1),other=memoryWindow(2),f=fixture(trace,[...playback,'readProvenance','syncSavedMemory','handleStorageChange']);
 saveTrace(trace,f.localStorage);saveTrace(other,f.localStorage);
 Object.assign(f.state,{page:'circuit',context:'replay',detailId:null,activeTrace:trace,saved:[other,trace],selectedEvent:{id:'old-event'},rangeStart:1,rangeEnd:2,rangeTraceId:trace.id});
 f.state.playback.playing=true;f.context.schedulePlayback();removeTrace(trace.id,f.localStorage);
 f.context.handleStorageChange({key:MEMORY_KEY,storageArea:f.localStorage});
 assert.equal(f.state.activeTrace,null);assert.equal(f.state.context,'example');assert.equal(f.state.page,'circuit');
 assert.equal(f.timers.size,0);assert.equal(f.state.playback.playing,false);assert.equal(f.state.selectedEvent,null);assert.equal(f.state.rangeStart,null);
 assert.deepEqual(f.state.saved.map(value=>value.id),[other.id]);assert.equal(loadTraces(f.localStorage).traces[0].id,other.id);
});
