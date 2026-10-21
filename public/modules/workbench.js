import {formatEasternDateTime,formatEasternRange,displayTimeDescription} from './time.js';
import { COMPONENTS, RULES, finalizeWindow, validateTrace } from './engine.js';

/** Local fixtures never change the live observation rules or claim signatures. */
export const WORKBENCH_LIMITS = Object.freeze({
  windows: Object.freeze([60, 120, 300]), multiplierMin: 1, multiplierMax: 5,
  maxInputs: 60, scenarios: Object.freeze(['single', 'burst', 'flow']),
  speeds: Object.freeze([0.5, 1, 2, 4]),
});
const FIXED_WINDOW = Date.UTC(2026, 9, 16, 0, 5, 0);
const QUANTITY = Object.freeze({ single: 1, burst: 12, flow: 6 });
const SCENARIO_NAMES = Object.freeze({ single: 'Single pulse', burst: 'Short burst', flow: 'Gradual flow' });
const eastern = formatEasternDateTime;

export function normalizeWorkbenchParameters(value = {}) {
  const scenario = value.scenario ?? 'burst';
  const windowSeconds = Number(value.windowSeconds ?? 60);
  const multiplier = Number(value.multiplier ?? 1);
  if (!WORKBENCH_LIMITS.scenarios.includes(scenario)) throw new TypeError('Choose single, burst, or flow.');
  if (!WORKBENCH_LIMITS.windows.includes(windowSeconds)) throw new TypeError('The local window must be 60, 120, or 300 seconds.');
  if (!Number.isSafeInteger(multiplier) || multiplier < 1 || multiplier > 5) throw new TypeError('The local input multiplier must be an integer from 1 to 5.');
  return Object.freeze({ scenario, windowSeconds, multiplier });
}

/** A reproducible record, including its five preceding local baseline windows. */
export function buildWorkbenchTrace(value = {}) {
  const p = normalizeWorkbenchParameters(value);
  const rules = { ...RULES, supportedKinds: [...RULES.supportedKinds], windowMs: p.windowSeconds * 1000 };
  const source = {
    mode: 'example', label: `Local Workbench / ${SCENARIO_NAMES[p.scenario]} / ${p.windowSeconds}s ×${p.multiplier}`,
    network: 'example', mint: null, accounts: [],
    scopeId: `example-workbench-v11:${p.scenario}:${p.windowSeconds}s:x${p.multiplier}`,
  };
  const start = Math.floor(FIXED_WINDOW / rules.windowMs) * rules.windowMs;
  const makeInputs = (at, count, prefix, kind) => Array.from({ length: count }, (_, index) => {
    const spread = kind === 'burst' ? Math.min(350, (rules.windowMs - 2000) / Math.max(1, count - 1))
      : Math.floor(rules.windowMs * 0.8 / Math.max(1, count - 1));
    return { id: `${prefix}-${index + 1}`, timestamp: at + 1000 + Math.floor(index * spread), kind: 'Activity', source: 'example', verified: true, scopeId: source.scopeId };
  });
  const baseline = [];
  for (let index = rules.baselineWindows; index >= 1; index--) {
    const at = start - index * rules.windowMs;
    baseline.push(finalizeWindow({ inputs: makeInputs(at, 3, `wb-baseline-${index}`, 'flow'), windowStart: at, now: at + rules.windowMs,
      coverage: 'complete', parsingComplete: true, source, rules }));
  }
  const trace = finalizeWindow({ inputs: makeInputs(start, QUANTITY[p.scenario] * p.multiplier, `wb-${p.scenario}-x${p.multiplier}`, p.scenario),
    windowStart: start, now: start + rules.windowMs, coverage: 'complete', parsingComplete: true, baseline, source, rules });
  const checked = validateTrace(trace);
  if (!checked.valid) throw new Error(checked.errors.join(' '));
  return trace;
}

/** Actual input counts and cumulative accepted inputs; never a decorative curve. */
export function workbenchSignalBins(trace, bins = 24) {
  if (!Number.isSafeInteger(bins) || bins < 1 || bins > 120) throw new TypeError('Choose 1 to 120 signal bins.');
  const counts = Array.from({ length: bins }, (_, index) => ({
    start: trace.window.start + index * trace.window.durationMs / bins,
    end: trace.window.start + (index + 1) * trace.window.durationMs / bins,
    received: 0, accepted: 0, accumulated: 0,
  }));
  for (const [key, inputs] of [['received', trace.inputs], ['accepted', trace.validInputs]]) {
    for (const input of inputs) {
      if (input?.timestamp < trace.window.start || input?.timestamp >= trace.window.end || !Number.isFinite(input?.timestamp)) continue;
      const index = Math.min(bins - 1, Math.floor((input.timestamp - trace.window.start) / trace.window.durationMs * bins));
      counts[index][key]++;
    }
  }
  let cumulative = 0;
  for (const bin of counts) { cumulative += bin.accepted; bin.accumulated = cumulative; }
  return counts;
}

function svgNode(document, name, attrs = {}) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
  return element;
}

/** Owns local playback only. The callbacks synchronize the shared app state. */
export function mountWorkbench(root, callbacks = {}) {
  if (!root?.ownerDocument) throw new TypeError('A Workbench root element is required.');
  const document = root.ownerDocument;
  const controller = new AbortController();
  const { signal } = controller;
  let trace, selected = 'sensor', step = -1, playing = false, speed = 1, timer = null, destroyed = false;
  let replayMode = 'auto';
  root.classList.add('wb-root');
  root.innerHTML = `<div class="wb-command"><span>WORKBENCH / LOCAL EXECUTION</span><span data-wb-status>READY · EXAMPLE INPUTS</span><time data-wb-window></time></div>
  <div class="wb-layout"><section class="wb-form-pane"><header class="wb-intro"><span>01 / CIRCUIT PARAMETERS</span><h2>Shape a signal.<br> Inspect its route.</h2><p>A local bench for the same six processing stages. Every device readout and waveform below comes from the displayed example record.</p></header>
  <form class="wb-form"><label><span>01 / input pattern</span><select name="scenario"><option value="single">Single pulse / 1 input per batch</option><option value="burst" selected>Short burst / 12 inputs per batch</option><option value="flow">Gradual flow / 6 inputs per batch</option></select></label>
  <label><span>02 / local window · US Eastern</span><select name="windowSeconds"><option value="60">60 seconds</option><option value="120">120 seconds</option><option value="300">300 seconds</option></select><small>Local preview only. Live observation keeps its configured 60-second rule.</small></label>
  <div class="wb-resource-row"><label><span>03 / input batches</span><input name="multiplier" type="range" min="1" max="5" step="1" value="1"><output data-wb-multiplier>×1</output><small>1–5 deterministic batches · maximum 60 inputs</small></label><label><span>04 / replay speed</span><select name="speed"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option><option value="4">4×</option></select><small>Changes playback timing; record counts stay fixed.</small></label></div>
  <label><span>05 / replay control</span><select name="replayMode"><option value="auto">Automatic / advance through six stages</option><option value="step">Manual / inspect one stage at a time</option></select></label>
  <div class="wb-contract"><span>FIXED RULE CONTRACT</span><p>Deduplicate → accumulate → compare five preceding complete windows → choose QUIET / FLOW / SURGE. The local baseline holds 3 inputs per window.</p></div>
  <div class="wb-actions"><button class="wb-primary" type="submit" data-wb-action="execute">Execute local inputs ↗</button><button type="button" data-wb-action="pause">Pause</button><button type="button" data-wb-action="step">Step</button><button type="button" data-wb-action="reset">Reset ↺</button></div><p class="wb-feedback" data-wb-feedback role="status">Parameters ready. Execute or step through the local example.</p></form>
  <section class="wb-evidence"><header><span>REPRODUCIBLE INPUT</span><button type="button" data-wb-action="inspect">Inspect result ↓</button></header><dl><div><dt>Scope</dt><dd data-wb-scope></dd></div><div><dt>Rule version</dt><dd data-wb-rule></dd></div><div><dt>Baseline evidence</dt><dd data-wb-baseline></dd></div></dl></section></section>
  <aside class="wb-device-pane"><header class="wb-device-head"><div><span>LOCAL CIRCUIT CHASSIS</span><strong>Six-stage processing instrument</strong></div><b><i></i>EXAMPLE INPUTS</b></header><div class="wb-chassis-stage"><div class="wb-plate-label">PHYSICAL MODEL / DISPLAY STRUCTURE</div><div data-wb-chassis class="wb-chassis-mount" aria-label="Interactive local chassis"></div><div class="wb-slot-inspector"><span data-wb-slot-label>01 / SENSOR</span><b data-wb-slot-title>Input acquisition</b><p data-wb-slot-detail></p></div></div>
  <div class="wb-device-readout"><div><span>OUTPUT ROUTE</span><strong data-wb-path></strong><small data-wb-progress>READY / SIX STAGES</small></div><dl><div><dt>Accepted</dt><dd data-wb-count></dd></div><div><dt>Window</dt><dd data-wb-duration></dd></div><div><dt>Baseline avg.</dt><dd data-wb-average></dd></div><div><dt>Growth ratio</dt><dd data-wb-ratio></dd></div></dl></div>
  <div class="wb-stage-rail" aria-label="Inspect processing stage"></div>
  <section class="wb-signal"><header><span>INPUT / ACCUMULATION</span><b data-wb-signal-units></b></header><div data-wb-wave class="wb-wave"></div><footer><span data-wb-signal-start></span><span data-wb-signal-end></span></footer><div class="wb-wave-legend"><span><i></i>Received inputs / bin</span><span><i></i>Cumulative accepted inputs</span><b>LOCAL EXAMPLE</b></div></section>
  <section class="wb-result" data-wb-result tabindex="-1"><header><span>RESULT INSPECTION</span><b data-wb-result-state>FINAL / EXAMPLE</b></header><p data-wb-result-reason></p><div data-wb-result-steps></div></section><footer class="wb-device-foot"><span>BROWSER / LOCAL ONLY</span><p>The restored chassis is a display model. Inputs are fixtures; no remote worker is registered and no transaction is submitted.</p></footer></aside></div>`;
  const one = selector => root.querySelector(selector);
  const all = selector => [...root.querySelectorAll(selector)];
  const form = one('.wb-form');
  const set = (selector, value) => { const element = one(selector); if (element) element.textContent = String(value); };
  const call = (key, ...args) => { if (!destroyed && typeof callbacks[key] === 'function') callbacks[key](...args); };
  const parameters = () => ({ scenario: form.elements.scenario.value, windowSeconds: Number(form.elements.windowSeconds.value), multiplier: Number(form.elements.multiplier.value) });
  function clearTimer() { if (timer !== null) clearTimeout(timer); timer = null; }
  function renderPlayback() {
    set('[data-wb-status]', playing ? 'RUNNING · LOCAL EXAMPLE' : step === 5 ? 'COMPLETE · LOCAL EXAMPLE' : step >= 0 ? 'PAUSED · LOCAL EXAMPLE' : 'READY · LOCAL EXAMPLE');
    set('[data-wb-progress]', step < 0 ? 'READY / SIX STAGES' : `${String(step + 1).padStart(2, '0')} / 06 · ${COMPONENTS[step].name.toUpperCase()}`);
    one('[data-wb-action="pause"]').disabled = !playing;
    all('[data-wb-component]').forEach(button => { button.classList.toggle('is-active', button.dataset.wbComponent === selected); button.classList.toggle('is-current', COMPONENTS[step]?.id === button.dataset.wbComponent); button.setAttribute('aria-pressed', String(button.dataset.wbComponent === selected)); });
    all('[data-wb-slot]').forEach(element => {
      const id = element.dataset.wbSlot;
      element.classList.toggle('is-selected', id === selected);
      element.classList.toggle('is-processing', playing && COMPONENTS[step]?.id === id);
      if (COMPONENTS.some(component => component.id === id)) element.setAttribute('aria-pressed', String(id === selected));
    });
    root.dataset.playing = String(playing);
  }
  function select(id, notify = true) {
    const component = COMPONENTS.find(value => value.id === id);
    if (!component) return;
    selected = id;
    set('[data-wb-slot-label]', `${String(COMPONENTS.indexOf(component) + 1).padStart(2, '0')} / ${component.name.toUpperCase()}`);
    set('[data-wb-slot-title]', displayTimeDescription(component.responsibility));
    set('[data-wb-slot-detail]', displayTimeDescription(trace.steps.find(value => value.id === id)?.detail || ''));
    renderPlayback();
    if (notify) call('onSelect', id, trace);
  }
  function pinSelection(id) {
    const component = COMPONENTS.find(value => value.id === id);
    if (!component) return;
    pause(false); select(id);
    set('[data-wb-feedback]', `${component.name} selected for inspection. Step or execute to continue playback.`);
  }
  function drawSignal() {
    const bins = workbenchSignalBins(trace);
    const svg = svgNode(document, 'svg', { viewBox: '0 0 660 154', role: 'img', 'aria-label': `Local inputs per ${trace.window.durationMs / 24000}-second bin and cumulative accepted inputs` });
    const plot = { x: 35, y: 15, width: 585, height: 113 };
    const maxReceived = Math.max(1, ...bins.map(bin => bin.received));
    const maxAccepted = Math.max(1, trace.count);
    for (let index = 0; index <= 4; index++) {
      const y = plot.y + index * plot.height / 4;
      svg.append(svgNode(document, 'line', { x1: plot.x, y1: y, x2: plot.x + plot.width, y2: y, class: 'wb-wave-grid' }));
    }
    bins.forEach((bin, index) => {
      const height = bin.received / maxReceived * plot.height;
      const bar = svgNode(document, 'rect', { x: plot.x + index * plot.width / bins.length + 2, y: plot.y + plot.height - height, width: plot.width / bins.length - 4, height, class: 'wb-wave-bar' });
      const title = svgNode(document, 'title'); title.textContent = `${formatEasternRange(bin.start,bin.end)}: ${bin.received} inputs; ${bin.accumulated} accumulated`; bar.append(title); svg.append(bar);
    });
    const line = bins.map((bin, index) => `${index ? 'L' : 'M'}${plot.x + (index + .5) * plot.width / bins.length},${plot.y + plot.height - bin.accumulated / maxAccepted * plot.height}`).join(' ');
    svg.append(svgNode(document, 'path', { d: line, class: 'wb-wave-line' }));
    for (const [x, y, text] of [[4, 21, String(maxReceived)], [13, 130, '0'], [627, 21, String(maxAccepted)], [627, 130, '0']]) {
      const label = svgNode(document, 'text', { x, y, class: 'wb-wave-axis' }); label.textContent = text; svg.append(label);
    }
    one('[data-wb-wave]').replaceChildren(svg);
    set('[data-wb-signal-units]', `24 BINS × ${trace.window.durationMs / 24000}s · INPUT COUNT`);
    set('[data-wb-signal-start]', eastern(trace.window.start)); set('[data-wb-signal-end]', eastern(trace.window.end));
  }
  function render() {
    set('[data-wb-window]', eastern(trace.window.start));
    set('[data-wb-multiplier]', `×${form.elements.multiplier.value}`);
    set('[data-wb-scope]', trace.source.scopeId); set('[data-wb-rule]', `${trace.rulesVersion} · local ${trace.rules.windowMs / 1000}s window`);
    set('[data-wb-baseline]', `${trace.baselineEvidence.map(value => value.count).join(' / ')} · ${trace.baselineEvidence.length} consecutive complete example windows`);
    set('[data-wb-path]', trace.path); set('[data-wb-count]', trace.count); set('[data-wb-duration]', `${trace.window.durationMs / 1000}s`);
    set('[data-wb-average]', `${trace.baselineAverage} inputs`); set('[data-wb-ratio]', trace.growthRatio == null ? 'N/A' : `${trace.growthRatio.toFixed(2)}×`);
    set('[data-wb-result-reason]', `${trace.count} accepted; ${trace.filtered.length} filtered. ${trace.baselineReason} ${trace.path} is the deterministic display route for this local window.`);
    const rows = COMPONENTS.map((component, index) => {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.wbComponent = component.id;
      const number = document.createElement('span'); number.textContent = String(index + 1).padStart(2, '0');
      const name = document.createElement('b'); name.textContent = component.name;
      const count = document.createElement('small'); count.textContent = `${trace.steps[index].inputCount} → ${trace.steps[index].outputCount}`;
      button.append(number, name, count); return button;
    });
    one('.wb-stage-rail').replaceChildren(...rows);
    const details = trace.steps.map(value => { const row = document.createElement('p'); const name = document.createElement('b'); name.textContent = `${value.name} / `; row.append(name, document.createTextNode(displayTimeDescription(value.detail))); return row; });
    one('[data-wb-result-steps]').replaceChildren(...details);
    drawSignal(); select(selected, false);
  }
  function pause(notify = true, emit = true) {
    if (destroyed) return;
    const wasPlaying = playing; clearTimer(); playing = false; renderPlayback();
    if (wasPlaying && emit) call('onPause', trace);
    if (notify && wasPlaying) set('[data-wb-feedback]', `Paused at ${COMPONENTS[step]?.name || 'the beginning'}. Step or execute to continue.`);
  }
  function schedule() { clearTimer(); if (playing) timer = setTimeout(() => advance(), 900 / speed); }
  function advance() {
    if (step >= 5) { pause(false); return; }
    step++; select(COMPONENTS[step].id, false); call('onStep', step, trace);
    if (step === 5) { pause(false, false); set('[data-wb-feedback]', `Execution complete. ${trace.count} accepted inputs → ${trace.path}. Inspect or save this example through Memory.`); call('onPause', trace); }
    else if (playing) schedule();
  }
  function changeParameters(reason = 'parameters') {
    pause(false); step = -1; trace = buildWorkbenchTrace(parameters()); render();
    set('[data-wb-feedback]', 'Preview updated from deterministic example inputs. Execute to replay all six stages.');
    call('onTrace', trace, { reason, executed: false }); call('onReset', trace);
  }
  function execute() {
    if (destroyed) return;
    pause(false); if (step >= 5) step = -1;
    call('onTrace', trace, { reason: 'execute', executed: true }); call('onPlay', trace);
    if (replayMode === 'step') { set('[data-wb-feedback]', 'Manual execution. Use Step to inspect each stage.'); advance(); if (step < 5) call('onPause', trace); }
    else { playing = true; set('[data-wb-feedback]', 'Replaying the local processing path. No live observation counts are changed.'); advance(); }
    renderPlayback();
  }
  function stepPlayback() {
    if (destroyed) return;
    pause(false); if (step >= 5) step = -1; advance();
  }
  function resetPlayback() {
    if (destroyed) return;
    pause(false); step = -1; selected = 'sensor'; render();
    call('onReset', trace); call('onSelect', selected, trace);
    set('[data-wb-feedback]', 'Replay reset. The selected parameters and example record are retained.');
  }
  function setSpeed(value) {
    if (destroyed) return;
    const next = Number(value);
    if (!WORKBENCH_LIMITS.speeds.includes(next)) throw new TypeError('Choose a supported replay speed.');
    speed = next; form.elements.speed.value = String(speed); call('onSpeed', speed);
    if (playing) schedule();
  }
  form.addEventListener('submit', event => { event.preventDefault(); execute(); }, { signal });
  form.addEventListener('input', event => {
    if (['scenario', 'windowSeconds', 'multiplier'].includes(event.target.name)) changeParameters();
    else if (event.target.name === 'speed') setSpeed(event.target.value);
    else if (event.target.name === 'replayMode') { replayMode = event.target.value === 'step' ? 'step' : 'auto'; pause(); }
  }, { signal });
  root.addEventListener('click', event => {
    const component = event.target.closest('[data-wb-component]')?.dataset.wbComponent || event.target.closest('[data-wb-slot]')?.dataset.wbSlot;
    if (component) pinSelection(component);
    const action = event.target.closest('[data-wb-action]')?.dataset.wbAction;
    if (action === 'pause') pause();
    if (action === 'step') stepPlayback();
    if (action === 'reset') resetPlayback();
    if (action === 'inspect') { one('[data-wb-result]').focus({ preventScroll: true }); one('[data-wb-result]').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  }, { signal });
  root.addEventListener('keydown', event => { if (!['Enter', ' '].includes(event.key) || !event.target.matches('[data-wb-slot]')) return; event.preventDefault(); pinSelection(event.target.dataset.wbSlot); }, { signal });
  document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); }, { signal });
  // Stop even if the host forgets to call pause while navigating away. The
  // former V1 route is recognized only for backward-compatible deep links.
  document.defaultView?.addEventListener('hashchange', () => {
    if (!/^#(?:workbench(?:\/|$)|circuit\/workbench(?:\/|$))/.test(document.defaultView.location.hash)) pause();
  }, { signal });
  document.defaultView?.addEventListener('pagehide', () => pause(false), { signal });
  changeParameters('mount');
  // This same-origin, shipped asset contains no data or imported markup.
  fetch('/assets/workbench-chassis.svg', { signal, cache: 'no-cache' }).then(response => { if (!response.ok) throw new Error('Chassis asset unavailable.'); return response.text(); }).then(markup => {
    if (destroyed) return;
    const parsed = new DOMParser().parseFromString(markup, 'image/svg+xml');
    const source = parsed.documentElement;
    if (source.localName !== 'svg' || parsed.querySelector('parsererror,script,foreignObject,image,use,a')) throw new Error('Invalid chassis asset.');
    for (const element of [source, ...source.querySelectorAll('*')]) for (const attribute of [...element.attributes]) if (/^on/i.test(attribute.name) || /href/i.test(attribute.name) || /url\(/i.test(attribute.value)) throw new Error('Unsafe chassis asset.');
    one('[data-wb-chassis]').replaceChildren(document.importNode(source, true)); renderPlayback();
  }).catch(error => { if (!destroyed && error.name !== 'AbortError') { const note = document.createElement('p'); note.className = 'wb-asset-note'; note.textContent = 'Chassis illustration unavailable. The six stage controls and local execution remain available.'; one('[data-wb-chassis]').replaceChildren(note); } });
  return {
    getTrace: () => trace,
    getPlaybackState: () => Object.freeze({ step, playing, speed, selected, replayMode }),
    setSelection: id => { if (!destroyed) select(id, false); },
    play: execute,
    step: stepPlayback,
    resetPlayback,
    setSpeed,
    pause: () => pause(),
    destroy() { if (destroyed) return; pause(false); destroyed = true; controller.abort(); root.replaceChildren(); root.classList.remove('wb-root'); },
  };
}
