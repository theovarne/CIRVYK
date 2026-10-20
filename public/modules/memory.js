import { MEMORY_LIMITS } from '../config/rules.js';
import { validateTrace } from './engine.js';

export const MEMORY_KEY = 'circuit.traces.v1';
export const MEMORY_SCHEMA = 'circuit.memory.v1';
export { MEMORY_LIMITS };

const bytes = value => new TextEncoder().encode(value).byteLength;
const storageOrNull = storage => storage ?? (typeof globalThis.localStorage !== 'undefined' ? globalThis.localStorage : null);
const envelope = traces => JSON.stringify({ schema: MEMORY_SCHEMA, traces });
const byNewest = (a, b) => b.window.start - a.window.start || a.id.localeCompare(b.id);
const validationError = trace => {
  const result = validateTrace(trace);
  return result.valid ? null : result.errors.join(' ');
};

/** Check a collection before any write, so one window cannot inflate import counts. */
export function assertUniqueImportIds(traces) {
  if (!Array.isArray(traces)) throw new TypeError('Import requires a list of Traces.');
  const ids = new Set();
  for (const trace of traces) {
    if (typeof trace?.id !== 'string' || !trace.id) throw new TypeError('Import contains a Trace without a valid ID.');
    if (ids.has(trace.id)) throw new TypeError('Import contains duplicate Trace IDs.');
    ids.add(trace.id);
  }
  return [...ids];
}

/** Describe what the existing capacity policy actually retained after a batch. */
export function summarizeImportResult(requested, previous, next) {
  const requestedIds = assertUniqueImportIds(requested);
  if (!Array.isArray(previous) || !Array.isArray(next)) throw new TypeError('Import summary requires previous and next Trace lists.');
  const nextIds = new Set(next.map(trace => trace.id));
  return {
    retainedIds: requestedIds.filter(id => nextIds.has(id)),
    notRetainedIds: requestedIds.filter(id => !nextIds.has(id)),
    evictedIds: previous.filter(trace => !nextIds.has(trace.id)).map(trace => trace.id),
  };
}

/** Browser-local records only. This function never fetches data. */
export function loadTraces(storage) {
  try {
    const target = storageOrNull(storage);
    if (!target) return { traces: [], error: 'Browser storage is unavailable.' };
    const raw = target.getItem(MEMORY_KEY);
    if (!raw) return { traces: [], error: null };
    if (bytes(raw) > MEMORY_LIMITS.maxBytes) return { traces: [], error: 'Saved memory exceeds the 3 MB limit.' };
    const data = JSON.parse(raw);
    if (data?.schema !== MEMORY_SCHEMA || Object.keys(data).sort().join(',') !== 'schema,traces' || !Array.isArray(data.traces) || data.traces.length > MEMORY_LIMITS.maxRecords) throw new Error('Invalid saved memory format.');
    const ids = new Set();
    for (const trace of data.traces) {
      const error = validationError(trace);
      if (error) throw new Error(`Saved Trace is invalid: ${error}`);
      if (ids.has(trace.id)) throw new Error('Saved memory contains a duplicate window.');
      ids.add(trace.id);
    }
    return { traces: data.traces.sort(byNewest), error: null };
  } catch (error) {
    return { traces: [], error: `Could not restore this browser's traces: ${error.message}` };
  }
}

/** Upsert the fixed-window id. Late reconciliation replaces its earlier version. */
export function saveTrace(trace, storage) {
  const previous = loadTraces(storage);
  const error = validationError(trace);
  if (error) return { traces: previous.traces, error: `Trace was not saved: ${error}` };
  if (previous.error) return previous;
  try {
    const target = storageOrNull(storage);
    if (!target) return { traces: previous.traces, error: 'Browser storage is unavailable.' };
    if (bytes(envelope([trace])) > MEMORY_LIMITS.maxBytes) return { traces: previous.traces, error: 'This Trace exceeds the 3 MB local memory limit.' };
    let traces = [trace, ...previous.traces.filter(item => item.id !== trace.id)].sort(byNewest);
    const beforeLimit = traces.length;
    traces = traces.slice(0, MEMORY_LIMITS.maxRecords);
    while (traces.length > 1 && bytes(envelope(traces)) > MEMORY_LIMITS.maxBytes) traces.pop();
    // A newly imported old trace may be immediately evicted by the newest-first policy.
    if (!traces.some(item => item.id === trace.id)) return { traces: previous.traces, error: 'This Trace is older than the 30 records currently kept. Remove a record before importing it.' };
    target.setItem(MEMORY_KEY, envelope(traces));
    return { traces, error: null, evictedCount: beforeLimit - traces.length };
  } catch (error) {
    return { traces: previous.traces, error: `Could not save in this browser: ${error.message}` };
  }
}

export function removeTrace(id, storage) {
  const previous = loadTraces(storage);
  if (previous.error) return previous;
  if (typeof id !== 'string') return { traces: previous.traces, error: 'Choose a valid Trace to remove.' };
  try {
    const target = storageOrNull(storage);
    if (!target) return { traces: previous.traces, error: 'Browser storage is unavailable.' };
    const traces = previous.traces.filter(trace => trace.id !== id);
    target.setItem(MEMORY_KEY, envelope(traces));
    return { traces, error: null };
  } catch (error) {
    return { traces: previous.traces, error: `Could not remove the Trace: ${error.message}` };
  }
}

/** Export all inputs and baseline evidence needed by the actual replay engine. */
export function exportTrace(trace) {
  const error = validationError(trace);
  if (error) throw new TypeError(`Cannot export an invalid Trace: ${error}`);
  let json = JSON.stringify(trace, null, 2);
  // A saved record near the cap must remain importable after export. Whitespace is optional.
  if (bytes(json) > MEMORY_LIMITS.maxBytes) json = JSON.stringify(trace);
  if (bytes(json) > MEMORY_LIMITS.maxBytes) throw new TypeError('Trace export exceeds the 3 MB limit.');
  return json;
}

/** Parse plain JSON, strictly validate, recompute, and then save. No evaluation or HTML. */
export function importTrace(json, storage) {
  const previous = loadTraces(storage);
  if (typeof json !== 'string') return { trace: null, traces: previous.traces, error: 'Import requires a JSON text file.' };
  if (bytes(json) > MEMORY_LIMITS.maxBytes) return { trace: null, traces: previous.traces, error: 'Import exceeds the 3 MB limit.' };
  try {
    const trace = JSON.parse(json);
    const error = validationError(trace);
    if (error) return { trace: null, traces: previous.traces, error: `Import rejected: ${error}` };
    const saved = saveTrace(trace, storage);
    return { trace: saved.error ? null : trace, ...saved };
  } catch (error) {
    return { trace: null, traces: previous.traces, error: `Import rejected: ${error.message}` };
  }
}
