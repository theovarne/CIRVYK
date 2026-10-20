/** Bounded, read-only Solana account observation. No trading or signing methods. */
import { SITE } from '../public/config/site.js';

const NETWORKS = Object.freeze({
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
  devnet: 'https://api.devnet.solana.com',
  testnet: 'https://api.testnet.solana.com',
});
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const TOKEN_PROGRAMS = new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);
const LIMITS = Object.freeze({ accounts: 4, pagesPerAccount: 3, pageSize: 50, transactionsPerCheck: 150, concurrency: 3, retries: 2, cursors: 100, cursorTTL: 30 * 60_000, minPollMs: 12_000 });
const iso = (time) => Number.isFinite(time) ? new Date(time).toISOString() : null;
const isTime = (value) => Number.isSafeInteger(value) && value > 0;

function base58Bytes(value) {
  if (typeof value !== 'string' || !value.length || value.length > 90) return -1;
  let number = 0n;
  for (const letter of value) {
    const index = BASE58.indexOf(letter);
    if (index < 0) return -1;
    number = number * 58n + BigInt(index);
  }
  let bytes = 0;
  while (number) { bytes++; number >>= 8n; }
  let leadingZeroes = 0;
  while (value[leadingZeroes] === '1') leadingZeroes++;
  return bytes + leadingZeroes;
}

export const isPublicKey = (value) => base58Bytes(value) === 32;
export const isSignature = (value) => base58Bytes(value) === 64;

function scopeHash(value) {
  let hash = 2166136261;
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function configuration(env = {}) {
  const network = env.CIRCUIT_NETWORK || SITE.token.network || 'mainnet-beta';
  const mint = String(env.CIRCUIT_MINT || SITE.token.mint || '').trim();
  const rawAccounts = String(env.CIRCUIT_OBSERVED_ACCOUNTS || SITE.observation.accounts || '').trim();
  const observedAccounts = [...new Set(rawAccounts.split(/[\s,]+/).filter(Boolean))];
  const errors = [];
  if (!(network in NETWORKS)) errors.push('CIRCUIT_NETWORK must be mainnet-beta, devnet, or testnet.');
  if (mint && !isPublicKey(mint)) errors.push('CIRCUIT_MINT is not a 32-byte base58 public key.');
  if (observedAccounts.some((account) => !isPublicKey(account))) errors.push('CIRCUIT_OBSERVED_ACCOUNTS contains an invalid public key.');
  if (observedAccounts.length > LIMITS.accounts) errors.push(`At most ${LIMITS.accounts} observed accounts are supported.`);
  const missing = [!mint && 'CIRCUIT_MINT', !observedAccounts.length && 'CIRCUIT_OBSERVED_ACCOUNTS'].filter(Boolean);
  const configured = !missing.length && !errors.length;
  const safeAccounts = observedAccounts.filter(isPublicKey).slice(0, LIMITS.accounts);
  const scope = {
    id: `solana-${scopeHash(JSON.stringify([network, isPublicKey(mint) ? mint : null, safeAccounts]))}`,
    mint: isPublicKey(mint) ? mint : null,
    network: network in NETWORKS ? network : 'mainnet-beta',
    source: 'Solana JSON-RPC',
    observedAccounts: safeAccounts,
    description: 'Finalized transactions involving only the explicitly configured observed accounts; this is not all activity for the mint.',
  };
  let rpcURL = env.SOLANA_RPC_URL || NETWORKS[scope.network];
  try {
    const parsed = new URL(rpcURL);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))) throw new Error();
  } catch { errors.push('SOLANA_RPC_URL must be a server-configured HTTPS endpoint.'); }
  return { configured: configured && !errors.length, missing, errors, scope, rpcURL, apiKey: env.SOLANA_RPC_API_KEY || null };
}

/** Deliberately omits RPC URLs and API keys, including keys embedded in URLs. */
export function getPublicObservationConfig(env = {}) {
  const config = configuration(env);
  return {
    status: config.errors.length ? 'invalid_configuration' : config.configured ? 'configured' : 'unconfigured',
    scope: config.scope,
    missing: config.missing,
    errors: config.errors,
    pollingMs: Number.isFinite(SITE.observation.pollMs) && SITE.observation.pollMs > 0 ? SITE.observation.pollMs : 15_000,
    limits: { ...LIMITS },
  };
}

function tokenAmount(balance) {
  const amount = balance?.uiTokenAmount?.amount;
  return typeof amount === 'string' && /^\d+$/.test(amount) ? BigInt(amount) : null;
}

/** A successful parsed token transfer or a real target-mint balance delta is evidence. */
export function parseObservedTransaction(transaction, signature, scope) {
  if (!transaction) return { pending: 'Transaction is not available from the provider yet.' };
  if (!transaction.meta || !transaction.transaction?.message) return { pending: 'Transaction metadata is incomplete.' };
  if (transaction.meta.err) return { filtered: 'Transaction failed on-chain.' };
  if (!Number.isSafeInteger(transaction.slot) || transaction.slot < 0 || !isTime(transaction.blockTime)) return { pending: 'Transaction slot or UTC block time is unavailable.' };
  const timestamp = transaction.blockTime * 1000;
  const message = transaction.transaction.message;
  const keys = (message.accountKeys || []).map((key) => typeof key === 'string' ? key : key?.pubkey);
  const before = transaction.meta.preTokenBalances;
  const after = transaction.meta.postTokenBalances;
  if (!Array.isArray(before) || !Array.isArray(after)) return { pending: 'Token balance metadata is missing; the target mint cannot be reconciled.' };
  const targetBalances = [...before, ...after].filter((balance) => balance.mint === scope.mint);
  if (!targetBalances.length) return { filtered: 'No target-mint token balance evidence in this transaction.' };
  const byIndex = new Map();
  const related = new Set();
  let changed = false;
  for (const balance of targetBalances) {
    if (!Number.isInteger(balance.accountIndex) || !isPublicKey(keys[balance.accountIndex]) || tokenAmount(balance) === null) return { pending: 'Target-mint token balance metadata could not be parsed.' };
    const key = keys[balance.accountIndex];
    byIndex.set(key, scope.mint);
    related.add(key);
    if (isPublicKey(balance.owner)) related.add(balance.owner);
  }
  for (const index of new Set(targetBalances.map((balance) => balance.accountIndex))) {
    const pre = before.find((balance) => balance.accountIndex === index && balance.mint === scope.mint);
    const post = after.find((balance) => balance.accountIndex === index && balance.mint === scope.mint);
    if ((pre ? tokenAmount(pre) : 0n) !== (post ? tokenAmount(post) : 0n)) changed = true;
  }
  const instructions = [
    ...(message.instructions || []),
    ...(transaction.meta.innerInstructions || []).flatMap((entry) => entry.instructions || []),
  ];
  let verifiedTransfer = false;
  for (const instruction of instructions) {
    if (!TOKEN_PROGRAMS.has(instruction.programId)) continue;
    const { type, info } = instruction.parsed || {};
    if (!info || !['transfer', 'transferChecked'].includes(type)) continue;
    const amount = type === 'transferChecked' ? info.tokenAmount?.amount : info.amount;
    if (typeof amount !== 'string' || !/^\d+$/.test(amount) || BigInt(amount) <= 0n) continue;
    const sourceMatches = byIndex.get(info.source) === scope.mint;
    const destinationMatches = byIndex.get(info.destination) === scope.mint;
    const mintMatches = type === 'transferChecked' ? info.mint === scope.mint : sourceMatches && destinationMatches;
    if (mintMatches && (sourceMatches || destinationMatches)) verifiedTransfer = true;
  }
  if (!changed && !verifiedTransfer) return { filtered: 'No supported target-mint transfer or token balance change.' };
  return { pulse: {
    id: `${signature}:${scope.mint}`,
    signature,
    mint: scope.mint,
    slot: transaction.slot,
    timestamp,
    kind: verifiedTransfer ? 'Transfer' : 'Activity',
    source: 'live',
    accounts: [...related].sort(),
    verified: true,
    scopeId: scope.id,
  } };
}

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });

async function concurrentMap(items, concurrency, task) {
  let index = 0;
  const output = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) { const position = index++; output[position] = await task(items[position]); }
  }));
  return output;
}

/** Factory makes clocks and state independent in deterministic fixture tests. */
export function createObservationHandler({ now = Date.now, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), minPollMs = LIMITS.minPollMs } = {}) {
  const cursors = new Map();
  const requests = new Map();
  let serial = 0;
  function storeCursor(state) {
    for (const [token, entry] of cursors) if (now() - entry.savedAt > LIMITS.cursorTTL) cursors.delete(token);
    while (cursors.size >= LIMITS.cursors) cursors.delete(cursors.keys().next().value);
    const token = `${now().toString(36)}-${(++serial).toString(36)}-${globalThis.crypto?.randomUUID?.() || scopeHash(String(now()) + serial)}`;
    cursors.set(token, { savedAt: now(), state: structuredClone(state) });
    return token;
  }
  return async function observation(request, env = {}, fetcher = globalThis.fetch) {
    if (request.method !== 'GET') return json({ error: 'Only GET is supported.' }, 405, { Allow: 'GET' });
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((key) => key !== 'cursor') || url.searchParams.getAll('cursor').length > 1) return json({ error: 'Only one optional cursor parameter is accepted.' }, 400);
    const cursor = url.searchParams.get('cursor');
    if (cursor !== null && (!/^[A-Za-z0-9-]{1,128}$/.test(cursor))) return json({ error: 'Invalid cursor.' }, 400);
    const config = configuration(env);
    const base = { status: 'unconfigured', scope: config.scope, lastChecked: null, latestEventUTC: null, pulses: [], coverage: 'unavailable', pending: { count: 0, reasons: [] }, cursor: null, reconciledFrom: null, reconciledUntil: null, filtered: [] };
    if (!config.configured) return json({ ...base, status: config.errors.length ? 'invalid_configuration' : 'unconfigured', missing: config.missing, error: config.errors.length ? config.errors.join(' ') : 'Configure a target mint and at least one observed account to enable live observation.' });
    let state;
    if (cursor) {
      const entry = cursors.get(cursor);
      if (!entry || now() - entry.savedAt > LIMITS.cursorTTL || entry.state.scopeId !== config.scope.id) return json({ ...base, status: 'cursor_expired', error: 'Observation cursor expired or changed scope. Restart observation without a cursor.' }, 409);
      state = structuredClone(entry.state);
    } else {
      state = { scopeId: config.scope.id, rangeStart: Math.floor(now() / 60_000) * 60_000 - 8 * 60_000, accounts: config.scope.observedAccounts.map((account) => ({ account, anchor: null, before: null, head: null, targetUntil: null, coveredUntil: null })), pending: {}, latestEvent: null };
    }
    const requestKey = `${config.scope.id}:${scopeHash(config.rpcURL + (config.apiKey || ''))}`;
    const previous = requests.get(requestKey);
    // A cached incremental batch belongs to its input cursor. Giving it to a
    // different browser/cursor could incorrectly imply that missing inputs were zero.
    if (previous?.inflight && previous.inputCursor === cursor) return json(await previous.inflight, 200, { 'X-Circuit-Cache': 'inflight' });
    if (previous?.result && previous.inputCursor === cursor && now() - previous.checkedAt < minPollMs) return json(previous.result, 200, { 'X-Circuit-Cache': 'hit' });
    if (previous?.inflight || (previous && now() - previous.checkedAt < minPollMs)) return json({ ...base, status: 'rate_limited', error: 'Observation request rate limit reached. Retain the previous result and retry after 12 seconds.' }, 429, { 'Retry-After': '12' });
    const running = (async () => {
      const errors = new Set();
      const filtered = [];
      const pulses = new Map();
      let scannedAny = false;
      let rpcCalls = 0;
      async function rpc(method, params) {
        for (let attempt = 0; attempt <= LIMITS.retries; attempt++) {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 8_000);
          try {
            rpcCalls++;
            const response = await fetcher(config.rpcURL, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: rpcCalls, method, params }), signal: controller.signal });
            if (!response.ok) throw new Error(response.status === 429 ? 'Provider rate limit reached.' : `RPC returned HTTP ${response.status}.`);
            const payload = await response.json();
            if (payload.error || !Object.hasOwn(payload, 'result')) throw new Error('Provider returned an RPC error.');
            return payload.result;
          } catch (error) {
            if (attempt === LIMITS.retries) throw new Error(error?.name === 'AbortError' ? 'RPC request timed out.' : /^RPC returned HTTP \d+\.$/.test(error.message) || ['Provider rate limit reached.', 'Provider returned an RPC error.'].includes(error.message) ? error.message : 'RPC request failed.');
            await pause((attempt + 1) * 100);
          } finally { clearTimeout(timeout); }
        }
      }
      let finalizedUntil = null;
      let finalizedSlot = null;
      try {
        const slot = await rpc('getSlot', [{ commitment: 'finalized' }]);
        if (!Number.isSafeInteger(slot) || slot < 0) throw new Error('Finalized slot was unavailable.');
        finalizedSlot = slot;
        const blockTime = await rpc('getBlockTime', [slot]);
        if (!isTime(blockTime) || blockTime * 1000 > now() + 30_000) throw new Error('Finalized UTC boundary was unavailable.');
        finalizedUntil = blockTime * 1000;
        if (finalizedUntil < state.rangeStart) errors.add('Finalized UTC boundary is older than the observation lookback.');
      } catch (error) { errors.add(error.message); }
      let transactionBudget = LIMITS.transactionsPerCheck;
      async function resolvePending() {
        const batch = Object.values(state.pending).slice(0, transactionBudget);
        transactionBudget -= batch.length;
        await concurrentMap(batch, LIMITS.concurrency, async (record) => {
          try {
            const transaction = await rpc('getTransaction', [record.signature, { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]);
            const result = parseObservedTransaction(transaction, record.signature, config.scope);
            if (result.pending) { state.pending[record.signature].reason = result.pending; return; }
            delete state.pending[record.signature];
            if (result.filtered) filtered.push({ signature: record.signature, reason: result.filtered });
            if (result.pulse && result.pulse.timestamp >= state.rangeStart) {
              pulses.set(result.pulse.id, result.pulse);
              state.latestEvent = Math.max(state.latestEvent || 0, result.pulse.timestamp);
            }
          } catch (error) { state.pending[record.signature].reason = error.message; }
        });
      }
      await resolvePending();
      // Drain existing unresolved work before accepting another large signature batch.
      if (!Object.keys(state.pending).length) {
        await concurrentMap(state.accounts, LIMITS.concurrency, async (accountState) => {
          let complete = false;
          if (!accountState.before) accountState.targetUntil = finalizedUntil;
          try {
            for (let page = 0; page < LIMITS.pagesPerAccount; page++) {
              const options = { limit: LIMITS.pageSize, commitment: 'finalized', ...(finalizedSlot !== null ? { minContextSlot: finalizedSlot } : {}), ...(accountState.before ? { before: accountState.before } : {}) };
              const entries = await rpc('getSignaturesForAddress', [accountState.account, options]);
              if (!Array.isArray(entries)) throw new Error('Signature page was malformed.');
              if (entries.length > LIMITS.pageSize || entries.some((entry) => !isSignature(entry.signature))) throw new Error('Signature page failed validation.');
              scannedAny = true;
              if (!accountState.head && entries.length) accountState.head = entries[0].signature;
              for (const entry of entries) {
                if (entry.signature === accountState.anchor) { complete = true; break; }
                if (isTime(entry.blockTime) && entry.blockTime * 1000 < state.rangeStart) { complete = true; break; }
                if (entry.err) { filtered.push({ signature: entry.signature, reason: 'Transaction failed on-chain.' }); continue; }
                if (!state.pending[entry.signature]) state.pending[entry.signature] = { signature: entry.signature, timestamp: isTime(entry.blockTime) ? entry.blockTime * 1000 : null, reason: 'Transaction parsing is queued.' };
              }
              if (!entries.length || entries.length < LIMITS.pageSize) {
                if (accountState.anchor && !complete) errors.add('The previous signature anchor was not found; account history may be incomplete.');
                else complete = true;
              }
              if (complete) break;
              if (entries.length) accountState.before = entries.at(-1).signature;
              if (!entries.length) break;
            }
            if (complete) {
              accountState.coveredUntil = Math.max(accountState.coveredUntil || 0, accountState.targetUntil || 0) || null;
              accountState.anchor = accountState.head || accountState.anchor;
              accountState.before = null;
              accountState.head = null;
              accountState.targetUntil = null;
            } else errors.add('Account pagination is incomplete; the next check resumes the saved page boundary.');
          } catch (error) { errors.add(error.message); }
        });
        await resolvePending();
      } else errors.add('Unresolved transactions must be reconciled before the next account scan.');
      const unresolved = Object.values(state.pending);
      for (const record of unresolved) errors.add(record.reason);
      const allAccountsCovered = state.accounts.every((account) => Number.isFinite(account.coveredUntil));
      let reconciledUntil = allAccountsCovered ? Math.min(...state.accounts.map((account) => account.coveredUntil)) : null;
      if (reconciledUntil !== null) {
        if (unresolved.some((record) => record.timestamp === null)) reconciledUntil = null;
        else if (unresolved.length) reconciledUntil = Math.min(reconciledUntil, ...unresolved.map((record) => record.timestamp));
        if (reconciledUntil !== null && reconciledUntil < state.rangeStart) reconciledUntil = null;
      }
      const complete = !errors.size && !unresolved.length && finalizedUntil !== null && allAccountsCovered && state.accounts.every((account) => !account.before);
      const result = {
        ...base,
        status: finalizedUntil === null && !pulses.size ? 'error' : 'live',
        lastChecked: iso(now()),
        latestEventUTC: iso(state.latestEvent),
        pulses: [...pulses.values()].sort((a, b) => a.timestamp - b.timestamp || a.signature.localeCompare(b.signature)),
        coverage: complete ? 'complete' : scannedAny || reconciledUntil !== null || pulses.size || unresolved.length ? 'partial' : 'unavailable',
        pending: { count: unresolved.length, reasons: [...errors] },
        cursor: storeCursor(state),
        reconciledFrom: reconciledUntil !== null ? iso(state.rangeStart) : null,
        reconciledUntil: iso(reconciledUntil),
        finalizedUntil: iso(finalizedUntil),
        filtered,
        limits: { ...LIMITS },
        ...(errors.size ? { error: [...errors].join(' ') } : {}),
      };
      requests.set(requestKey, { checkedAt: now(), inputCursor: cursor, result });
      while (requests.size > 20) requests.delete(requests.keys().next().value);
      return result;
    })();
    requests.set(requestKey, { checkedAt: now(), inputCursor: cursor, inflight: running });
    try { return json(await running); }
    catch { requests.delete(requestKey); return json({ ...base, status: 'error', lastChecked: iso(now()), error: 'Observation could not be completed. Retry to resume.' }, 502); }
  };
}

export const handleObservation = createObservationHandler();
