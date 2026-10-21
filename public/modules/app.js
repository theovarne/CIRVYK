import {formatEasternDateTime,formatEasternTime,formatEasternRange,displayTimeDescription} from './time.js';
import {buildInstrumentModel,resolveComponentReadout} from './instruments.js';
import {CircuitDashboard} from './dashboard.js';
import {mountRuntime} from './runtime.js';
import {mountSourceWorkspace} from './source-workspace.js';
import {mountWorkbench,buildWorkbenchTrace} from './workbench.js';
import {BRAND_NAME,SITE,pageTitle} from '../config/site.js';
import {RULES, COMPONENTS, finalizeWindow, buildExample, validateTrace, stableStringify} from './engine.js';
import {loadTraces,saveTrace,removeTrace,exportTrace,prepareTraceImport,MEMORY_KEY,MEMORY_LIMITS} from './memory.js';
import {CircuitRenderer} from './renderer.js';
import {ObservationStore} from './observation-store.js';
import {createWalletController,isPublicAddress} from './wallet.js';
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const short=(v,n=7)=>v?`${v.slice(0,n)}…${v.slice(-5)}`:'—';
const eastern=formatEasternDateTime;
const time=formatEasternTime;
const symbols=['↗','─▯─','││','≷','⌁','▤'];
const stored=loadTraces();
const PROVENANCE_KEY='circuit.imported-traces.v1';
const TRUSTED_KEY='circuit.observed-traces.v1';
let observed=[];try{const value=JSON.parse(localStorage.getItem(TRUSTED_KEY)||'[]');if(Array.isArray(value))observed=value.filter(v=>typeof v==='string').slice(0,30);}catch{}
let imported=[];try{const value=JSON.parse(localStorage.getItem(PROVENANCE_KEY)||'[]');if(Array.isArray(value))imported=value.filter(v=>typeof v==='string').slice(0,30);}catch{}
const S={observedIds:new Set(observed),importedIds:new Set(imported),page:'home',view:'visual',context:'example',selected:'sensor',saved:stored.traces,observation:null,exampleKind:'single',example:buildWorkbenchTrace(),activeTrace:null,detailId:null,pendingReplay:false,rangeStart:null,rangeEnd:null,rangeTraceId:null,selectedEvent:null,filterAddress:'',playback:{step:-1,playing:false,speed:1,timer:null},filter:{time:'all',type:'all',address:''}};
let toastTimer=0, memoryTimer=0;
function notify(message){$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{$('#toast').hidden=true;},6000);}
function empty(title,note,action='Open Workbench',href='#workbench'){return `<div class="empty-state"><span class="empty-index">∅</span><div><strong>${esc(title)}</strong><p>${esc(note)}</p></div>${action?`<a class="button" href="${esc(href)}">${esc(action)} →</a>`:''}</div>`;}
const workspace=$('#sharedWorkspace');
const renderer=new CircuitRenderer($('#board'),{onSelect:id=>pinComponent(id),onViewChange:view=>{$('#zoomLevel').textContent=Math.round(view.zoom*100)+'%';},onError:()=>notify('Circuit asset failed to load. Refresh the page to retry.')});
let workbench=null,sourceWorkspace=null,runtime=null;
const dashboard=new CircuitDashboard([$('#homeInstruments'),$('#liveInstruments'),$('#circuitInstruments'),$('#memoryInstruments')],{onComponent:pinComponent,onRange:selectTimeRange,onEvent:inspectEvent,onResetRange:()=>clearFilters(false)});
function currentTrace(){return S.context==='example'?S.example:S.context==='replay'?S.activeTrace:S.observation?.config?.status==='configured'?S.observation.trace:null;}
function liveTimeRange(trace=currentTrace(),now=Date.now()){
 if(S.context!=='live'||!trace||!['5','60'].includes(String(S.filter.time)))return null;
 const start=Math.max(trace.window.start,Math.min(trace.window.end,now-Number(S.filter.time)*60000));
 return {start,end:trace.window.end};
}
function instrumentOptions(){const range=liveTimeRange();return {rangeStart:range?.start??S.rangeStart,rangeEnd:range?.end??S.rangeEnd,componentId:S.selected,context:S.context,imported:S.importedIds.has(currentTrace()?.id),locallyObserved:S.context==='live'&&S.observation?.config?.status==='configured',eventType:S.filter.type,address:S.filter.address};}
function selectTimeRange(start,end){
 resetPlayback(false);workbench?.pause();S.rangeStart=start;S.rangeEnd=end;S.rangeTraceId=currentTrace()?.id||null;S.selectedEvent=null;S.filter.time='all';$('#eventTime').value='all';$('#eventDetail').hidden=true;
 renderPlayback();renderUnified();renderEvents();notify('Eastern time range selected across grid, waveforms and input ledger.');
}
function stageStatus(){
 const status=S.observation?.status,trace=currentTrace();
 if(S.context==='live'&&['error','rate_limited','rate-limited'].includes(status))return 'CHECK FAILED';
 if(S.context==='live'&&['unconfigured','invalid_configuration'].includes(status))return 'NOT CONFIGURED';
 return trace?(trace.status==='final'?trace.path:trace.status.toUpperCase()):'AWAITING SOURCE';
}
function syncLiveSelection(){
 if(S.context!=='live')return;
 const trace=currentTrace(),changedEvent=S.selectedEvent&&S.selectedEvent.traceId!==trace?.id,changedRange=S.rangeTraceId&&S.rangeTraceId!==trace?.id;
 if(changedEvent||changedRange){resetPlayback(false);S.selectedEvent=null;S.rangeStart=null;S.rangeEnd=null;S.rangeTraceId=null;$('#eventDetail').hidden=true;}
}
function pinComponent(id){pausePlayback(false);workbench?.pause();selectComponent(id);}
function saveProvenance(){try{localStorage.setItem(PROVENANCE_KEY,JSON.stringify([...S.importedIds].filter(id=>S.saved.some(t=>t.id===id))));}catch{}}
function traceLabel(t){return t.source.mode==='example'?'Example inputs':S.observedIds.has(t.id)?'Live observation':'Historical replay · not rechecked';}
function selectComponent(id){if(!COMPONENTS.some(c=>c.id===id))return;S.selected=id;renderer.select(id);workbench?.setSelection(id);renderInspector();renderUnified();}
function renderInspector(){
 const index=COMPONENTS.findIndex(c=>c.id===S.selected), component=COMPONENTS[index],trace=currentTrace(),step=trace?.steps[index],readout=resolveComponentReadout(trace,buildInstrumentModel(trace,instrumentOptions()),S.selected);
 $('#componentNumber').textContent=`0${index+1} / 06`;$('#componentSymbol').textContent=symbols[index];$('#componentLabel').textContent=component.label;$('#componentName').textContent=component.name;$('#componentResponsibility').textContent=displayTimeDescription(component.responsibility);
 $('#inspectorInput').textContent=readout.inputCount??'—';$('#inspectorOutput').textContent=readout.outputCount??'—';$('#inspectorReason').textContent=displayTimeDescription(readout.detail||(S.observation?.status==='error'?'The source check failed. Previous records remain available; no new complete-window conclusion is made.':'No verified observation window is loaded. Explore the mechanism with explicit example inputs.'));
 $('#capacitorCount').textContent=trace?`${trace.count} valid / ${Math.round(trace.progress*trace.window.durationMs/1000)}s`:'No observed window';$('#capacitorFill').style.width=(trace?trace.progress*100:0)+'%';
 $('#baselineValue').textContent=trace?.baselineReady?`${trace.rules.baselineWindows} windows · avg ${Number(trace.baselineAverage.toFixed(2))}${trace.growthRatio==null?'':` · ${trace.growthRatio.toFixed(2)}×`}`:trace?`${trace.baselineEvidence.length} / ${trace.rules.baselineWindows} complete`:'Insufficient history';
 $('#stageMode').textContent=S.context==='example'?'EXAMPLE INPUTS':S.context==='replay'?(trace?.source.mode==='example'?'HISTORICAL REPLAY / EXAMPLE':!S.observedIds.has(trace?.id)?'HISTORICAL REPLAY / IMPORTED':'HISTORICAL REPLAY'):'LIVE OBSERVATION';
 const duration=(trace?.window.durationMs||RULES.windowMs)/1000;$('#windowLabel').textContent=`ET / ${duration}s WINDOWS`;const ticks=$$('.capacitor-ticks span');ticks.forEach((n,i)=>n.textContent=`${i*duration/2}s`);
 $('#stageStatus').textContent=stageStatus();
 $('#pathState').textContent=`PATH / ${trace?.path||'PENDING'}`;
 $$('[data-stage]').forEach(button=>{button.classList.toggle('active',button.dataset.stage===S.selected);button.classList.toggle('replaying',S.playback.step>=0&&COMPONENTS[S.playback.step]?.id===button.dataset.stage);button.setAttribute('aria-pressed',String(button.dataset.stage===S.selected));});
}
function renderStage(){renderer.setResult(currentTrace());renderInspector();renderUnified();}
$('#stageRoute').innerHTML=COMPONENTS.map((c,i)=>`<button data-stage="${c.id}" aria-pressed="${i===0}"><span>0${i+1}</span>${c.name}</button>`).join('');
$('#stageRoute').addEventListener('click',e=>{const b=e.target.closest('[data-stage]');if(b)pinComponent(b.dataset.stage);});
$('#zoomIn').onclick=()=>renderer.zoom(.15);$('#zoomOut').onclick=()=>renderer.zoom(-.15);$('#fitView').onclick=()=>{renderer.resetView();notify('Circuit view reset.');};
$('#componentMechanisms').innerHTML=COMPONENTS.map((c,i)=>`<article class="mechanism"><span class="part-number">0${i+1} / 06</span><div class="symbol" aria-hidden="true">${symbols[i]}</div><strong>${c.name}</strong><p>${esc(displayTimeDescription(c.responsibility))}</p></article>`).join('');
$('#protocolComponents').innerHTML=COMPONENTS.map(c=>`<div class="protocol-component"><strong>${c.name}</strong><p>${esc(displayTimeDescription(c.responsibility))}</p></div>`).join('');
$('#protocolVersion').textContent=RULES.version;
$$('[data-brand]').forEach(n=>n.textContent=SITE.brand.name);
function timeline(mount,trace,pulses=[]){
 const inputs=trace?.validInputs||pulses,start=trace?.window.start||Math.floor(Date.now()/RULES.windowMs)*RULES.windowMs,end=trace?.window.end||start+RULES.windowMs,binMs=(end-start)/60;
 const relevant=inputs.filter(p=>p.timestamp>=start&&p.timestamp<end);
 // Dense events share bins for painting only. The full input records stay intact.
 const bins=new Map();for(const p of relevant){const bin=Math.min(59,Math.floor((p.timestamp-start)/binMs));bins.set(bin,(bins.get(bin)||0)+1);}
 mount.innerHTML=(bins.size?[...bins].map(([x,count])=>`<i class="pulse-mark" style="--x:${3+x/60*94}%;--h:${Math.min(30,7+count*4)}px" title="${count} input${count===1?'':'s'} at ${esc(time(start+x*binMs))}"></i>`).join(''):`<span class="timeline-empty">${trace?'No valid inputs in this window.':S.observation?.status==='unconfigured'?'No target configured · no live activity implied':'No verified input window available'}</span>`)+`<span class="time-edge">${esc(time(start))}</span><span class="time-edge end">${esc(time(end))} / ${trace?relevant.length+' inputs':'no verified count'}</span>`;
}
function renderObservation(){
 const o=S.observation;if(!o)return;syncLiveSelection();
 $$('[data-last-checked]').forEach(n=>n.textContent=o.lastChecked?eastern(o.lastChecked):'Not checked');$$('[data-latest-event]').forEach(n=>n.textContent=o.latestEvent?eastern(o.latestEvent):'None observed');
 $$('[data-observation-mode]').forEach(n=>n.textContent=o.status==='unconfigured'?'Live observation · not configured':o.status==='live'?'Live observation · scoped':`Live observation · ${o.status}`);
 const scope=o.config?.scope;
 const note=o.status==='unconfigured'?'No target mint or observation accounts are configured. Workbench inputs and local replay remain fully available.':o.error?`${displayTimeDescription(o.error)} Previous inputs and their actual timestamps are retained. No failed check is treated as zero activity.`:`${scope?.description||'Only the configured accounts are observed.'} Coverage: ${o.coverage||'pending'}. ${o.pending?.count||0} unresolved transaction(s).`;
 $('#coverageNote').textContent=note;$('#visualScope').textContent=note;
 timeline($('#homeTimeline'),currentTrace());renderToken();if(S.context==='live')renderStage();else renderUnified();renderEvents();
}
function renderToken(){
 const scope=S.observation?.config?.scope, mint=scope?.mint||SITE.token.mint,network=scope?.network||SITE.token.network;
 const metadata=`<span>Name<b>${esc(SITE.token.name||'Not supplied')}</b></span><span>Ticker<b>${esc(SITE.token.ticker||'Not supplied')}</b></span><span>Network<b>${esc(network==='mainnet-beta'?'Solana mainnet':`Solana ${network}`)}</b></span><span>Mint address<code>${esc(mint||'Not configured')}</code></span>`;
 $('#heroMint').textContent=mint?short(mint,11):'No mint supplied';
 const publicMint=isPublicAddress(mint)?mint:null;$('#headerMint').textContent=publicMint?short(publicMint,4):'TBA';$('#headerCA').disabled=!publicMint;$('#headerCA').title=publicMint?`Copy contract address: ${publicMint}`:'Contract address has not been announced';
 $('#tokenScope').innerHTML=`<div><span class="eyebrow">TOKEN / OBSERVATION SCOPE</span><h3>${mint?'A defined token, a bounded view.':'Token scope stays explicit.'}</h3><p>${mint?'Only configured accounts are observed.':'The token name, ticker and target mint have not been supplied.'}</p></div><div class="token-metadata">${metadata}${mint?`<button class="text-button" data-copy-mint>Copy</button><a class="text-link" href="${esc(SITE.links.explorer)}/address/${encodeURIComponent(mint)}" target="_blank" rel="noopener noreferrer">Explorer ↗</a>${SITE.links.trade?`<a class="text-link" href="${esc(SITE.links.trade)}" target="_blank" rel="noopener noreferrer">Trade ↗</a>`:''}`:''}</div>`;
 $('#protocolScope').innerHTML=`<p><b>Network:</b> ${esc(network)}<br><b>Target mint:</b> ${esc(mint||'Not configured')}<br><b>Observed accounts:</b> ${scope?.observedAccounts?.length?scope.observedAccounts.map(esc).join(', '):'None configured'}<br><b>Source:</b> Solana JSON-RPC / finalized transactions</p>`;
}
function traceRows(traces){return traces.map(t=>`<div class="trace-row"><div><strong>${esc(eastern(t.window.start))}</strong><small>${esc(t.rulesVersion)} · ${esc(short(t.id,8))}</small></div><div class="trace-source"><strong>${esc(traceLabel(t))}</strong><small>${esc(t.source.label)}</small></div><span class="count">${t.count}<small>valid inputs</small></span><span class="path-badge ${t.path?.toLowerCase()||'pending'}">${esc(t.path||t.status.toUpperCase())}</span><a class="text-button trace-open" href="#memory/${encodeURIComponent(t.id)}">Open ↗</a></div>`).join('');}
function renderMemory(){
 $('#memoryList').innerHTML=S.saved.length?traceRows(S.saved):empty('No saved traces in this browser.','Save an explicit example, or import a validated Trace JSON file.');
 const recent=S.saved.slice(0,4);$('#recentTraces').innerHTML=recent.length?traceRows(recent):empty('No saved windows yet.','Save the selected example or import a validated record.');
 $('#memoryTimeline').innerHTML=S.saved.map(t=>`<a href="#memory/${encodeURIComponent(t.id)}" class="memory-tick"><span>${esc(eastern(t.window.start))}</span><b>${esc(t.path||t.status)}</b><small>${t.count} inputs / ${esc(traceLabel(t))}</small></a>`).join('');
 if(S.detailId)renderDetail(S.detailId);
}
function persist(trace,explicit=false){if(!syncSavedMemory())return false;const before=S.saved.find(t=>t.id===trace.id),result=saveTrace(trace);if(result.error){notify(result.error);return false;}S.saved=result.traces;if(!explicit&&trace.source.mode==='live'){S.importedIds.delete(trace.id);S.observedIds.add(trace.id);try{localStorage.setItem(TRUSTED_KEY,JSON.stringify([...S.observedIds].filter(id=>S.saved.some(t=>t.id===id))));}catch{S.observedIds.delete(trace.id);notify('Trace saved as historical data; local source provenance could not be retained.');}saveProvenance();}renderMemory();if(explicit)notify(`Trace saved in this browser.${result.evictedCount?` ${result.evictedCount} older record(s) removed by the storage limit.`:''}`);else if(!before){workspace.classList.add('trace-flash');setTimeout(()=>workspace.classList.remove('trace-flash'),650);notify('A reconciled live Trace was saved in this browser.');}return true;}
function applyRoute(){
 syncSavedMemory();
 let decoded;try{decoded=decodeURIComponent(location.hash.slice(1)||'home');}catch{decoded='home';history.replaceState(null,'','#home');}
 const raw=decoded.split('/'),legacy={treasury:'protocol',deploy:'workbench',spawn:'workbench',manual:'protocol',lineage:'circuit',mutations:'source'};
 if(raw[0]==='circuit'&&['events','workbench','visual'].includes(raw[1])){history.replaceState(null,'',`#${{events:'live',workbench:'workbench',visual:'circuit'}[raw[1]]}`);return applyRoute();}
 if(legacy[raw[0]]){history.replaceState(null,'',`#${legacy[raw[0]]}`);return applyRoute();}
 const enteringWorkbench=S.page!=='workbench';
 const page=['home','live','runtime','circuit','memory','source','workbench','protocol'].includes(raw[0])?raw[0]:'home';
 if(page!==raw[0])history.replaceState(null,'','#home');
 if(S.page!==page||(page==='memory'&&S.detailId!==(raw[1]||null))){pausePlayback(false);workbench?.pause();S.playback.step=-1;renderer.setReplayStep(null);}
 S.page=page;S.view='visual';document.title=pageTitle(page);
 S.detailId=page==='memory'&&raw[1]?raw[1]:null;
 if(S.detailId){const t=S.saved.find(t=>t.id===S.detailId);S.context='replay';S.activeTrace=t||null;S.selectedEvent=null;$('#eventDetail').hidden=true;S.rangeStart=null;S.rangeEnd=null;S.rangeTraceId=null;}
 if(page==='workbench'){S.context='example';S.example=workbench?.getTrace()||S.example;S.selectedEvent=null;$('#eventDetail').hidden=true;S.rangeStart=null;S.rangeEnd=null;S.rangeTraceId=null;if(enteringWorkbench)workbench?.resetPlayback();}
 const mount={home:'homeMount',circuit:'circuitMount',live:'liveMount',workbench:'workbenchMount',memory:S.detailId&&S.activeTrace?'memoryMount':null}[page];
 workspace.hidden=!mount;if(mount)$('#'+mount).append(workspace);
 renderer.setAsset(page==='circuit'?'backplane':'floorplan');
 $$('[data-page]').forEach(n=>n.hidden=n.dataset.page!==page);
 $$('[data-nav]').forEach(n=>{n.classList.toggle('active',n.dataset.nav===page);if(n.dataset.nav===page)n.setAttribute('aria-current','page');else n.removeAttribute('aria-current');});
 $('#memoryDetail').hidden=!S.detailId;$('#memoryInstruments').hidden=!(S.detailId&&S.activeTrace);if(S.detailId)renderDetail(S.detailId);
 renderStage();renderPlayback();renderEvents();
 if(page==='protocol'&&raw[1])requestAnimationFrame(()=>document.getElementById(`protocol-${raw[1]}`)?.scrollIntoView());else scrollTo({top:0,behavior:'instant'});
}

function go(hash){if(location.hash===hash)applyRoute();else location.hash=hash;}
addEventListener('hashchange',applyRoute);addEventListener('popstate',applyRoute);
function skipToContent(event){event.preventDefault();const main=$('#main');main.focus({preventScroll:true});main.scrollIntoView({block:'start',behavior:'instant'});}
$('.skip-link').addEventListener('click',skipToContent);
function chooseExample(kind,message=true){pausePlayback(false);S.exampleKind=kind;S.example=finalizeWindow(buildExample(kind));S.context='example';S.playback.step=-1;renderer.setReplayStep(null);$$('[data-scenario]').forEach(n=>n.classList.toggle('active',n.dataset.scenario===kind));timeline($('#exampleTimeline'),S.example);renderStage();renderPlayback();if(message)notify(`${{single:'Single pulse',burst:'Short burst',flow:'Gradual flow'}[kind]} loaded · Example inputs only.`);}
$$('[data-scenario]').forEach(n=>n.onclick=()=>chooseExample(n.dataset.scenario));
function playbackTrace(){return S.page==='memory'?S.saved.find(t=>t.id===S.detailId):currentTrace();}
function replayLimit(){const t=playbackTrace();return t?(S.selectedEvent?.completedPath?.length||(t.status==='final'?6:3)):0;}
function pausePlayback(feedback=true){if(S.page==='workbench')workbench?.pause();clearTimeout(S.playback.timer);S.playback.timer=null;const wasPlaying=S.playback.playing;S.playback.playing=false;renderPlayback();if(feedback&&wasPlaying)notify('Replay paused.');}
function advance(){if(S.page==='workbench'){workbench?.step();return;}const trace=playbackTrace();if(!trace){pausePlayback(false);notify('Load a Trace or an example first.');return;}if(S.playback.step>=replayLimit()-1){pausePlayback(false);return;}S.playback.step++;const id=COMPONENTS[S.playback.step].id;selectComponent(id);renderer.setReplayStep(S.playback.step);renderPlayback();if(S.playback.step>=replayLimit()-1){pausePlayback(false);notify('Replay complete · processed stages inspected.');}else if(S.playback.playing)schedulePlayback();}
function schedulePlayback(){clearTimeout(S.playback.timer);S.playback.timer=setTimeout(advance,800/S.playback.speed);}
function playPause(){if(S.page==='workbench'){if(workbench?.getPlaybackState().playing)workbench.pause();else workbench?.play();return;}if(S.playback.playing){pausePlayback();return;}if(!playbackTrace()){notify('Load a Trace or an example first.');return;}if(S.playback.step>=replayLimit()-1)S.playback.step=-1;S.playback.playing=true;advance();renderPlayback();}
function resetPlayback(message=true,fromWorkbench=false){if(S.page==='workbench'&&workbench&&!fromWorkbench){workbench.resetPlayback();if(message)notify('Local replay reset. Parameters were retained.');return;}pausePlayback(false);S.playback.step=-1;renderer.setReplayStep(null);renderPlayback();if(message)notify('Replay reset. Stored data was not changed.');}
function renderPlayback(){const limit=replayLimit();S.playback.step=Math.max(-1,Math.min(S.playback.step,limit-1));const step=S.playback.step,trace=playbackTrace(),label=!trace?'No Trace selected':step<0?`Ready · ${limit} processed stages`:`Step ${step+1} / ${limit} · ${COMPONENTS[step].name} · ${trace.steps[step].outputCount} outputs`;$('#routePlay').textContent=S.playback.playing?'Pause path':'Replay path';$('#routeProgress').textContent=label;$('#examplePlay').textContent=S.playback.playing?'Pause':step>=replayLimit()-1?'Replay':'Play';$('#exampleProgress').textContent=label;const play=$('#memoryPlay');if(play)play.textContent=S.playback.playing?'Pause':step>=replayLimit()-1?'Replay':'Play';const progress=$('#memoryProgress');if(progress)progress.textContent=label;$$('[data-memory-step]').forEach(b=>{const index=Number(b.dataset.memoryStep);b.disabled=index>=limit;b.classList.toggle('active',index===step);b.setAttribute('aria-pressed',String(index===step));});renderInspector();if(S.page==='runtime')renderUnified();}
$('#examplePlay').onclick=playPause;$('#exampleStep').onclick=()=>{pausePlayback(false);if(S.playback.step>=replayLimit()-1)S.playback.step=-1;advance();};$('#exampleReset').onclick=()=>resetPlayback();$('#exampleSpeed').onchange=e=>{S.playback.speed=Number(e.target.value);if(S.playback.playing)schedulePlayback();notify(`Replay speed set to ${S.playback.speed}×.`);};$('#saveExample').onclick=()=>{if(S.example)persist(S.example,true);};
function renderDetail(id){const t=S.saved.find(item=>item.id===id),root=$('#memoryDetail');root.hidden=false;if(!t){root.innerHTML=empty('This Trace is not saved here.','Records are local to the browser where they were saved. No public record link is implied.','Browse saved traces','#memory');return;}S.activeTrace=t;
 const validRows=new Map();for(const input of t.validInputs){const key=stableStringify(input);validRows.set(key,(validRows.get(key)||0)+1);}const rowIsValid=input=>{const key=stableStringify(input),n=validRows.get(key)||0;if(n)validRows.set(key,n-1);return n>0;};
 root.innerHTML=`<span class="eyebrow">${esc(traceLabel(t).toUpperCase())} / SAVED IN THIS BROWSER</span><h2>${esc(formatEasternRange(t.window.start,t.window.end))}</h2><div class="detail-grid"><div><span>VALID / FILTERED</span><b>${t.count} / ${t.filtered.length}</b></div><div><span>PATH / WINDOW STATE</span><b>${esc(t.path||t.status.toUpperCase())}</b></div><div><span>RULE VERSION</span><b>${esc(t.rulesVersion)}</b></div><div><span>OBSERVATION SCOPE</span><b>${esc(t.source.label)} · ${esc(t.source.scopeId)}</b></div></div><div class="trace-steps">${COMPONENTS.map((c,i)=>`<button data-memory-step="${i}"${i>=(t.status==='final'?6:3)?' disabled title="This stage has not been processed in the saved window."':''}>${String(i+1).padStart(2,'0')} / ${c.name}</button>`).join('')}</div><div class="replay-controls"><button class="button primary" id="memoryPlay">Play</button><button class="button" data-memory-action="step">Step</button><button class="text-button" data-memory-action="reset">Reset ↺</button><label>Speed<select id="memorySpeed"><option value="0.5">0.5×</option><option value="1">1×</option><option value="2">2×</option><option value="4">4×</option></select></label><span id="memoryProgress" role="status">Ready · 6 steps</span></div><h3>Evidence & baseline</h3>${!S.observedIds.has(t.id)&&t.source.mode==='live'?'<p class="scope-note">Imported historical data. Its declared on-chain evidence has not been rechecked against the live source. It does not enter live counts.</p>':''}<div class="trace-evidence">Source: ${esc(t.source.label)} / ${esc(t.source.network)}<br>Mint: ${esc(t.source.mint||'None — example inputs')}<br>Accounts: ${esc(t.source.accounts.join(', ')||'None — example inputs')}<br>Coverage: ${esc(t.coverage)} · Parsing: ${t.parsingComplete?'complete':'unresolved'}<br>Baseline: ${esc(t.baselineReason)}${t.baselineReady?`<br>Five counts: ${t.baselineEvidence.map(b=>b.count).join(' / ')} · average ${t.baselineAverage}`:''}<br>Growth ratio: ${t.growthRatio==null?'Not available':t.growthRatio.toFixed(2)+'×'}<br>Recorded window is ${t.status==='final'?'final':'not final'}.</div>${t.filtered.length?`<h3>Filtering decisions</h3><div class="table-scroll"><table><thead><tr><th>Input</th><th>Reason</th></tr></thead><tbody>${t.filtered.map(f=>`<tr><td>${esc(short(f.input?.signature||f.input?.id||'Malformed',10))}</td><td>${esc(displayTimeDescription(f.reason))}</td></tr>`).join('')}</tbody></table></div>`:''}<h3>Window inputs (${t.inputs.length})</h3><div class="table-scroll"><table><thead><tr><th>US Eastern</th><th>Type</th><th>Input / evidence</th><th>Status</th></tr></thead><tbody>${t.inputs.length?t.inputs.map(p=>`<tr><td title="${esc(eastern(p?.timestamp,{offset:true}))}">${esc(time(p?.timestamp))}</td><td>${esc(p?.kind||'Unsupported')}</td><td>${p?.signature&&S.observedIds.has(t.id)?`<a href="https://explorer.solana.com/tx/${encodeURIComponent(p.signature)}${t.source.network==='mainnet-beta'?'':`?cluster=${encodeURIComponent(t.source.network)}`}" target="_blank" rel="noopener noreferrer">${esc(short(p.signature,10))} ↗</a>`:esc(p?.signature?short(p.signature,10)+' / imported evidence':p?.id||'Malformed input')}</td><td>${rowIsValid(p)?'Valid':'Filtered'}</td></tr>`).join(''):'<tr><td class="empty" colspan="4">No inputs in this reconciled window.</td></tr>'}</tbody></table></div><div class="detail-actions"><button class="button" data-memory-action="replay">Replay in Core ↗</button><button class="button" data-memory-action="json">Export Trace JSON ↓</button><button class="button" data-memory-action="snapshot">Export Snapshot ↓</button><button class="text-button" data-memory-action="remove">Remove local record</button></div>`;
 $('#memoryPlay').onclick=playPause;$('#memorySpeed').value=String(S.playback.speed);$('#memorySpeed').onchange=e=>{S.playback.speed=Number(e.target.value);if(S.playback.playing)schedulePlayback();notify(`Replay speed set to ${S.playback.speed}×.`);};renderPlayback();
}
$('#memoryDetail').addEventListener('click',async e=>{const step=e.target.closest('[data-memory-step]');if(step){jumpToMemoryStep(Number(step.dataset.memoryStep));return;}const action=e.target.closest('[data-memory-action]')?.dataset.memoryAction,t=S.saved.find(item=>item.id===S.detailId);if(!action||!t)return;
 if(action==='step'){pausePlayback(false);if(S.playback.step>=replayLimit()-1)S.playback.step=-1;advance();}
 if(action==='reset')resetPlayback();
 if(action==='replay'){resetPlayback(false);S.context='replay';S.activeTrace=t;S.selectedEvent=null;$('#eventDetail').hidden=true;S.rangeStart=null;S.rangeEnd=null;S.pendingReplay=true;go('#circuit');setTimeout(playPause,0);}
 if(action==='json'){try{download(new Blob([exportTrace(t)],{type:'application/json'}),`${BRAND_NAME.toLowerCase()}-trace-${t.id}.json`);notify('Trace JSON download started.');}catch(error){notify(error.message);}}
 if(action==='snapshot')await exportSnapshot(t);
 if(action==='remove')removeSavedTrace(t);
});
function jumpToMemoryStep(index){
 if(!Number.isInteger(index)||index<0||index>=replayLimit())return;
 pausePlayback(false);S.playback.step=index-1;advance();
}
function removeSavedTrace(trace){
 resetPlayback(false);const result=removeTrace(trace.id);if(result.error){notify(result.error);return;}
 S.saved=result.traces;S.importedIds.delete(trace.id);S.observedIds.delete(trace.id);saveProvenance();try{localStorage.setItem(TRUSTED_KEY,JSON.stringify([...S.observedIds]));}catch{}
 S.detailId=null;S.activeTrace=null;S.context=S.observation?.config?.status==='configured'?'live':'example';S.selectedEvent=null;S.rangeStart=null;S.rangeEnd=null;S.rangeTraceId=null;$('#eventDetail').hidden=true;$('#memoryDetail').hidden=true;go('#memory');renderMemory();notify('Local Trace removed.');
}
function readProvenance(key){
 try{const value=JSON.parse(localStorage.getItem(key)||'[]');return new Set(Array.isArray(value)?value.filter(id=>typeof id==='string'&&S.saved.some(t=>t.id===id)):[]);}catch{return new Set();}
}
function syncSavedMemory(refreshView=false){
 const latest=loadTraces();if(latest.error){notify(latest.error);return false;}
 const previous=S.activeTrace;S.saved=latest.traces;S.importedIds=readProvenance(PROVENANCE_KEY);S.observedIds=readProvenance(TRUSTED_KEY);
 const selectedId=S.detailId||(S.context==='replay'?previous?.id:null),selected=selectedId?S.saved.find(t=>t.id===selectedId):null,removed=!!selectedId&&!selected;
 if(removed){resetPlayback(false);S.detailId=null;S.activeTrace=null;S.context=S.observation?.config?.status==='configured'?'live':'example';S.selectedEvent=null;S.rangeStart=null;S.rangeEnd=null;S.rangeTraceId=null;$('#eventDetail').hidden=true;$('#memoryDetail').hidden=true;}
 else if(selected&&S.context==='replay'){S.activeTrace=selected;if(previous&&stableStringify(previous)!==stableStringify(selected)){S.selectedEvent=null;S.rangeStart=null;S.rangeEnd=null;S.rangeTraceId=null;$('#eventDetail').hidden=true;resetPlayback(false);}}
 if(refreshView){renderMemory();if(removed&&S.page==='memory')go('#memory');else{renderStage();renderPlayback();renderEvents();}}
 return true;
}
function handleStorageChange(event){if(event.storageArea&&event.storageArea!==localStorage)return;if(event.key===null||[MEMORY_KEY,PROVENANCE_KEY,TRUSTED_KEY].includes(event.key))syncSavedMemory(true);}
addEventListener('storage',handleStorageChange);
function download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),2000);}
function exportSavedMemory(){if(!syncSavedMemory(true))return;if(!S.saved.length){notify('No saved traces to export.');return;}download(new Blob([JSON.stringify({schema:'circuit.memory.v1',traces:S.saved})],{type:'application/json'}),`${BRAND_NAME.toLowerCase()}-saved-traces.json`);notify(`${S.saved.length} saved Trace(s) exported as JSON.`);}
$('#exportAll').onclick=exportSavedMemory;
$('#importTrace').onchange=async e=>{const file=e.target.files?.[0];if(!file)return;try{if(file.size>MEMORY_LIMITS.maxBytes)throw new Error('Import exceeds the 3 MB limit.');const text=await file.text(),parsed=JSON.parse(text);let traces;if(parsed?.schema==='circuit.memory.v1'){if(Object.keys(parsed).sort().join(',')!=='schema,traces'||!Array.isArray(parsed.traces)||parsed.traces.length>30)throw new Error('Invalid saved-traces file.');traces=parsed.traces;}else traces=[parsed];if(!traces.length)throw new Error('This file contains no traces.');
 if(!syncSavedMemory())throw new Error('Refresh local memory before importing.');const plan=prepareTraceImport(traces,S.saved),retained=new Set(plan.traces.map(t=>t.id)),incoming=new Set(traces.map(t=>t.id));
 const old=localStorage.getItem(MEMORY_KEY),oldImported=localStorage.getItem(PROVENANCE_KEY),oldObserved=localStorage.getItem(TRUSTED_KEY),nextImported=new Set([...S.importedIds,...incoming].filter(id=>retained.has(id))),nextObserved=new Set([...S.observedIds].filter(id=>retained.has(id)&&!incoming.has(id)));
 try{localStorage.setItem(PROVENANCE_KEY,JSON.stringify([...nextImported]));localStorage.setItem(TRUSTED_KEY,JSON.stringify([...nextObserved]));localStorage.setItem(MEMORY_KEY,plan.serialized);}catch(error){let rollbackFailed=false;for(const [key,value] of [[MEMORY_KEY,old],[PROVENANCE_KEY,oldImported],[TRUSTED_KEY,oldObserved]]){try{if(value===null)localStorage.removeItem(key);else localStorage.setItem(key,value);}catch{rollbackFailed=true;}}if(rollbackFailed){syncSavedMemory(true);throw new Error(`${error.message} Previous storage could not be fully restored. Reopen Memory before continuing.`);}throw error;}
 S.saved=plan.traces;S.importedIds=nextImported;S.observedIds=nextObserved;renderMemory();notify(`${plan.retainedIds.length} / ${traces.length} validated Trace(s) retained in this browser.${plan.notRetainedIds.length?` ${plan.notRetainedIds.length} older imported record(s) not retained by the storage limits.`:''}${plan.evictedIds.length?` ${plan.evictedIds.length} previous record(s) removed by the storage limits.`:''}`);go(plan.retainedIds.length?`#memory/${encodeURIComponent(plan.retainedIds[0])}`:'#memory');
 }catch(error){notify(`Import rejected: ${error.message}`);}finally{e.target.value='';}};
async function exportSnapshot(t){try{notify('Preparing Snapshot…');await renderer.ready;if(renderer.error)throw new Error('Circuit graphic is unavailable.');renderer.setResult(t);const svg=renderer.snapshotSvg(),image=new Image();const uri=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml'}));try{await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(new Error('Circuit image could not be rendered.'));image.src=uri;});const canvas=document.createElement('canvas');canvas.width=1600;canvas.height=1120;const c=canvas.getContext('2d');c.fillStyle='#020504';c.fillRect(0,0,1600,1120);c.fillStyle='#dce5e0';c.font='38px sans-serif';c.fillText(BRAND_NAME,55,70);c.font='16px monospace';c.fillStyle='#83948d';c.fillText(`${traceLabel(t).toUpperCase()} / SAVED TRACE SNAPSHOT`,55,108);c.fillStyle='#000000';c.fillRect(55,140,1490,720);const scale=Math.min(1490/image.naturalWidth,720/image.naturalHeight),w=image.naturalWidth*scale,h=image.naturalHeight*scale;c.drawImage(image,55+(1490-w)/2,140+(720-h)/2,w,h);c.fillStyle='#dce5e0';c.font='22px monospace';c.fillText(formatEasternRange(t.window.start,t.window.end,{offset:false}),55,910);c.font='18px monospace';c.fillText(`${t.count} valid inputs / ${t.filtered.length} filtered / ${t.path||t.status.toUpperCase()}`,55,957);c.fillText(`Rules: ${t.rulesVersion} / Source: ${t.source.label.slice(0,65)}`,55,997);c.font='15px monospace';c.fillStyle='#83948d';c.fillText(`Scope: ${t.source.scopeId} / ${t.source.network}`,55,1038);c.fillText('Browser-local record. Deterministic display rules. No public record link is implied.',55,1077);const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(!blob)throw new Error('The browser could not export this image.');download(blob,`${BRAND_NAME.toLowerCase()}-snapshot-${t.id}.png`);notify('Snapshot PNG download started.');}finally{URL.revokeObjectURL(uri);renderStage();}}catch(error){notify(`Snapshot failed: ${error.message}`);}}
function renderEvents(){
 const m=dashboard.model,events=m.events.filter(p=>S.filter.time==='all'||m.source.mode!=='live'||p.timestamp>=Date.now()-Number(S.filter.time)*60000).sort((a,b)=>(b.timestamp||0)-(a.timestamp||0));
 $('#eventFilterStatus').textContent=`${events.length} matching / ${m.allEvents.length} window inputs · ${m.source.label} · ${m.selection.rangeActive?'selected Eastern subrange':'whole window'}.`;
 $('#eventsBody').innerHTML=events.length?events.slice(0,200).map(p=>`<tr><td title="${esc(eastern(p.timestamp,{offset:true}))}">${esc(time(p.timestamp))}</td><td>${esc(p.kind)}</td><td><code>${esc(p.signature?short(p.signature,9):p.inputId||'Malformed input')}</code><small class="event-source">${esc(m.source.label)}</small></td><td>${p.slot??'—'}</td><td>${p.accepted?'Accepted':'Filtered'} / ${esc(m.result.path||'Pending')}</td><td><button class="text-button" data-model-event="${esc(p.id)}">Inspect & replay →</button></td></tr>`).join(''):`<tr><td class="empty" colspan="6">${m.available?'No input matches this selection. Clear filters to inspect the complete window.':'No observed window is available. Load an explicit example or select a saved Trace.'}</td></tr>`;
}
function applyEventFilters(){
 const address=$('#eventAddress').value.trim();if(address&&!isPublicAddress(address)){notify('Enter a valid Solana public address.');return;}
 const previousTime=S.filter.time;S.filter={time:$('#eventTime').value,type:$('#eventType').value,address};
 if(previousTime!==S.filter.time||S.filter.time!=='all'){S.rangeStart=null;S.rangeEnd=null;S.rangeTraceId=null;}
 S.selectedEvent=null;$('#eventDetail').hidden=true;resetPlayback(false);renderUnified();renderEvents();notify('Window filters applied.');
}
$('#applyEventFilter').onclick=applyEventFilters;
$('#clearEventFilter').onclick=()=>clearFilters();
$('#eventsBody').onclick=e=>{const id=e.target.closest('[data-model-event]')?.dataset.modelEvent;const value=dashboard.model.allEvents.find(e=>e.id===id);if(value)inspectEvent(value);};

let walletBusy = false, walletUIReady = false, walletAction = 0;
const walletLogo = brand => ({okx:'okx.png',phantom:'phantom.svg',backpack:'backpack.png',coinbase:'coinbase.svg',solflare:'solflare.svg'}[brand]);
function invalidateFilteredInspection(){
 resetPlayback(false);workbench?.pause();S.selectedEvent=null;$('#eventDetail').hidden=true;
}
function syncWalletLabel(){
 $('#walletLabel').textContent=wallet.address?short(wallet.address,4):S.filterAddress?'Address filter':'Connect wallet';
 $('#walletOpen').classList.toggle('connected',Boolean(wallet.address));
 $('#walletConnection').hidden=!wallet.address&&!S.filterAddress;
 $('#walletConnectedAddress').textContent=wallet.address||S.filterAddress;
 $('#walletDisconnect').hidden=!wallet.address&&!S.filterAddress;
 $('#walletDisconnect').textContent=wallet.address?'Disconnect':'Clear filter';
}
const wallet=createWalletController({
 onChange:address=>{
  S.filterAddress=address||'';$('#walletAddress').value=address||'';$('#eventAddress').value=address||'';S.filter.address=address||'';
  invalidateFilteredInspection();
  syncWalletLabel();renderUnified();renderEvents();renderWallets();
 },
 onMessage:message=>{$('#walletStatus').textContent=message;},
 onProvidersChange:()=>{if(walletUIReady)renderWallets();},
});
walletUIReady=true;
function renderWallets(){
 const options=wallet.catalog();
 $('#walletOptions').innerHTML=options.map(w=>{
  const logo=walletLogo(w.brandId);
  const image=logo?`<img src="/assets/wallets/${logo}" alt="" width="42" height="42">`:'<span class="wallet-generic" aria-hidden="true">◈</span>';
  return `<button class="wallet-card${w.installed?'':' unavailable'}" data-wallet="${esc(w.id)}" ${!w.installed||walletBusy?'disabled':''} aria-label="${esc(w.name)}: ${w.installed?'Connect public address':'Not detected in this browser'}">${image}<strong>${esc(w.name)}</strong><small>${w.installed?(w.kind==='standard'?'Wallet Standard · Solana':'Solana extension'):'Not detected in this browser'}</small><span>${w.installed?(walletBusy?'Connecting…':'Connect'):'Unavailable'}</span></button>`;
 }).join('');syncWalletLabel();
}
$('#walletOpen').onclick=()=>{wallet.refresh();renderWallets();$('#walletStatus').textContent=wallet.address?'Connected for public address access. No signature or transaction is requested.':wallet.catalog().some(w=>w.installed)?'Choose an installed wallet to continue.':'No Solana wallet is detected. You can use a public address filter below.';$('#walletDialog').showModal();};
$('#walletClose').onclick=()=>$('#walletDialog').close();
$('#walletDialog').addEventListener('close',()=>{walletAction++;wallet.cancelPending();walletBusy=false;renderWallets();});
$('#walletOptions').onclick=async e=>{
 const button=e.target.closest('[data-wallet]');if(!button||button.disabled||walletBusy)return;
 const action=++walletAction;walletBusy=true;$('#walletStatus').textContent='Waiting for your wallet connection approval…';renderWallets();
 try{await wallet.connect(button.dataset.wallet);}finally{if(action===walletAction){walletBusy=false;renderWallets();}}
};
$('#walletDisconnect').onclick=()=>{walletAction++;walletBusy=false;void wallet.disconnect();};
$('#useWalletAddress').onclick=()=>{
 const address=$('#walletAddress').value.trim();if(!isPublicAddress(address)){$('#walletStatus').textContent='Enter a valid 32-byte Solana public address.';return;}
 walletAction++;walletBusy=false;if(wallet.address)void wallet.disconnect({silent:true});else wallet.cancelPending();
 S.filter.address=address;S.filterAddress=address;$('#walletAddress').value=address;$('#eventAddress').value=address;invalidateFilteredInspection();syncWalletLabel();
 $('#walletDialog').close();go('#live');renderUnified();renderEvents();notify('Public address filter applied to observed records only.');
};
for(const [id,name] of [['projectX','X'],['projectGithub','GitHub']]){const link=SITE.links.social.find(link=>link.name===name);if(link)$('#'+id).href=link.url;}
const observer=new ObservationStore({onChange:state=>{S.observation=state;renderObservation();},onTrace:trace=>{if(!persist(trace,false))throw new Error('Final Trace could not be saved in this browser.');}});
$('#refreshObservation').onclick=async()=>{const button=$('#refreshObservation');button.disabled=true;button.textContent='Checking…';try{await observer.refresh();notify(S.observation?.status==='unconfigured'?'Source not configured. Set a target mint and observation accounts to enable live checks.':S.observation?.error||'Source check completed.');}catch(error){notify(`Source check failed: ${error.message}`);}finally{button.disabled=false;button.textContent='Check source ↻';}};
document.addEventListener('click',async e=>{if(!e.target.closest('[data-copy-mint]'))return;const mint=S.observation?.config?.scope?.mint||SITE.token.mint;if(!isPublicAddress(mint)){notify('Contract address has not been announced.');return;}try{await navigator.clipboard.writeText(mint);notify('Mint address copied.');}catch{notify('Copy failed. Select the mint address and copy it manually.');}});
document.addEventListener('visibilitychange',()=>{if(document.hidden){if(S.playback.playing)pausePlayback(false);workbench?.pause();}});
addEventListener('beforeunload',()=>{observer.stop();wallet.destroy();renderer.destroy();dashboard.destroy();workbench?.destroy();sourceWorkspace?.destroy();runtime?.destroy();clearInterval(footerTimer);clearTimeout(S.playback.timer);});
Promise.all([fetch('/config/rules.js').then(r=>{if(!r.ok)throw new Error();return r.text();}),fetch('/modules/engine.js').then(r=>{if(!r.ok)throw new Error();return r.text();})]).then(parts=>{$('#actualRules').textContent=parts.join('\n\n// ACTUAL ENGINE IMPLEMENTATION\n\n');}).catch(()=>{$('#actualRules').textContent='Rule source could not be loaded. Refresh this page to retry.';});
document.title=BRAND_NAME;$('.brand').setAttribute('aria-label',`${SITE.brand.name} home`);
$('#protocol-paths .path-rules').innerHTML=`<article><b>QUIET</b><p>A reconciled, complete window contains zero valid inputs.</p></article><article><b>FLOW</b><p>Valid inputs are present, without the enhancement condition.</p></article><article><b>SURGE</b><p>At least ${RULES.surgeMinInputs} valid inputs and ${RULES.surgeMultiplier}× the mean of ${RULES.baselineWindows} preceding complete windows.</p></article>`;
function clearFilters(feedback=true){resetPlayback(false);workbench?.pause();S.selected='sensor';renderer.select('sensor');workbench?.setSelection('sensor');S.rangeStart=null;S.rangeEnd=null;S.rangeTraceId=null;S.selectedEvent=null;$('#eventDetail').hidden=true;S.filter={time:'all',type:'all',address:''};S.filterAddress='';syncWalletLabel();$('#walletAddress').value=wallet.address||'';$('#walletDisconnect').hidden=!wallet.address;$('#walletDisconnect').textContent='Disconnect';$('#eventTime').value='all';$('#eventType').value='all';$('#eventAddress').value='';$('#eventDetail').hidden=true;renderPlayback();renderUnified();renderEvents();if(feedback)notify('Time and event filters cleared. The selected source is unchanged.');}
function renderUnified(){
 const trace=currentTrace();const m=dashboard.update(trace,instrumentOptions());
 if(S.page==='runtime')runtime?.update(trace,m,{selected:S.selected,playback:S.playback,context:S.context});
 $('#contextMode').textContent=S.context==='replay'?'HISTORICAL REPLAY'+(trace?.source.mode==='example'?' / EXAMPLE':''):S.context==='example'?'EXAMPLE INPUTS':'LIVE OBSERVATION';
 $('#contextWindow').textContent=trace?formatEasternRange(trace.window.start,trace.window.end):'No verified window · target not configured';
 $('#contextSelection').textContent=`${COMPONENTS.find(c=>c.id===S.selected)?.name.toUpperCase()} / ${m.selection.rangeActive?formatEasternRange(m.range.start,m.range.end,{offset:false}):'FULL WINDOW'}`;
 $('#returnLive').classList.toggle('active',S.context==='live');$('#footerMode').textContent=$('#contextMode').textContent;
 $('#heroWindow').textContent=trace?`${trace.window.durationMs/1000}s / ET`:'60s / ET';$('#heroCounts').textContent=trace?`${trace.count} / ${trace.filtered.length}`:'— / —';$('#heroPath').textContent=trace?.path||'PENDING';
 $('#heroSourceNote').textContent=trace?`${m.source.label} · ${trace.source.label} · ${m.coverage.complete?'complete window':'incomplete coverage'}`:'Live scope: supply a target mint and observation accounts. Local examples remain available.';
 $('#rackSelection').textContent=COMPONENTS.find(c=>c.id===S.selected)?.name||'Sensor';$('#rackPath').textContent=trace?.path||'PENDING';$('#circuitRules').textContent=trace?.rulesVersion||RULES.version;
 $$('[data-observation-mode]').forEach(n=>n.textContent=m.source.label+(trace?' / '+trace.source.scopeId:''));
 timeline($('#homeTimeline'),trace);
 $('#componentRack').innerHTML=m.components.map((c,i)=>`<button class="rack-row ${c.selected?'selected':''}" data-rack-component="${c.id}"><span>${String(i+1).padStart(2,'0')}</span><div><b>${c.name}</b><small>${esc(displayTimeDescription(c.responsibility))}</small></div><div class="rack-meter"><i style="width:${(c.relativeActivity||0)*100}%"></i></div><em>${c.processCount??'—'}<small>${esc(c.unit)}</small></em></button>`).join('');
 const c=m.components.find(c=>c.id===S.selected),step=trace?.steps.find(v=>v.id===S.selected),readout=resolveComponentReadout(trace,m,S.selected);
 $('#topologyDetail').innerHTML=`<div class="topology-rail">${COMPONENTS.map((c,i)=>`<button data-rack-component="${c.id}" class="${c.id===S.selected?'selected':''}"><span>0${i+1}</span>${c.name}${i<5?'<i>→</i>':''}</button>`).join('')}</div><div class="topology-readout"><span>${esc(c.name.toUpperCase())} / ENGINE I/O</span><h3>${esc(displayTimeDescription(c.responsibility))}</h3><div class="topology-numbers"><b>${readout.inputCount??'—'}<small>INPUT</small></b><b>${readout.outputCount??'—'}<small>OUTPUT</small></b><b>${esc(step?.status||'NO WINDOW')}<small>RULE STATUS</small></b></div><p>${esc(displayTimeDescription(readout.detail||'Select a saved or example window to inspect the actual stage result.'))}</p><small>${c.wholeWindow?'Evaluation belongs to the whole window. A time filter does not rerun the rule.':'Activity counts refer to the selected Eastern time range.'}</small><a href="#source">Read the actual implementation ↗</a></div>`;
}
function inspectEvent(event){
 if(!currentTrace())return;S.selectedEvent=event;S.rangeStart=null;S.rangeEnd=null;pausePlayback(false);S.playback.step=-1;renderer.setReplayStep(null);selectComponent('sensor');
 const root=$('#eventDetail');root.hidden=false;root.innerHTML=`<div class="panel-heading">INPUT EVIDENCE <span>${esc(dashboard.model.source.label)}</span></div><div class="event-evidence"><div><span>US EASTERN / TYPE</span><h3>${esc(eastern(event.timestamp))} / ${esc(event.kind)}</h3><p>${event.accepted?'Accepted by the rule engine.':esc(displayTimeDescription(event.reason))}</p><p>Processed path: ${event.completedPath.map(esc).join(' → ')}</p>${event.signature&&dashboard.model.source.locallyObserved?`<a href="https://explorer.solana.com/tx/${encodeURIComponent(event.signature)}${currentTrace()?.source.network==='mainnet-beta'?'':`?cluster=${encodeURIComponent(currentTrace()?.source.network||'mainnet-beta')}`}" target="_blank" rel="noopener noreferrer">Verified transaction evidence ↗</a>`:'<span class="scope-note">No live transaction evidence is claimed for this local or imported record.</span>'}<div class="replay-controls"><button class="button primary" data-evidence-play>Replay processed path</button><button class="text-button" data-evidence-clear>Close detail</button></div></div><pre data-event-json></pre></div>`;
 root.querySelector('[data-event-json]').textContent=JSON.stringify(event.input,null,2);root.querySelector('[data-event-json]').setAttribute('aria-label','Raw input data; timestamps are Unix epoch milliseconds.');root.querySelector('[data-evidence-play]').onclick=()=>{resetPlayback(false);playPause();};root.querySelector('[data-evidence-clear]').onclick=()=>{resetPlayback(false);S.selectedEvent=null;$('#eventDetail').hidden=true;root.hidden=true;renderPlayback();};
 const switched=S.page!=='live';if(switched)go('#live');else renderUnified();renderEvents();if(switched)setTimeout(()=>{if(S.page==='live'&&S.selectedEvent?.id===event.id)playPause();},0);else playPause();notify('Input evidence selected. Replaying only its processed path.');
}
$('#componentRack').onclick=e=>{const id=e.target.closest('[data-rack-component]')?.dataset.rackComponent;if(id)pinComponent(id);};$('#topologyDetail').onclick=e=>{const id=e.target.closest('[data-rack-component]')?.dataset.rackComponent;if(id)pinComponent(id);};
$('#loadOverviewExample').onclick=()=>{resetPlayback(false);workbench?.pause();S.example=buildWorkbenchTrace();S.context='example';S.rangeStart=null;S.rangeEnd=null;S.rangeTraceId=null;S.selectedEvent=null;$('#eventDetail').hidden=true;renderer.setReplayStep(null);renderStage();renderPlayback();renderEvents();if(S.page==='workbench'||S.page==='memory'&&S.detailId)go('#home');notify('Fixed local example loaded across all instruments. No live activity is implied.');};
$('#returnLive').onclick=()=>{resetPlayback(false);workbench?.pause();S.context='live';S.rangeStart=null;S.rangeEnd=null;S.rangeTraceId=null;S.selectedEvent=null;$('#eventDetail').hidden=true;renderer.setReplayStep(null);renderStage();renderPlayback();renderEvents();if(S.page==='workbench'||S.page==='memory'&&S.detailId)go('#live');notify('Returned to the shared live observation scope.');};$('#clearSelection').onclick=()=>clearFilters();
$('#routePlay').onclick=playPause;$('#routeStep').onclick=()=>{pausePlayback(false);if(S.playback.step>=replayLimit()-1)S.playback.step=-1;advance();};$('#routeReset').onclick=()=>resetPlayback();$('#saveCurrentTrace').onclick=()=>{const t=currentTrace();if(t)persist(t,true);else notify('Select a Trace before saving.');};$('#liveCheck').onclick=()=>$('#refreshObservation').click();
sourceWorkspace=mountSourceWorkspace($('[data-source-workspace]'),{onError:message=>notify(typeof message==='string'?message:'Source workspace could not be loaded.')});
workbench=mountWorkbench($('#advancedWorkbench'),{onTrace:(trace,meta)=>{if(S.page!=='workbench')return;pausePlayback(false);S.context='example';S.example=trace;S.selectedEvent=null;$('#eventDetail').hidden=true;S.rangeStart=null;S.rangeEnd=null;S.playback.step=-1;renderer.setReplayStep(null);renderStage();renderEvents();if(meta.executed)notify(`Executed ${trace.count} local example inputs. Result: ${trace.path}.`);},onStep:(index,trace)=>{S.context='example';S.example=trace;S.playback.step=index;selectComponent(COMPONENTS[index].id);renderer.setReplayStep(index);renderPlayback();},onReset:trace=>{S.context='example';S.example=trace;resetPlayback(false,true);renderStage();},onSelect:id=>selectComponent(id),onSpeed:speed=>{S.playback.speed=speed;},onPlay:()=>{S.playback.playing=true;renderPlayback();},onPause:()=>{S.playback.playing=false;renderPlayback();}});
runtime=mountRuntime($('#runtimeWorkspace'),{onSelect:pinComponent,onEvent:id=>{const event=dashboard.model?.events.find(e=>e.id===id);if(event)inspectEvent(event);},onReplay:playPause,onStep:()=>$('#routeStep').click(),onReset:()=>resetPlayback(),onSave:()=>$('#saveCurrentTrace').click(),onInspectCore:()=>go('#circuit')});
const footerClock=()=>{$('#footerTime').textContent=eastern(Date.now());};footerClock();const footerTimer=setInterval(footerClock,1000);
document.addEventListener('click',e=>{if(e.target.closest('[data-load-example]'))$('#loadOverviewExample').click();});
renderMemory();renderToken();applyRoute();selectComponent('sensor');observer.start().catch(error=>notify(`Source setup failed: ${error.message}`));if(stored.error)notify(stored.error);
