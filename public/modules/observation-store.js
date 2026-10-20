import { finalizeWindow, stableStringify, RULES } from './engine.js';
import { MEMORY_LIMITS } from '../config/rules.js';
import { SITE } from '../config/site.js';

const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const sortedInputs = inputs => [...inputs].sort((a, b) => a.timestamp - b.timestamp || a.signature.localeCompare(b.signature));
const safeMessage = (message, fallback) => typeof message === 'string' && message ? message.slice(0, 600) : fallback;
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

function sourceFrom(scope = {}) {
  return {
    mode: 'live', label: 'Live observation · Solana JSON-RPC',
    network: scope.network || 'mainnet-beta', mint: scope.mint || null,
    accounts: Array.isArray(scope.observedAccounts) ? [...scope.observedAccounts] : [],
    scopeId: scope.id || 'unconfigured-live-observation',
  };
}

function normalizePulse(pulse, source) {
  if (!pulse || pulse.source !== 'live' || pulse.verified !== true || pulse.mint !== source.mint || pulse.scopeId !== source.scopeId ||
      !SIGNATURE.test(pulse.signature || '') || !ADDRESS.test(pulse.mint || '') ||
      !Number.isSafeInteger(pulse.timestamp) || pulse.timestamp < 0 || !Number.isSafeInteger(pulse.slot) || pulse.slot < 0 ||
      !RULES.supportedKinds.includes(pulse.kind)) return null;
  return {
    id: `${pulse.signature}:${pulse.mint}`, signature: pulse.signature, mint: pulse.mint,
    slot: pulse.slot, timestamp: pulse.timestamp, kind: pulse.kind, source: 'live',
    ...(ADDRESS.test(pulse.address || '') ? { address: pulse.address } : {}),
    accounts: Array.isArray(pulse.accounts) ? [...new Set(pulse.accounts.filter(value => ADDRESS.test(value)))].sort() : [],
    verified: true, scopeId: pulse.scopeId,
  };
}

/** One controller is shared by Home and Circuit; examples never enter this store. */
export class ObservationStore {
  constructor({ fetcher = globalThis.fetch, onChange = () => {}, onTrace = () => {}, clock = Date.now, document = globalThis.document, pollMs = SITE.observation.pollMs || 15_000, maxInputs = SITE.observation.retainedInputs || 4_000 } = {}) {
    this.fetcher = fetcher.bind(globalThis);
    this.onChange = onChange;
    this.onTrace = onTrace;
    this.clock = clock;
    this.document = document;
    this.pollMs = Number.isFinite(pollMs) && pollMs > 0 ? pollMs : 15_000;
    this.maxInputs = Math.max(1, Math.min(MEMORY_LIMITS.maxInputsPerTrace, Number.isSafeInteger(maxInputs) ? maxInputs : 4_000));
    this.state = { status: 'idle', config: null, lastChecked: null, lastSuccess: null, latestEvent: null, error: null, pending: { count: 0, reasons: [] }, pulses: [], trace: null, traces: [], coverage: 'unavailable', cursor: null };
    this._listeners = new Set();
    this._inputs = new Map();
    this._intervals = [];
    this._final = new Map();
    this._lowerWatermark = 0;
    this._retentionNotice = null;
    this._started = false;
    this._timer = null;
    this._inflight = null;
    this._configPromise = null;
    this._startPromise = null;
    this._visibility = () => {
      this._schedule();
      if (this._started && this._visible() && this.state.config?.status === 'configured') void this.refresh();
    };
  }

  subscribe(listener) {
    this._listeners.add(listener);
    listener(this.state);
    return () => this._listeners.delete(listener);
  }

  _emit() {
    for (const listener of [this.onChange, ...this._listeners]) {
      try { listener(this.state); } catch { /* A view callback cannot break observation. */ }
    }
  }

  _visible() { return !this.document || (!this.document.hidden && this.document.visibilityState !== 'hidden'); }

  _schedule() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._started && this._visible() && this.state.config?.status === 'configured') {
      this._timer = setInterval(() => { void this.refresh(); }, this.pollMs);
      this._timer.unref?.();
    }
  }

  async _loadConfig() {
    if (this.state.config) return this.state.config;
    if (this._configPromise) return this._configPromise;
    this.state.status = 'loading';
    this._emit();
    this._configPromise = (async () => {
      const response = await this.fetcher('/api/config', { cache: 'no-store' });
      if (!response.ok) throw new Error('Could not read the observation configuration. Retry to check again.');
      const config = await response.json();
      if (!config || !['configured', 'unconfigured', 'invalid_configuration'].includes(config.status) || !config.scope) throw new Error('The observation configuration was invalid.');
      this.state.config = config;
      this.state.status = config.status === 'configured' ? 'ready' : config.status;
      this.state.error = config.status === 'configured' ? null : safeMessage(config.errors?.join(' '), 'A target mint and observed accounts are required for live observation. Example inputs remain available.');
      this._rebuild();
      this._emit();
      this._schedule();
      return config;
    })();
    try { return await this._configPromise; } finally { this._configPromise = null; }
  }

  start() {
    if (this._started) return this._startPromise || Promise.resolve(this.state);
    this._started = true;
    this.document?.addEventListener?.('visibilitychange', this._visibility);
    this._startPromise = (async () => {
      try {
        await this._loadConfig();
        this._schedule();
        if (this._started && this._visible() && this.state.config?.status === 'configured') await this.refresh();
      } catch (error) { this._failure(error); }
      return this.state;
    })();
    return this._startPromise;
  }

  stop() {
    this._started = false;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this.document?.removeEventListener?.('visibilitychange', this._visibility);
  }

  _failure(error, status = 'error') {
    this.state.status = status;
    this.state.coverage = 'unavailable';
    this.state.error = safeMessage(error?.message, 'Observation failed. Previous data is retained; retry when the connection is available.');
    this._rebuild();
    this._emit();
  }

  refresh() {
    if (this._inflight) return this._inflight;
    this._inflight = (async () => {
      try {
        await this._loadConfig();
        if (this.state.config.status !== 'configured') {
          this._rebuild();
          this._emit();
          return this.state;
        }
        this.state.status = 'checking';
        this._emit();
        for (let attempt = 0; attempt < 2; attempt++) {
          const suffix = this.state.cursor ? `?cursor=${encodeURIComponent(this.state.cursor)}` : '';
          const response = await this.fetcher(`/api/observation${suffix}`, { cache: 'no-store' });
          let body;
          try { body = await response.json(); } catch { throw new Error('Observation returned unreadable data. Previous data is retained.'); }
          if (response.status === 409 && attempt === 0) { this.state.cursor = null; continue; }
          if (!response.ok) {
            this._failure(new Error(safeMessage(body?.error, 'Observation failed. Previous data is retained.')), response.status === 429 ? 'rate_limited' : 'error');
            return this.state;
          }
          if (body.status !== 'live') {
            this._failure(new Error(safeMessage(body.error, 'The data source is unavailable. Previous data is retained.')), body.status || 'error');
            return this.state;
          }
          this._accept(body);
          return this.state;
        }
        return this.state;
      } catch (error) { this._failure(error); return this.state; }
    })();
    this._inflight.finally(() => { this._inflight = null; });
    return this._inflight;
  }

  _accept(body) {
    if (!body.scope?.id || !Array.isArray(body.scope.observedAccounts) || !Array.isArray(body.pulses) || time(body.lastChecked) === null) throw new Error('Observation data did not contain a valid scope, input list, and UTC check time.');
    if (body.scope.id !== this.state.config.scope.id) {
      this._inputs.clear();
      this._intervals = [];
      this._final.clear();
      this._lowerWatermark = 0;
      this._retentionNotice = null;
      this.state.latestEvent = null;
      this.state.config = { ...this.state.config, scope: body.scope };
    }
    const source = sourceFrom(body.scope);
    for (const candidate of body.pulses) {
      const pulse = normalizePulse(candidate, source);
      if (pulse) this._inputs.set(`${pulse.signature}:${pulse.mint}`, pulse);
    }
    const ordered = sortedInputs(this._inputs.values());
    if (ordered.length > this.maxInputs) {
      const removed = ordered.slice(0, ordered.length - this.maxInputs);
      this._lowerWatermark = Math.max(this._lowerWatermark, Math.floor(removed.at(-1).timestamp / RULES.windowMs) * RULES.windowMs + RULES.windowMs);
      for (const pulse of removed) this._inputs.delete(`${pulse.signature}:${pulse.mint}`);
      this._retentionNotice = `Input retention is limited to ${this.maxInputs}. Windows affected by dropped inputs cannot be finalized from this store.`;
    }
    const pendingCount = Number.isSafeInteger(body.pending?.count) && body.pending.count >= 0 ? body.pending.count : null;
    const from = time(body.reconciledFrom), until = time(body.reconciledUntil);
    if (body.coverage === 'complete' && pendingCount === 0 && from !== null && until !== null && until > from) this._addInterval(Math.max(from, this._lowerWatermark), Math.min(until, this.clock()));
    this.state.status = 'live';
    this.state.lastChecked = body.lastChecked;
    this.state.lastSuccess = body.lastChecked;
    const latest = Math.max(time(this.state.latestEvent) || 0, time(body.latestEventUTC) || 0, ...[...this._inputs.values()].map(pulse => pulse.timestamp));
    this.state.latestEvent = latest > 0 ? new Date(latest).toISOString() : null;
    this.state.cursor = typeof body.cursor === 'string' ? body.cursor : null;
    this.state.coverage = this._retentionNotice && body.coverage === 'complete' ? 'partial' : ['complete', 'partial', 'unavailable'].includes(body.coverage) ? body.coverage : 'unavailable';
    this.state.pending = { count: pendingCount ?? 0, reasons: [...(Array.isArray(body.pending?.reasons) ? body.pending.reasons.filter(reason => typeof reason === 'string') : []), ...(this._retentionNotice ? [this._retentionNotice] : [])] };
    this.state.error = body.error ? safeMessage(body.error, '') : null;
    this._rebuild();
    this._emit();
  }

  _addInterval(from, until) {
    if (until <= from) return;
    const merged = [];
    for (const interval of [...this._intervals, [from, until]].sort((a, b) => a[0] - b[0])) {
      const previous = merged.at(-1);
      if (previous && interval[0] <= previous[1]) previous[1] = Math.max(previous[1], interval[1]);
      else merged.push([...interval]);
    }
    this._intervals = merged.slice(-32);
  }

  _proved(start) {
    return start >= this._lowerWatermark && this._intervals.some(([from, until]) => from <= start && until >= start + RULES.windowMs);
  }

  _rebuild() {
    const now = this.clock();
    const source = sourceFrom(this.state.config?.scope);
    const currentStart = Math.floor(now / RULES.windowMs) * RULES.windowMs;
    const oldestStart = currentStart - (30 + RULES.baselineWindows) * RULES.windowMs;
    this._intervals = this._intervals.map(([from, until]) => [Math.max(from, this._lowerWatermark), until]).filter(([from, until]) => until > from);
    for (const [start] of this._final) if (start < oldestStart || start < this._lowerWatermark || start >= currentStart) this._final.delete(start);
    const inputs = sortedInputs(this._inputs.values());
    const baseline = [];
    const updates = [];
    for (let start = oldestStart; start < currentStart; start += RULES.windowMs) {
      if (!this._proved(start)) continue;
      const previous = this._final.get(start);
      const candidate = finalizeWindow({ inputs: inputs.filter(pulse => pulse.timestamp >= start && pulse.timestamp < start + RULES.windowMs), windowStart: start, now, coverage: 'complete', parsingComplete: true, baseline, source });
      const changed = !previous || stableStringify({ ...candidate, observedAt: 0 }) !== stableStringify({ ...previous, observedAt: 0 });
      const trace = changed ? candidate : previous;
      this._final.set(start, trace);
      baseline.push(trace);
      if (changed && start >= currentStart - 30 * RULES.windowMs) updates.push(trace);
    }
    this.state.pulses = inputs;
    this.state.traces = [...this._final.values()].filter(trace => trace.window.start >= currentStart - 30 * RULES.windowMs).sort((a, b) => b.window.start - a.window.start);
    this.state.trace = finalizeWindow({ inputs: inputs.filter(pulse => pulse.timestamp >= currentStart && pulse.timestamp < currentStart + RULES.windowMs), windowStart: currentStart, now, coverage: this.state.config?.status === 'configured' ? 'partial' : 'missing', parsingComplete: false, baseline, source });
    for (const trace of updates) {
      try { this.onTrace(trace); } catch (error) { this.state.error = safeMessage(error?.message, 'A finalized Trace could not be saved in this browser.'); }
    }
  }
}
