import { BRAND_NAME } from '../config/site.js';
import { RULES, MEMORY_LIMITS } from '../config/rules.js';

export { RULES };
export const TRACE_SCHEMA = 'circuit.trace.v1';
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE58_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const PATHS = ['QUIET', 'FLOW', 'SURGE'];
const MAX_DATE_MS = 8_640_000_000_000_000;
const COVERAGES = ['complete', 'partial', 'missing'];
const SOURCE_KEYS = ['mode', 'label', 'network', 'mint', 'accounts', 'scopeId'];
const INPUT_KEYS = ['id', 'signature', 'mint', 'slot', 'timestamp', 'kind', 'source', 'address', 'accounts', 'verified', 'scopeId'];

export const COMPONENTS = Object.freeze([
  { id: 'sensor', name: 'Sensor', label: '01 / INPUT', responsibility: 'Receives supported inputs from the stated observation scope.' },
  { id: 'resistor', name: 'Resistor', label: '02 / FILTER', responsibility: 'Deduplicates transactions and records why inputs are filtered.' },
  { id: 'capacitor', name: 'Capacitor', label: '03 / ACCUMULATE', responsibility: 'Accumulates valid inputs in one UTC-aligned window.' },
  { id: 'comparator', name: 'Comparator', label: '04 / COMPARE', responsibility: 'Compares the window with five preceding complete windows.' },
  { id: 'switch', name: 'Switch', label: '05 / ROUTE', responsibility: 'Selects one predefined display path from verified window results.' },
  { id: 'memory', name: 'Memory', label: '06 / RECORD', responsibility: 'Keeps inputs, baseline evidence, rules, and the result for replay.' },
].map(Object.freeze));

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isInteger = value => Number.isSafeInteger(value) && value >= 0;
const text = (value, fallback = '') => typeof value === 'string' ? value : fallback;
const copyRules = rules => ({ version: rules.version, windowMs: rules.windowMs, baselineWindows: rules.baselineWindows, surgeMinInputs: rules.surgeMinInputs, surgeMultiplier: rules.surgeMultiplier, supportedKinds: [...rules.supportedKinds] });

/** A stable JSON representation, also used to verify imported records. */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function hash(value) {
  // Two deterministic 32-bit hashes; this is an identity aid, not a security hash.
  let a = 2166136261, b = 5381;
  for (let i = 0; i < value.length; i++) {
    a = Math.imul(a ^ value.charCodeAt(i), 16777619) >>> 0;
    b = (Math.imul(b, 33) ^ value.charCodeAt(i)) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

function normalizeSource(source = {}) {
  const normalized = {
    mode: source.mode === 'example' ? 'example' : 'live',
    label: text(source.label, source.mode === 'example' ? 'Example inputs' : 'Live observation'),
    network: text(source.network, source.mode === 'example' ? 'example' : 'solana-mainnet'),
    mint: source.mint == null ? null : text(source.mint),
    accounts: Array.isArray(source.accounts) ? [...new Set(source.accounts.filter(account => typeof account === 'string'))].sort() : [],
  };
  normalized.scopeId = text(source.scopeId) || `scope-${hash(stableStringify(normalized))}`;
  return normalized;
}

function scopeIdentity(source) {
  return { mode: source.mode, network: source.network, mint: source.mint, accounts: source.accounts, scopeId: source.scopeId };
}

function normalizeInput(input) {
  if (!isRecord(input)) return null;
  const normalized = {};
  for (const key of INPUT_KEYS) {
    if (!(key in input)) continue;
    const value = input[key];
    if (key === 'accounts') normalized[key] = Array.isArray(value) ? [...new Set(value.filter(account => typeof account === 'string'))].sort() : [];
    else if (['timestamp', 'slot'].includes(key)) normalized[key] = Number.isFinite(value) ? value : null;
    else if (key === 'verified') normalized[key] = value === true;
    else normalized[key] = typeof value === 'string' ? value : null;
  }
  return normalized;
}

function inputSort(a, b) {
  const time = (a?.timestamp ?? -1) - (b?.timestamp ?? -1);
  return time || stableStringify(a).localeCompare(stableStringify(b));
}

function assertRules(rules) {
  if (!isRecord(rules) || typeof rules.version !== 'string' || !rules.version || rules.version.length > 80 ||
      !isInteger(rules.windowMs) || rules.windowMs < 1_000 || rules.windowMs > 86_400_000 ||
      !isInteger(rules.baselineWindows) || rules.baselineWindows < 1 || rules.baselineWindows > 30 ||
      !isInteger(rules.surgeMinInputs) || rules.surgeMinInputs < 1 || rules.surgeMinInputs > 1_000_000 ||
      !Number.isFinite(rules.surgeMultiplier) || rules.surgeMultiplier < 1 || rules.surgeMultiplier > 100 ||
      !Array.isArray(rules.supportedKinds) || rules.supportedKinds.length === 0 || rules.supportedKinds.some(kind => !['Activity', 'Transfer'].includes(kind))) {
    throw new TypeError('Unsupported display rules.');
  }
}

function filterReason(input, source, window, rules) {
  if (!input) return 'Malformed input';
  if (!isInteger(input.timestamp)) return 'Missing or invalid timestamp';
  if (input.timestamp < window.start || input.timestamp >= window.end) return 'Outside this UTC window';
  if (input.source !== source.mode) return 'Different data source';
  if (input.verified !== true) return 'Input was not verified by the supported parser';
  if (!rules.supportedKinds.includes(input.kind)) return 'Unsupported event type';
  if (input.scopeId && input.scopeId !== source.scopeId) return 'Outside the observation scope';
  if (source.mode === 'example') {
    if (!text(input.id)) return 'Example input needs an id';
    if (input.signature) return 'Example inputs cannot claim transaction signatures';
    return null;
  }
  if (!BASE58_SIGNATURE.test(text(input.signature))) return 'Missing or invalid transaction signature';
  if (!isInteger(input.slot)) return 'Missing or invalid slot';
  if (!BASE58_ADDRESS.test(text(source.mint)) || input.mint !== source.mint) return 'Outside the target mint';
  if (!source.accounts.length) return 'No observation accounts configured';
  return null;
}

function baselineForWindow(baseline, window, source, rules) {
  const evidence = [];
  for (let offset = 1; offset <= rules.baselineWindows; offset++) {
    const requiredStart = window.start - offset * rules.windowMs;
    const candidates = baseline.filter(trace => trace?.schema === TRACE_SCHEMA && trace.status === 'final' && trace.coverage === 'complete' && trace.parsingComplete === true &&
      trace.window?.start === requiredStart && trace.window?.end === requiredStart + rules.windowMs &&
      trace.source?.scopeId === source.scopeId && stableStringify(scopeIdentity(normalizeSource(trace.source))) === stableStringify(scopeIdentity(source)) &&
      trace.rulesVersion === rules.version && stableStringify(trace.rules) === stableStringify(rules) && isInteger(trace.count));
    // A conflicting count for the same fixed window makes the baseline ambiguous.
    if (!candidates.length || new Set(candidates.map(trace => trace.count)).size !== 1) break;
    const trace = [...candidates].sort((a, b) => text(a.id).localeCompare(text(b.id)))[0];
    evidence.unshift({ id: trace.id, window: { start: trace.window.start, end: trace.window.end }, source: { ...source, accounts: [...source.accounts] }, rulesVersion: rules.version, count: trace.count, status: 'final', coverage: 'complete', parsingComplete: true });
  }
  return evidence;
}

/** Pure processing: no random numbers, clocks, network, DOM, or storage. */
export function finalizeWindow({ inputs = [], windowStart, now, coverage = 'missing', parsingComplete = false, baseline = [], source = {}, rules = RULES } = {}) {
  assertRules(rules);
  if (!Array.isArray(inputs) || inputs.length > MEMORY_LIMITS.maxInputsPerTrace) throw new TypeError('Input limit exceeded.');
  if (!Array.isArray(baseline)) throw new TypeError('Baseline must be an array.');
  if (!isInteger(windowStart) || !isInteger(now) || windowStart > MAX_DATE_MS || now > MAX_DATE_MS) throw new TypeError('Window start and current time must be UTC milliseconds within the supported date range.');
  const start = Math.floor(windowStart / rules.windowMs) * rules.windowMs;
  const window = { start, end: start + rules.windowMs, durationMs: rules.windowMs };
  if (window.end > MAX_DATE_MS) throw new TypeError('Window end is outside the supported date range.');
  const normalizedSource = normalizeSource(source);
  const normalizedRules = copyRules(rules);
  const normalizedInputs = inputs.map(normalizeInput).sort(inputSort);
  const validInputs = [], filtered = [], seen = new Set();
  for (const input of normalizedInputs) {
    let reason = filterReason(input, normalizedSource, window, normalizedRules);
    const key = normalizedSource.mode === 'live' ? `${input?.signature}:${input?.mint}` : input?.id;
    if (!reason && seen.has(key)) reason = normalizedSource.mode === 'live' ? 'Duplicate transaction for this mint' : 'Duplicate example input id';
    if (reason) filtered.push({ input, reason });
    else { seen.add(key); validInputs.push(input); }
  }
  const normalizedCoverage = COVERAGES.includes(coverage) ? coverage : 'missing';
  const parsed = parsingComplete === true;
  const scopeConfigured = normalizedSource.mode === 'example' || BASE58_ADDRESS.test(text(normalizedSource.mint)) && normalizedSource.accounts.length > 0 && normalizedSource.accounts.every(account => BASE58_ADDRESS.test(account));
  const status = now < window.end ? 'accumulating' : normalizedCoverage !== 'complete' || !parsed || !scopeConfigured ? 'incomplete' : 'final';
  const count = validInputs.length;
  const baselineEvidence = baselineForWindow(baseline, window, normalizedSource, normalizedRules);
  const baselineReady = baselineEvidence.length === rules.baselineWindows;
  const baselineAverage = baselineReady ? baselineEvidence.reduce((sum, trace) => sum + trace.count, 0) / rules.baselineWindows : null;
  const growthRatio = status === 'final' && baselineReady && baselineAverage > 0 ? count / baselineAverage : null;
  const path = status !== 'final' ? null : count === 0 ? 'QUIET' : baselineReady && count >= rules.surgeMinInputs && count >= baselineAverage * rules.surgeMultiplier ? 'SURGE' : 'FLOW';
  const baselineReason = !baselineReady ? `Needs ${rules.baselineWindows} preceding consecutive complete windows; ${baselineEvidence.length} available.` : baselineAverage === 0 ? 'Baseline average is zero; a finite growth ratio is unavailable.' : 'Compared with preceding consecutive complete windows in this scope.';
  const pendingReason = status === 'accumulating' ? 'Window is still accumulating.' : !scopeConfigured ? 'Live observation scope is not configured; no complete-window conclusion.' : normalizedCoverage !== 'complete' ? `Observation coverage is ${normalizedCoverage}; no complete-window conclusion.` : !parsed ? 'Parsing is not complete; no complete-window conclusion.' : null;
  const steps = COMPONENTS.map((component, index) => ({
    id: component.id, name: component.name, label: component.label,
    inputCount: index <= 1 ? normalizedInputs.length : count,
    outputCount: index === 0 ? normalizedInputs.length : count,
    status: index < 2 ? 'processed' : status === 'final' ? 'complete' : status,
    detail: [
      `${normalizedInputs.length} inputs from ${normalizedSource.label}.`,
      `${count} valid; ${filtered.length} filtered. Deduplication is not a complete anti-abuse system.`,
      `${count} valid inputs in a ${rules.windowMs / 1000}-second UTC window.`,
      pendingReason || baselineReason,
      pendingReason || `${path} selected by ${rules.version}.`,
      pendingReason || 'Final record is ready to save in this browser.',
    ][index],
  }));
  return {
    schema: TRACE_SCHEMA,
    id: `trace-${hash(stableStringify({ source: scopeIdentity(normalizedSource), start, rules: normalizedRules }))}`,
    window, observedAt: now, source: normalizedSource,
    rulesVersion: rules.version, rules: normalizedRules,
    inputs: normalizedInputs, validInputs, filtered, count,
    coverage: normalizedCoverage, parsingComplete: parsed,
    baselineEvidence, baselineReady, baselineAverage, baselineReason, growthRatio,
    path, status, reason: pendingReason,
    progress: Math.max(0, Math.min(1, (now - window.start) / rules.windowMs)),
    steps,
  };
}

/** Fixed fixtures are deliberately separate from live observations. */
export function buildExample(kind = 'single') {
  if (!['single', 'burst', 'flow'].includes(kind)) throw new TypeError('Choose single, burst, or flow.');
  const windowStart = Date.UTC(2026, 9, 16, 0, 5, 0);
  const scenarioName = { single: 'Single pulse', burst: 'Short burst', flow: 'Gradual flow' }[kind];
  const source = { mode: 'example', label: `Example inputs / ${scenarioName}`, network: 'example', mint: null, accounts: [], scopeId: `example-workbench-v1:${kind}` };
  const quantities = { single: 1, burst: 12, flow: 6 };
  const makeInputs = (start, amount, prefix, spacing) => Array.from({ length: amount }, (_, i) => ({ id: `${prefix}-${i + 1}`, timestamp: start + 1000 + i * spacing, kind: 'Activity', source: 'example', verified: true, scopeId: source.scopeId }));
  const baseline = [];
  for (let index = 5; index >= 1; index--) {
    const start = windowStart - index * RULES.windowMs;
    baseline.push(finalizeWindow({ inputs: makeInputs(start, 3, `baseline-${index}`, 1000), windowStart: start, now: start + RULES.windowMs, coverage: 'complete', parsingComplete: true, baseline: [], source }));
  }
  return { inputs: makeInputs(windowStart, quantities[kind], `example-${kind}`, kind === 'burst' ? 350 : kind === 'flow' ? 8500 : 1000), baseline, windowStart, now: windowStart + RULES.windowMs, coverage: 'complete', parsingComplete: true, source, rules: RULES };
}

function validSource(source) {
  return isRecord(source) && Object.keys(source).every(key => SOURCE_KEYS.includes(key)) &&
    ['live', 'example'].includes(source.mode) && typeof source.label === 'string' && source.label.length <= 160 &&
    typeof source.network === 'string' && source.network.length <= 80 && (source.mint === null || typeof source.mint === 'string' && source.mint.length <= 100) &&
    typeof source.scopeId === 'string' && source.scopeId.length > 0 && source.scopeId.length <= 160 &&
    Array.isArray(source.accounts) && source.accounts.length <= 32 && source.accounts.every(account => typeof account === 'string' && account.length <= 100);
}

function validImportedInput(input) {
  if (input === null) return true;
  return isRecord(input) && Object.keys(input).every(key => INPUT_KEYS.includes(key)) && Object.entries(input).every(([key, value]) => {
    if (value === null) return true;
    if (key === 'verified') return typeof value === 'boolean';
    if (key === 'timestamp' || key === 'slot') return typeof value === 'number' && Number.isFinite(value);
    if (key === 'accounts') return Array.isArray(value) && value.length <= 32 && value.every(account => typeof account === 'string' && account.length <= 100);
    return typeof value === 'string' && value.length <= 256;
  });
}

/** Accept data only, then rerun the actual engine and compare every derived field. */
export function validateTrace(value) {
  const errors = [];
  try {
    if (!isRecord(value) || value.schema !== TRACE_SCHEMA) throw new Error(`Not a valid ${BRAND_NAME} Trace.`);
    if (!validSource(value.source)) throw new Error('Invalid source or observation scope.');
    if (!isRecord(value.window) || !isInteger(value.window.start) || !isInteger(value.window.end) || !isInteger(value.observedAt)) throw new Error('Invalid UTC window.');
    assertRules(value.rules);
    if (Object.keys(value.rules).sort().join(',') !== Object.keys(copyRules(value.rules)).sort().join(',')) throw new Error('Unknown rule fields.');
    if (!Array.isArray(value.inputs) || value.inputs.length > MEMORY_LIMITS.maxInputsPerTrace || !value.inputs.every(validImportedInput)) throw new Error('Invalid or oversized input list.');
    if (!COVERAGES.includes(value.coverage) || typeof value.parsingComplete !== 'boolean') throw new Error('Invalid coverage or parsing state.');
    if (!Array.isArray(value.baselineEvidence) || value.baselineEvidence.length > value.rules.baselineWindows) throw new Error('Invalid baseline evidence.');
    const baseline = value.baselineEvidence.map(evidence => {
      if (!isRecord(evidence) || Object.keys(evidence).sort().join(',') !== ['id','window','source','rulesVersion','count','status','coverage','parsingComplete'].sort().join(',') ||
          typeof evidence.id !== 'string' || evidence.id.length > 100 || !isRecord(evidence.window) || Object.keys(evidence.window).sort().join(',') !== 'end,start' ||
          !isInteger(evidence.window.start) || !isInteger(evidence.window.end) || !isInteger(evidence.count) || evidence.count > MEMORY_LIMITS.maxInputsPerTrace ||
          !validSource(evidence.source) || evidence.status !== 'final' || evidence.coverage !== 'complete' || evidence.parsingComplete !== true || evidence.rulesVersion !== value.rules.version) throw new Error('Malformed baseline evidence.');
      return { ...evidence, schema: TRACE_SCHEMA, rules: value.rules };
    });
    const expected = finalizeWindow({ inputs: value.inputs, windowStart: value.window.start, now: value.observedAt, coverage: value.coverage, parsingComplete: value.parsingComplete, baseline, source: value.source, rules: value.rules });
    if (stableStringify(expected) !== stableStringify(value)) throw new Error('Trace does not match the deterministic engine result.');
    if (value.path !== null && !PATHS.includes(value.path)) throw new Error('Invalid display path.');
  } catch (error) { errors.push(error.message || 'Invalid Trace data.'); }
  return { valid: errors.length === 0, errors };
}
