// These are display rules. They do not provide trading advice.
// Every rendered path and capacitor scale is derived from this configuration.
export const RULES = Object.freeze({
  version: 'living-circuit.v1',
  windowMs: 60_000,
  baselineWindows: 5,
  surgeMinInputs: 10,
  surgeMultiplier: 2,
  supportedKinds: Object.freeze(['Activity', 'Transfer']),
});

export const MEMORY_LIMITS = Object.freeze({
  maxRecords: 30,
  maxBytes: 3 * 1024 * 1024,
  maxInputsPerTrace: 5_000,
});
