import {COMPONENTS} from './engine.js';
import {BRAND_NAME} from '../config/site.js';
import {resolveComponentReadout} from './instruments.js';
import {formatEasternRange,formatEasternTime,displayTimeDescription} from './time.js';

const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const groups={all:COMPONENTS.map(component=>component.id),inputs:['sensor','resistor','capacitor'],decisions:['comparator','switch'],memory:['memory']};
const captions={sensor:'RECEIVED / BUCKET',resistor:'FILTERED / BUCKET',capacitor:'ACCUMULATED / WINDOW',comparator:'WHOLE-WINDOW EVALUATION',switch:'WHOLE-WINDOW PATH SELECTION',memory:'WHOLE-WINDOW TRACE PREPARATION'};
const actions=[['replay','Replay path'],['step','Step'],['reset','Reset'],['save','Save Trace']];
const callbacks={replay:'onReplay',step:'onStep',reset:'onReset',save:'onSave',core:'onInspectCore'};
const value=count=>Number.isFinite(count)?String(count):'—';

/** Presentation only: no independent poller, clock, random values or engine run. */
export function buildRuntimeModel(trace,model,options={}){
 const selected=COMPONENTS.some(component=>component.id===options.selected)?options.selected:model.selection.componentId||'sensor';
 const sourceLabel=options.context==='replay'&&trace?.source.mode==='example'?'Historical replay · example':model.source.label;
 const series=model.waveform.series;
 const received=series.find(item=>item.id==='input')?.values||[];
 const accepted=series.find(item=>item.id==='accepted')?.values||[];
 const observed=entry=>entry?.value??entry?.observedValue??0;
 let accumulated=0;
 const cumulative=accepted.map(entry=>({...entry,value:accumulated+=observed(entry)}));
 const filtered=received.map((entry,index)=>({...entry,value:Math.max(0,observed(entry)-observed(accepted[index]))}));
 const completed=trace?.status==='final';
 const cards=COMPONENTS.map((component,index)=>{
  const counts=resolveComponentReadout(trace,model,component.id);
  const metrics=model.components.find(item=>item.id===component.id);
  const decision=index>=3;
  const stageSeries=component.id==='sensor'?received:component.id==='resistor'?filtered:component.id==='capacitor'?cumulative:[];
  return {...component,...counts,selected:component.id===selected,replaying:options.playback?.step===index,
   processCount:metrics?.processCount??null,processUnit:metrics?.unit||'',
   relativeActivity:metrics?.relativeActivity??null,wholeWindow:decision,
   series:stageSeries,signalLabel:captions[component.id],signalUnit:decision?'one decision / window':component.id==='capacitor'?'Pulse, cumulative':'Pulse / bucket',
   signalAvailable:!decision&&model.available&&stageSeries.length>0,decisionComplete:decision&&completed,
   incomplete:model.available&&!model.coverage.complete};
 });
 const card=cards.find(item=>item.id===selected);
 const matchingEvents=model.events.filter(event=>event.completedPath?.includes(selected));
 const events=matchingEvents.slice().sort((a,b)=>(b.timestamp??0)-(a.timestamp??0)).slice(0,8);
 return {available:model.available,selected,sourceLabel,sourceMode:model.source.mode,scope:model.source.scopeId,
  range:trace?formatEasternRange(trace.window.start,trace.window.end,{offset:false}):'No selected window',
  selectionLabel:model.selection.rangeActive?'COUNTS / SELECTED RANGE':'COUNTS / FULL WINDOW',
  selectedRange:model.selection.rangeActive?formatEasternRange(model.range.start,model.range.end,{offset:false}):null,
  cards,card,events,matchingEventCount:matchingEvents.length,traceId:trace?.id||null,rules:trace?.rulesVersion||'—',
  path:trace?.path||'PENDING',status:trace?.status||'NO WINDOW',
  processedStages:trace?(completed?6:3):0,inputCount:model.metrics.inputCount,acceptedCount:model.metrics.acceptedCount,
  coverage:model.available?(model.coverage.complete?'Complete window':'Observed lower bounds · incomplete coverage'):'No activity implied',
  playing:options.playback?.playing===true,step:options.playback?.step??-1,
  explanation:model.available?'Each card represents one responsibility in the shared six-stage engine.':'Load an example, select a saved Trace, or configure an observation scope.'};
}

function signalPath(series){
 const max=Math.max(1,...series.map(item=>item.value??item.observedValue??0));
 const first=series[0]?.timestamp,last=series.at(-1)?.end,duration=last-first;
 if(!Number.isFinite(duration)||duration<=0)return '';
 return series.map(item=>`${4+(((item.timestamp+item.end)/2-first)/duration)*312},${35-(item.value??item.observedValue??0)/max*28}`).join(' ');
}
const setText=(node,text)=>{if(node.textContent!==String(text))node.textContent=String(text);};

export function mountRuntime(root,handlers={}){
 if(!root)throw new TypeError('A Runtime mount is required.');
 root.classList.add('runtime-cabinet');
 root.innerHTML=`<header class="runtime-heading"><div><span class="runtime-kicker">SYSTEM / COMPONENT RUNTIME</span><h1>${esc(BRAND_NAME)} Runtime</h1><p>Six responsibilities. One inspectable signal engine.</p></div><dl class="runtime-summary"><div><dt>SOURCE</dt><dd data-runtime-source>—</dd></div><div><dt>PROCESSED</dt><dd data-runtime-processed>0 / 6</dd></div><div><dt>INPUTS</dt><dd data-runtime-inputs>—</dd></div><div><dt>WINDOW PATH</dt><dd data-runtime-path>PENDING</dd></div></dl></header><div class="runtime-toolbar"><div class="runtime-filters" role="group" aria-label="Show processing stages">${[['all','All stages'],['inputs','Inputs'],['decisions','Decisions'],['memory','Memory']].map(([id,label])=>`<button type="button" data-runtime-filter="${id}" aria-pressed="${id==='all'}">${label}</button>`).join('')}</div><span data-runtime-range>No selected window</span></div><div class="runtime-layout"><div class="runtime-grid" aria-label="Six processing components">${COMPONENTS.map((component,index)=>`<button type="button" class="runtime-card" data-runtime-component="${component.id}" aria-pressed="false"><span class="runtime-card-top"><span>STAGE / ${String(index+1).padStart(2,'0')}</span><b data-card-status>NO WINDOW</b></span><span class="runtime-figure"><span class="runtime-figure-label">BOUNDED PROCESSING COMPONENT</span><svg viewBox="0 0 320 220" aria-hidden="true" focusable="false"><use href="/assets/runtime-components.svg#runtime-${component.id}"></use></svg><span class="runtime-stage-lamp" aria-hidden="true"></span></span><span class="runtime-card-info"><span class="runtime-part-type">${esc(component.label.split(' / ')[1])}</span><strong>${component.name}</strong><span class="runtime-responsibility">${esc(displayTimeDescription(component.responsibility))}</span><span class="runtime-card-counts"><span>IN <b data-card-input>—</b></span><span>OUT <b data-card-output>—</b></span><span data-card-process>—</span></span><span class="runtime-signal"><svg viewBox="0 0 320 40" aria-hidden="true" focusable="false"><path class="runtime-signal-axis" d="M4 35H316"></path><polyline data-card-curve points=""></polyline><path data-card-decision d="M310 9V35" hidden></path></svg><span data-card-signal>${captions[component.id]}</span><span data-card-signal-state>NO WINDOW</span></span><span class="runtime-card-foot"><span data-card-source>NO SELECTED TRACE</span><span data-card-scope>FULL WINDOW</span></span></span></button>`).join('')}</div><aside class="runtime-inspector" aria-label="Selected Runtime component"><div class="runtime-inspector-head"><span>SELECTED COMPONENT</span><b data-runtime-index>01 / 06</b></div><div class="runtime-inspector-body"><span class="runtime-kicker" data-runtime-provenance>NO SELECTED TRACE</span><h2 data-runtime-name>Sensor</h2><p data-runtime-responsibility></p><dl class="runtime-io"><div><dt>INPUT</dt><dd data-runtime-input>—</dd></div><div><dt>OUTPUT</dt><dd data-runtime-output>—</dd></div></dl><dl class="runtime-evidence"><div><dt>Component ID</dt><dd data-runtime-id>sensor</dd></div><div><dt>Source scope</dt><dd data-runtime-scope>—</dd></div><div><dt>Window / ET</dt><dd data-runtime-window>—</dd></div><div><dt>Readout scope</dt><dd data-runtime-selection>Whole window</dd></div><div><dt>Rules</dt><dd data-runtime-rules>—</dd></div><div><dt>Stage result</dt><dd data-runtime-status>NO WINDOW</dd></div></dl><p class="runtime-decision" data-runtime-detail></p><div class="runtime-controls">${actions.map(([action,label])=>`<button type="button" data-runtime-action="${action}">${label}</button>`).join('')}</div><p class="runtime-playback" role="status" aria-live="polite" data-runtime-playback>Load a Trace to replay its path.</p><button type="button" class="runtime-core-link" data-runtime-action="core">Inspect in Core <span>↗</span></button></div><section class="runtime-ledger"><div class="runtime-inspector-head"><span>RECENT INPUT EVIDENCE</span><b data-runtime-event-count title="Most recent 8 matching inputs, at most; shown / total matching">0 / 0</b></div><div data-runtime-events></div></section><footer class="runtime-boundary"><span data-runtime-coverage>No activity implied</span><p data-runtime-explanation></p><span>VISUAL MODEL / SHARED ENGINE</span></footer></aside></div>`;
 const query=selector=>root.querySelector(selector);
 const fields=Object.fromEntries([...root.querySelectorAll('[data-runtime-source],[data-runtime-processed],[data-runtime-inputs],[data-runtime-path],[data-runtime-range],[data-runtime-index],[data-runtime-provenance],[data-runtime-name],[data-runtime-responsibility],[data-runtime-input],[data-runtime-output],[data-runtime-id],[data-runtime-scope],[data-runtime-window],[data-runtime-selection],[data-runtime-rules],[data-runtime-status],[data-runtime-detail],[data-runtime-playback],[data-runtime-event-count],[data-runtime-coverage],[data-runtime-explanation]')].map(node=>[Object.keys(node.dataset).find(key=>key.startsWith('runtime')),node]));
 const cards=new Map([...root.querySelectorAll('[data-runtime-component]')].map(node=>[node.dataset.runtimeComponent,{node,status:node.querySelector('[data-card-status]'),input:node.querySelector('[data-card-input]'),output:node.querySelector('[data-card-output]'),process:node.querySelector('[data-card-process]'),curve:node.querySelector('[data-card-curve]'),decision:node.querySelector('[data-card-decision]'),signal:node.querySelector('[data-card-signal]'),signalState:node.querySelector('[data-card-signal-state]'),source:node.querySelector('[data-card-source]'),scope:node.querySelector('[data-card-scope]')}]));
 const eventRoot=query('[data-runtime-events]'),eventNodes=new Map(),filterButtons=[...root.querySelectorAll('[data-runtime-filter]')];
 let model=null,filter='all',destroyed=false;
 function setFilter(next){
  filter=Object.hasOwn(groups,next)?next:'all';
  filterButtons.forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.runtimeFilter===filter)));
  for(const [id,card] of cards)card.node.hidden=!groups[filter].includes(id);
  if(model&&!groups[filter].includes(model.selected))handlers.onSelect?.(groups[filter][0]);
 }
 function click(event){
  const component=event.target.closest('[data-runtime-component]');if(component){handlers.onSelect?.(component.dataset.runtimeComponent);return;}
  const choice=event.target.closest('[data-runtime-filter]');if(choice){setFilter(choice.dataset.runtimeFilter);return;}
  const action=event.target.closest('[data-runtime-action]');if(action){handlers[callbacks[action.dataset.runtimeAction]]?.();return;}
  const evidence=event.target.closest('[data-runtime-event]');if(evidence)handlers.onEvent?.(evidence.dataset.runtimeEvent);
 }
 function keydown(event){
  const component=event.target.closest('[data-runtime-component]');if(!component||!['ArrowRight','ArrowLeft','ArrowUp','ArrowDown','Home','End'].includes(event.key))return;
  event.preventDefault();const ids=groups[filter],index=ids.indexOf(component.dataset.runtimeComponent);
  const tracks=root.ownerDocument.defaultView?.getComputedStyle?.(query('.runtime-grid')).gridTemplateColumns?.trim().split(/\s+/).length||3;
  const columns=Math.max(1,Math.min(ids.length,tracks));
  const offset=event.key==='ArrowLeft'?-1:event.key==='ArrowUp'?-columns:event.key==='ArrowDown'?columns:1;
  const target=event.key==='Home'?0:event.key==='End'?ids.length-1:((index+offset)%ids.length+ids.length)%ids.length;
  cards.get(ids[target]).node.focus({preventScroll:true});
 }
 root.addEventListener('click',click);root.addEventListener('keydown',keydown);
 function renderEvents(events){
  const active=root.ownerDocument.activeElement,focusedId=eventRoot.contains(active)?active.dataset?.runtimeEvent:null;
  const ids=new Set(events.map(event=>event.id));
  for(const [id,node] of eventNodes)if(!ids.has(id)){node.remove();eventNodes.delete(id);}
  eventRoot.querySelector('.runtime-ledger-empty')?.remove();
  if(!events.length){const message=root.ownerDocument.createElement('p');message.className='runtime-ledger-empty';message.textContent=model.available?'No matching input for this component.':'No selected input window.';eventRoot.append(message);}
  events.forEach((event,index)=>{
   let node=eventNodes.get(event.id);
   if(!node){node=root.ownerDocument.createElement('button');node.type='button';node.className='runtime-event';node.dataset.runtimeEvent=event.id;node.append(root.ownerDocument.createElement('time'),root.ownerDocument.createElement('span'),root.ownerDocument.createElement('b'));eventNodes.set(event.id,node);}
   setText(node.children[0],formatEasternTime(event.timestamp));setText(node.children[1],event.inputId||event.kind||'Input');setText(node.children[2],event.accepted?'ACCEPTED':'FILTERED');
   node.title=`${event.kind} · ${event.accepted?'Accepted by the engine':displayTimeDescription(event.reason)} · ${model.sourceLabel}`;
   if(eventRoot.children[index]!==node)eventRoot.insertBefore(node,eventRoot.children[index]||null);
  });
  // Incoming evidence never takes focus from another panel; retained rows retain identity.
  if(focusedId&&!ids.has(focusedId)&&root.ownerDocument.activeElement===root.ownerDocument.body)query('[data-runtime-action="core"]').focus({preventScroll:true});
 }
 return {
  update(trace,instrumentModel,options={}){
   if(destroyed)return;
   model=buildRuntimeModel(trace,instrumentModel,options);const selected=model.card;
   // A component selected in Core or by a global reset must remain visible here.
   if(!groups[filter].includes(model.selected))setFilter('all');
   const texts={runtimeSource:model.sourceLabel,runtimeProcessed:`${model.processedStages} / 6`,runtimeInputs:value(model.inputCount),runtimePath:model.path,runtimeRange:model.range,runtimeIndex:`${String(COMPONENTS.findIndex(component=>component.id===model.selected)+1).padStart(2,'0')} / 06`,runtimeProvenance:model.sourceLabel.toUpperCase(),runtimeName:selected.name,runtimeResponsibility:displayTimeDescription(selected.responsibility),runtimeInput:value(selected.inputCount),runtimeOutput:value(selected.outputCount),runtimeId:selected.id,runtimeScope:model.scope||'—',runtimeWindow:model.range,runtimeSelection:selected.scope,runtimeRules:model.rules,runtimeStatus:selected.status,runtimeDetail:selected.detail||'Select an observed, saved or local example window to inspect this stage.',runtimePlayback:!model.available?'Load a Trace to replay its path.':model.step<0?`Ready · ${model.processedStages} processed stages`:`${model.playing?'Playing':'Paused'} · Step ${model.step+1} / ${model.processedStages}`,runtimeEventCount:`${model.events.length} / ${model.matchingEventCount}`,runtimeCoverage:model.coverage,runtimeExplanation:model.explanation};
   for(const [key,text] of Object.entries(texts))setText(fields[key],text);
   fields.runtimeRange.title=model.selectedRange?`Selected range: ${model.selectedRange}`:model.range;
   for(const card of model.cards){const view=cards.get(card.id);view.node.classList.toggle('is-selected',card.selected);view.node.classList.toggle('is-replaying',card.replaying);view.node.classList.toggle('is-running',card.replaying&&model.playing);view.node.setAttribute('aria-pressed',String(card.selected));view.node.setAttribute('aria-label',`${card.name}. ${card.inputCount??'Unknown'} inputs, ${card.outputCount??'unknown'} outputs. ${card.status}. ${model.sourceLabel}.`);setText(view.status,card.status.toUpperCase());setText(view.input,value(card.inputCount));setText(view.output,value(card.outputCount));setText(view.process,`${value(card.processCount)} ${card.processUnit}`);setText(view.source,model.sourceLabel.toUpperCase());setText(view.scope,card.wholeWindow?'WHOLE WINDOW':model.selectionLabel.replace('COUNTS / ',''));view.curve.setAttribute('points',card.signalAvailable?signalPath(card.series):'');view.curve.classList.toggle('is-incomplete',card.incomplete);view.decision.toggleAttribute('hidden',!card.decisionComplete);view.decision.setAttribute('visibility',card.decisionComplete?'visible':'hidden');setText(view.signal,card.signalLabel);setText(view.signalState,!model.available?'NO WINDOW':card.wholeWindow?(card.decisionComplete?'COMPLETE':'PENDING'):card.incomplete?'OBSERVED LOWER BOUND':'FULL WINDOW');}
   const replay=query('[data-runtime-action="replay"]');setText(replay,model.playing?'Pause path':'Replay path');for(const action of ['replay','step','reset','save'])query(`[data-runtime-action="${action}"]`).disabled=!model.available;
   renderEvents(model.events);return model;
  },
  destroy(){destroyed=true;root.removeEventListener('click',click);root.removeEventListener('keydown',keydown);eventNodes.clear();},
 };
}
