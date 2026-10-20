import {DISPLAY_TIME_ZONE,formatEasternRange,displayTimeDescription} from './time.js';
import { COMPONENTS, stableStringify } from './engine.js';

const MAX_BUCKETS = 240;
const MAX_DATE = 8_640_000_000_000_000;
const validTime = value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_DATE;
const iso = value => validTime(value) ? new Date(value).toISOString() : null;
const componentNames = COMPONENTS.map(component => component.id);
const processUnits = ['input checks', 'filter checks', 'accepted Pulses', 'window evaluations', 'path selections', 'Trace preparations'];

function sourceModel(trace, options) {
  const example = trace?.source?.mode === 'example';
  // A source.mode of "live" in JSON is provenance supplied by a file, not proof
  // of a current local observation. The caller must positively establish that.
  const live = !example && !options.imported && options.locallyObserved === true &&
    options.context !== 'replay' && options.sourceMode !== 'historical';
  const mode = !trace ? 'unavailable' : example ? 'example' : live ? 'live' : 'historical';
  const rangeLabel = trace?.window ? formatEasternRange(trace.window.start,trace.window.end) : null;
  return {
    mode, label: { unavailable: 'No selected Trace', example: 'Local example', live: 'Observed scope', historical: 'Historical replay' }[mode],
    claimedMode: trace?.source?.mode ?? null,
    imported: options.imported === true,
    locallyObserved: live,
    scopeId: trace?.source?.scopeId ?? null,
    network: trace?.source?.network ?? null,
    mint: trace?.source?.mint ?? null,
    accounts: [...(trace?.source?.accounts || [])],
    sourceLabel: trace?.source?.label ?? null,
    observedAt: trace?.observedAt ?? null,
    observedAtUtc: iso(trace?.observedAt),
    rangeLabel,
    scopeLabel: trace ? `${example ? trace.source.label : `${trace.source.accounts.length} observed account(s) · ${trace.source.mint || 'mint unavailable'}`} · ${rangeLabel}` : 'No selected observation scope',
  };
}

function unavailable(options) {
  const selected = componentNames.includes(options.componentId) ? options.componentId : null;
  return {
    available: false, traceId: null, source: sourceModel(null, options),
    window: null, range: null, coverage: { state: 'missing', complete: false, parsingComplete: false },
    selection: { componentId: selected, eventType: options.eventType || 'all', address: options.address || '', rangeActive: false },
    metrics: { inputCount: null, acceptedCount: null, filteredCount: null, bucketedInputCount: null, unbucketedInputCount: null, intensityLabel: 'Relative activity · no selected Trace' },
    components: COMPONENTS.map((component, index) => ({ ...component, selected: component.id === selected, inputCount: null, outputCount: null, processCount: null, unit: processUnits[index], relativeActivity: null, status: 'unavailable', level: 'unavailable' })),
    activityGrid: [], bins: [], waveform: { unit: 'Pulse / bucket', bucketMs: null, axis: DISPLAY_TIME_ZONE, series: [], bins: [] },
    events: [], allEvents: [], result: { path: null, status: 'unavailable', wholeWindow: true, baselineAverage: null, growthRatio: null },
  };
}

function takeMultiset(items) {
  const counts = new Map();
  for (const item of items || []) { const key = stableStringify(item); counts.set(key, (counts.get(key) || 0) + 1); }
  return item => {
    const key = stableStringify(item), count = counts.get(key) || 0;
    if (!count) return false;
    counts.set(key, count - 1);
    return true;
  };
}

function inputEvents(trace, source) {
  const takeAccepted = takeMultiset(trace.validInputs);
  const reasons = new Map();
  for (const rejection of trace.filtered || []) {
    const key = stableStringify(rejection.input);
    if (!reasons.has(key)) reasons.set(key, []);
    reasons.get(key).push(rejection.reason);
  }
  return (trace.inputs || []).map((input, index) => {
    const accepted = takeAccepted(input), key = stableStringify(input);
    const timestamp = validTime(input?.timestamp) ? input.timestamp : null;
    const inWindow = timestamp !== null && timestamp >= trace.window.start && timestamp < trace.window.end;
    const filteredReason = accepted ? null : reasons.get(key)?.shift() || 'Not in accepted inputs';
    const plannedPath = accepted ? [...componentNames] : ['sensor', 'resistor'];
    const path = accepted && trace.status !== 'final' ? ['sensor', 'resistor', 'capacitor'] : plannedPath;
    return {
      id: `${trace.id}:input:${index}`, inputId: input?.id ?? null, index,
      timestamp, timeUtc: iso(timestamp), kind: input?.kind ?? 'Malformed input',
      accepted, filtered: !accepted, reason: filteredReason, inWindow,
      signature: input?.signature ?? null, mint: input?.mint ?? null, slot: input?.slot ?? null,
      address: input?.address ?? null, accounts: [...(input?.accounts || [])],
      sourceMode: source.mode, sourceLabel: source.label, scopeId: source.scopeId,
      traceId: trace.id, path, plannedPath, input,
      // A partial Trace can inspect accepted accumulation, but cannot replay an
      // already-concluded Comparator / Switch / Memory result.
      completedPath: path,
    };
  });
}

function eventMatches(event, selection, fullRange) {
  if (!fullRange && (event.timestamp === null || event.timestamp < selection.start || event.timestamp >= selection.end)) return false;
  if (selection.componentId && !event.path.includes(selection.componentId)) return false;
  if (selection.eventType === 'accepted' && !event.accepted || selection.eventType === 'filtered' && event.accepted) return false;
  if (selection.eventType && !['all', 'accepted', 'filtered'].includes(selection.eventType) && event.kind !== selection.eventType) return false;
  if (selection.address && event.address !== selection.address && !event.accounts.includes(selection.address)) return false;
  return true;
}

/**
 * Deterministic, read-only presentation data. No network, clocks, random values,
 * polling or engine changes. Use the same selected Trace on every page.
 *
 * `rangeStart` / `rangeEnd` are UTC milliseconds, [start,end). Selecting a
 * subrange filters inputs; it never recomputes a window's route or baseline.
 * Grid and waveform retain all window bins and expose `selected` for brushing.
 * `count` / waveform values are null for unknown coverage; observed lower
 * bounds remain in acceptedCount / observedInputCount for transparent display.
 */
export function buildInstrumentModel(trace, options = {}) {
  if (!trace?.window || !validTime(trace.window.start) || !validTime(trace.window.end) || trace.window.end <= trace.window.start || !Array.isArray(trace.inputs) || !Array.isArray(trace.validInputs)) return unavailable(options);
  const source = sourceModel(trace, options), window = trace.window;
  const requestedStart = validTime(options.rangeStart) ? options.rangeStart : window.start;
  const requestedEnd = validTime(options.rangeEnd) ? options.rangeEnd : window.end;
  const start = Math.max(window.start, Math.min(window.end, requestedStart));
  const end = Math.max(start, Math.min(window.end, requestedEnd));
  const fullRange = start === window.start && end === window.end;
  const componentId = componentNames.includes(options.componentId) ? options.componentId : null;
  const selection = { start, end, startUtc: iso(start), endUtc: iso(end), componentId, eventType: options.eventType || 'all', address: typeof options.address === 'string' ? options.address.trim() : '', rangeActive: !fullRange };
  const complete = trace.status === 'final' && trace.coverage === 'complete' && trace.parsingComplete === true;
  const allEvents = inputEvents(trace, source);
  const rangeEvents = allEvents.filter(event => fullRange || event.timestamp !== null && event.timestamp >= start && event.timestamp < end);
  const acceptedEvents = rangeEvents.filter(event => event.accepted);
  const filteredEvents = rangeEvents.filter(event => !event.accepted);
  const processing = [rangeEvents.length, rangeEvents.length, acceptedEvents.length, trace.status === 'final' ? 1 : 0, trace.status === 'final' ? 1 : 0, trace.status === 'final' ? 1 : 0];
  const maximum = Math.max(...processing, 1);
  const components = COMPONENTS.map((component, index) => {
    const step = trace.steps?.find(item => item.id === component.id);
    const inputCount = index < 2 ? rangeEvents.length : acceptedEvents.length;
    const outputCount = index === 0 ? rangeEvents.length : acceptedEvents.length;
    const relativeActivity = processing[index] / maximum;
    return {
      ...component, selected: component.id === componentId, inputCount, outputCount,
      processCount: processing[index], unit: processUnits[index], relativeActivity,
      level: processing[index] === 0 ? 'idle' : relativeActivity > .66 ? 'high' : relativeActivity > .33 ? 'medium' : 'low',
      status: step?.status || trace.status,
      detail: step?.detail || null,
      windowInputCount: step?.inputCount ?? null, windowOutputCount: step?.outputCount ?? null,
      // The last three are whole-window work, not operations per Pulse. A range
      // selection does not invent another comparison, route or saved record.
      wholeWindow: index >= 3,
    };
  });
  const duration = window.end - window.start;
  const requestedBucket = Number.isSafeInteger(options.bucketMs) && options.bucketMs > 0 ? options.bucketMs : Math.max(1_000, Math.ceil(duration / 12 / 1_000) * 1_000);
  const bucketMs = Math.max(requestedBucket, Math.ceil(duration / (MAX_BUCKETS - 1)));
  const first = Math.floor(window.start / bucketMs) * bucketMs;
  const bins = [];
  for (let bucketStart = first; bucketStart < window.end && bins.length < MAX_BUCKETS; bucketStart += bucketMs) {
    const bucketEnd = Math.min(MAX_DATE, bucketStart + bucketMs);
    const visibleStart = Math.max(bucketStart, window.start), visibleEnd = Math.min(bucketEnd, window.end);
    const rows = allEvents.filter(event => event.timestamp !== null && event.timestamp >= visibleStart && event.timestamp < visibleEnd);
    const acceptedCount = rows.filter(event => event.accepted).length;
    bins.push({
      id: `${trace.id}:bucket:${bucketStart}`, start: visibleStart, end: visibleEnd,
      startUtc: iso(visibleStart), endUtc: iso(visibleEnd), utcBucketStart: bucketStart,
      observedInputCount: rows.length, acceptedCount, filteredCount: rows.length - acceptedCount,
      count: complete ? acceptedCount : null, inputValue: complete ? rows.length : null, acceptedValue: complete ? acceptedCount : null,
      coverage: complete ? 'complete' : trace.coverage === 'missing' ? 'missing' : 'unknown',
      complete, selected: visibleStart < end && visibleEnd > start,
      partialBucket: visibleStart !== bucketStart || visibleEnd !== bucketEnd,
    });
  }
  const bucketMaximum = Math.max(...bins.map(bin => bin.acceptedCount), 1);
  const activityGrid = bins.map(bin => ({ ...bin, intensity: complete ? bin.acceptedCount / bucketMaximum : null, observedIntensity: bin.acceptedCount / bucketMaximum }));
  const waveform = {
    unit: 'Pulse / bucket', axis: DISPLAY_TIME_ZONE, bucketMs,
    range: { start, end }, bins: activityGrid,
    series: [
      { id: 'input', label: 'Timestamped inputs', unit: 'Pulse / bucket', selectedCount: rangeEvents.filter(event => event.inWindow).length, values: activityGrid.map(bin => ({ timestamp: bin.start, end: bin.end, value: bin.inputValue, observedValue: bin.observedInputCount, selected: bin.selected, complete: bin.complete })) },
      { id: 'accepted', label: 'Accepted after filtering', unit: 'Pulse / bucket', selectedCount: acceptedEvents.filter(event => event.inWindow).length, values: activityGrid.map(bin => ({ timestamp: bin.start, end: bin.end, value: bin.acceptedValue, observedValue: bin.acceptedCount, selected: bin.selected, complete: bin.complete })) },
    ],
  };
  const bucketedInputCount = allEvents.filter(event => event.inWindow).length;
  return {
    available: true, traceId: trace.id, source,
    window: { start: window.start, end: window.end, startUtc: iso(window.start), endUtc: iso(window.end), durationMs: duration },
    range: { start, end, startUtc: iso(start), endUtc: iso(end) },
    coverage: { state: trace.coverage, complete, parsingComplete: trace.parsingComplete === true },
    selection,
    metrics: { inputCount: rangeEvents.length, acceptedCount: acceptedEvents.length, filteredCount: filteredEvents.length, bucketedInputCount, unbucketedInputCount: allEvents.length - bucketedInputCount, intensityLabel: 'Relative processing activity · no hardware temperature or compute claim' },
    components, activityGrid, bins: activityGrid, waveform,
    events: allEvents.filter(event => eventMatches(event, selection, fullRange)), allEvents,
    result: { path: trace.path, status: trace.status, wholeWindow: true, baselineAverage: trace.baselineAverage, baselineReady: trace.baselineReady, growthRatio: trace.growthRatio, rulesVersion: trace.rulesVersion, reason: trace.reason, baselineReason: trace.baselineReason },
  };
}

/** Shared inspector/topology readout. Range counts never change whole-window decisions. */
export function resolveComponentReadout(trace, model, componentId) {
  const component = model.components.find(item => item.id === componentId);
  const step = trace?.steps?.find(item => item.id === componentId);
  const selection = Boolean(model.selection.rangeActive && component && !component.wholeWindow);
  return {
    inputCount: selection ? component.inputCount : step?.inputCount ?? null,
    outputCount: selection ? component.outputCount : step?.outputCount ?? null,
    status: step?.status ?? 'NO WINDOW',
    rangeSelected: selection,
    scope: selection ? 'selected Eastern range' : 'whole window',
    detail: selection
      ? `Selected range ${formatEasternRange(model.range.start,model.range.end)}. ${displayTimeDescription(step?.detail || '')} Whole-window route remains ${trace?.path || 'pending'}.`
      : step?.detail == null ? null : displayTimeDescription(step.detail),
  };
}
