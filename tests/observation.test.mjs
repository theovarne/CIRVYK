import test from 'node:test';
import assert from 'node:assert/strict';
import { createObservationHandler, getPublicObservationConfig, isPublicKey, isSignature, parseObservedTransaction } from '../lib/observation.mjs';

function base58(bytes) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let output = '';
  while (value) { output = alphabet[Number(value % 58n)] + output; value /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; output = '1' + output; }
  return output;
}
const key = (number) => base58(Uint8Array.from({ length: 32 }, (_, index) => index === 31 ? number : 2));
const signature = (number) => base58(Uint8Array.from({ length: 64 }, (_, index) => index === 62 ? number >> 8 : index === 63 ? number & 255 : 3));
const MINT = key(1), ACCOUNT = key(2), SOURCE = key(3), DESTINATION = key(4), OWNER = key(5);
const ENV = { CIRCUIT_MINT: MINT, CIRCUIT_OBSERVED_ACCOUNTS: ACCOUNT };
const NOW = 1_780_000_030_000;
const BLOCK_TIME = Math.floor(NOW / 1000) - 5;
const scope = getPublicObservationConfig(ENV).scope;
const request = (cursor = '') => new Request(`https://circuit.example/api/observation${cursor ? `?cursor=${cursor}` : ''}`);
const makeHandler = (clock = () => NOW) => createObservationHandler({ now: clock, pause: async () => {}, minPollMs: 0 });
const balance = (accountIndex, amount, mint = MINT) => ({ accountIndex, mint, owner: OWNER, uiTokenAmount: { amount: String(amount), decimals: 9 } });
function transaction(time = BLOCK_TIME) {
  return {
    slot: 12345,
    blockTime: time,
    meta: { err: null, preTokenBalances: [balance(0, 100), balance(1, 0)], postTokenBalances: [balance(0, 75), balance(1, 25)], innerInstructions: [] },
    transaction: { message: { accountKeys: [{ pubkey: SOURCE }, { pubkey: DESTINATION }], instructions: [
      { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', parsed: { type: 'transfer', info: { source: SOURCE, destination: DESTINATION, amount: '25' } } },
    ] } },
  };
}
function provider(resolver = () => undefined) {
  const calls = [];
  const fetcher = async (url, options) => {
    const input = JSON.parse(options.body);
    calls.push({ url, ...input, headers: options.headers });
    const resolved = await resolver(input.method, input.params, calls);
    const result = resolved === undefined ? input.method === 'getSlot' ? 12399 : input.method === 'getBlockTime' ? BLOCK_TIME : input.method === 'getSignaturesForAddress' ? [] : transaction() : resolved;
    if (result instanceof Response) return result;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }), { status: 200 });
  };
  return { calls, fetcher };
}

test('validates base58 keys by decoded byte length', () => {
  assert.equal(isPublicKey(MINT), true);
  assert.equal(isPublicKey('11111111111111111111111111111111'), true);
  assert.equal(isPublicKey('not-a-mint'), false);
  assert.equal(isSignature(signature(1)), true);
  assert.equal(isSignature(MINT), false);
});

test('missing mint/accounts stays unconfigured without calling the network', async () => {
  const handler = makeHandler();
  const response = await handler(request(), {}, () => { throw new Error('network must not be called'); });
  const body = await response.json();
  assert.equal(body.status, 'unconfigured');
  assert.equal(body.coverage, 'unavailable');
  assert.equal(body.reconciledUntil, null);
  assert.deepEqual(body.pulses, []);
  assert.deepEqual(body.missing, ['CIRCUIT_MINT', 'CIRCUIT_OBSERVED_ACCOUNTS']);
});

test('public config excludes server URLs, URL credentials, and API keys', () => {
  const config = getPublicObservationConfig({ ...ENV, SOLANA_RPC_URL: 'https://provider.example/SECRET-URL', SOLANA_RPC_API_KEY: 'SECRET-KEY' });
  assert.equal(config.status, 'configured');
  assert.ok(!JSON.stringify(config).includes('SECRET'));
  assert.match(config.scope.description, /not all activity/);
  assert.equal(getPublicObservationConfig({ ...ENV, CIRCUIT_MINT: 'bad' }).status, 'invalid_configuration');
  assert.equal(getPublicObservationConfig({ ...ENV, CIRCUIT_OBSERVED_ACCOUNTS: Array.from({ length: 5 }, (_, i) => key(10 + i)).join(',') }).status, 'invalid_configuration');
});

test('fixed GET API rejects arbitrary proxy parameters, duplicate/invalid cursors and POST', async () => {
  const handler = makeHandler();
  for (const url of ['?url=https://example.com', '?method=getBalance', '?cursor=a&cursor=b', '?cursor=' + 'a'.repeat(129), '?cursor=%3Cscript%3E']) {
    assert.equal((await handler(new Request('https://circuit.example/api/observation' + url), ENV)).status, 400);
  }
  assert.equal((await handler(new Request('https://circuit.example/api/observation', { method: 'POST' }), ENV)).status, 405);
  assert.equal((await handler(request('unknown-cursor'), ENV)).status, 409);
});

test('complete empty account history has a real finalized UTC boundary', async () => {
  const rpc = provider();
  const body = await (await makeHandler()(request(), ENV, rpc.fetcher)).json();
  assert.equal(body.status, 'live');
  assert.equal(body.coverage, 'complete');
  assert.equal(body.pulses.length, 0);
  assert.equal(body.reconciledUntil, new Date(BLOCK_TIME * 1000).toISOString());
  assert.equal(body.reconciledFrom, new Date(Math.floor(NOW / 60_000) * 60_000 - 8 * 60_000).toISOString());
  assert.equal(body.lastChecked, new Date(NOW).toISOString());
  assert.deepEqual(rpc.calls.map((call) => call.method), ['getSlot', 'getBlockTime', 'getSignaturesForAddress']);
  assert.equal(rpc.calls.at(-1).params[0], ACCOUNT);
  assert.notEqual(rpc.calls.at(-1).params[0], MINT);
  assert.equal(rpc.calls.at(-1).params[1].minContextSlot, 12399);
});

test('429 retries are bounded and cannot become a complete zero-activity result', async () => {
  const rpc = provider(() => new Response('{}', { status: 429 }));
  const body = await (await makeHandler()(request(), ENV, rpc.fetcher)).json();
  assert.equal(body.status, 'error');
  assert.equal(body.coverage, 'unavailable');
  assert.equal(body.reconciledUntil, null);
  assert.match(body.error, /rate limit/);
  assert.equal(rpc.calls.filter((call) => call.method === 'getSlot').length, 3);
  assert.equal(rpc.calls.filter((call) => call.method === 'getSignaturesForAddress').length, 3);
});

test('multiple token operations and multiple observed accounts emit one pulse per signature/mint', async () => {
  const tx = transaction();
  tx.transaction.message.instructions.push(structuredClone(tx.transaction.message.instructions[0]));
  const rpc = provider((method) => method === 'getSignaturesForAddress' ? [{ signature: signature(1), slot: 12345, blockTime: BLOCK_TIME, err: null }] : method === 'getTransaction' ? tx : undefined);
  const env = { ...ENV, CIRCUIT_OBSERVED_ACCOUNTS: `${ACCOUNT},${key(9)}` };
  const handler = makeHandler();
  const first = await (await handler(request(), env, rpc.fetcher)).json();
  assert.equal(first.pulses.length, 1);
  assert.equal(first.pulses[0].kind, 'Transfer');
  assert.equal(first.pulses[0].verified, true);
  assert.deepEqual(first.pulses[0].accounts, [SOURCE, DESTINATION, OWNER].sort());
  assert.equal(first.pulses[0].address, undefined);
  const second = await (await handler(request(first.cursor), env, rpc.fetcher)).json();
  assert.equal(second.pulses.length, 0);
  assert.equal(second.coverage, 'complete');
  assert.equal(second.latestEventUTC, first.latestEventUTC);
  assert.equal(rpc.calls.filter((call) => call.method === 'getTransaction').length, 1);
});

test('target token balance delta is Activity, without inventing Buy/Sell', () => {
  const tx = transaction();
  tx.transaction.message.instructions = [];
  assert.equal(parseObservedTransaction(tx, signature(2), scope).pulse.kind, 'Activity');
  tx.meta.preTokenBalances = [];
  tx.meta.postTokenBalances = [];
  assert.match(parseObservedTransaction(tx, signature(2), scope).filtered, /No target-mint/);
});

test('failed, unsupported, missing-time and incomplete-token-metadata cases remain distinct', () => {
  const failed = transaction();
  failed.meta.err = { InstructionError: [0, 'Custom'] };
  assert.match(parseObservedTransaction(failed, signature(1), scope).filtered, /failed/);
  assert.match(parseObservedTransaction(null, signature(1), scope).pending, /not available/);
  const missing = transaction(null);
  assert.match(parseObservedTransaction(missing, signature(1), scope).pending, /UTC/);
  const missingBalances = transaction();
  delete missingBalances.meta.postTokenBalances;
  assert.match(parseObservedTransaction(missingBalances, signature(1), scope).pending, /metadata/);
});

test('an unresolved transaction is retained, retried and emitted once when it arrives late', async () => {
  let lookups = 0;
  const rpc = provider((method) => method === 'getSignaturesForAddress' ? [{ signature: signature(3), slot: 12345, blockTime: BLOCK_TIME - 65, err: null }] : method === 'getTransaction' ? ++lookups === 1 ? null : transaction(BLOCK_TIME - 65) : undefined);
  const handler = makeHandler();
  const first = await (await handler(request(), ENV, rpc.fetcher)).json();
  assert.equal(first.pending.count, 1);
  assert.equal(first.coverage, 'partial');
  assert.equal(first.pulses.length, 0);
  assert.equal(first.reconciledUntil, new Date((BLOCK_TIME - 65) * 1000).toISOString());
  const second = await (await handler(request(first.cursor), ENV, rpc.fetcher)).json();
  assert.equal(second.pending.count, 0);
  assert.equal(second.coverage, 'complete');
  assert.equal(second.pulses.length, 1);
  const third = await (await handler(request(second.cursor), ENV, rpc.fetcher)).json();
  assert.equal(third.pulses.length, 0);
});

test('unknown transaction time prevents a false complete window', async () => {
  const rpc = provider((method) => method === 'getSignaturesForAddress' ? [{ signature: signature(4), slot: 12345, blockTime: null, err: null }] : method === 'getTransaction' ? transaction(null) : undefined);
  const body = await (await makeHandler()(request(), ENV, rpc.fetcher)).json();
  assert.equal(body.coverage, 'partial');
  assert.equal(body.pending.count, 1);
  assert.equal(body.reconciledUntil, null);
});

test('pagination cap is partial and the next cursor resumes before the last fetched signature', async () => {
  let pages = 0;
  const rpc = provider((method) => {
    if (method === 'getSignaturesForAddress') {
      const page = pages++;
      return page < 3 ? Array.from({ length: 50 }, (_, index) => ({ signature: signature(page * 50 + index + 10), slot: 12345 - index, blockTime: BLOCK_TIME, err: { failed: true } })) : [];
    }
  });
  const handler = makeHandler();
  const first = await (await handler(request(), ENV, rpc.fetcher)).json();
  assert.equal(first.coverage, 'partial');
  assert.equal(first.reconciledUntil, null);
  assert.match(first.error, /pagination/);
  const second = await (await handler(request(first.cursor), ENV, rpc.fetcher)).json();
  assert.equal(second.coverage, 'complete');
  const signatureCalls = rpc.calls.filter((call) => call.method === 'getSignaturesForAddress');
  assert.equal(signatureCalls.length, 4);
  assert.equal(signatureCalls[3].params[1].before, signature(159));
});

test('cached checks share one request and retain real lastChecked rather than updating the clock', async () => {
  let current = NOW;
  const handler = createObservationHandler({ now: () => current, pause: async () => {} });
  const rpc = provider();
  const first = await (await handler(request(), ENV, rpc.fetcher)).json();
  current += 1_000;
  const secondResponse = await handler(request(), ENV, rpc.fetcher);
  const second = await secondResponse.json();
  assert.equal(secondResponse.headers.get('X-Circuit-Cache'), 'hit');
  assert.equal(second.lastChecked, first.lastChecked);
  assert.equal(rpc.calls.length, 3);
  const differentCursor = await handler(request(first.cursor), ENV, rpc.fetcher);
  assert.equal(differentCursor.status, 429);
  assert.equal((await differentCursor.json()).coverage, 'unavailable');
});

test('only bounded read methods are sent and secrets stay server-side', async () => {
  const rpc = provider((method) => method === 'getSignaturesForAddress' ? [{ signature: signature(7), slot: 12345, blockTime: BLOCK_TIME, err: null }] : undefined);
  const body = await (await makeHandler()(request(), { ...ENV, SOLANA_RPC_API_KEY: 'fixture-secret' }, rpc.fetcher)).json();
  assert.ok(rpc.calls.every((call) => ['getSlot', 'getBlockTime', 'getSignaturesForAddress', 'getTransaction'].includes(call.method)));
  assert.equal(rpc.calls[0].headers.Authorization, 'Bearer fixture-secret');
  assert.ok(!JSON.stringify(body).includes('fixture-secret'));
  const txCall = rpc.calls.find((call) => call.method === 'getTransaction');
  assert.equal(txCall.params[1].encoding, 'jsonParsed');
  assert.equal(txCall.params[1].commitment, 'finalized');
});

test('RPC concurrency never exceeds three while resolving a batch', async () => {
  let inflight = 0, maximum = 0;
  const rpc = provider(async (method) => {
    if (method === 'getSignaturesForAddress') return Array.from({ length: 12 }, (_, index) => ({ signature: signature(200 + index), slot: 12345, blockTime: BLOCK_TIME, err: null }));
    if (method === 'getTransaction') {
      inflight++;
      maximum = Math.max(maximum, inflight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inflight--;
      return transaction();
    }
  });
  const body = await (await makeHandler()(request(), ENV, rpc.fetcher)).json();
  assert.equal(body.pulses.length, 12);
  assert.equal(maximum, 3);
});

test('a failed refresh preserves the last proved boundary and never claims a complete new window', async () => {
  let current = NOW, failed = false;
  const handler = makeHandler(() => current);
  const rpc = provider((method) => failed && method === 'getBlockTime' ? null : undefined);
  const first = await (await handler(request(), ENV, rpc.fetcher)).json();
  failed = true;
  current += 60_000;
  const second = await (await handler(request(first.cursor), ENV, rpc.fetcher)).json();
  assert.notEqual(second.coverage, 'complete');
  assert.equal(second.reconciledUntil, first.reconciledUntil);
  assert.equal(second.latestEventUTC, first.latestEventUTC);
  assert.match(second.error, /UTC boundary/);
});

test('expired in-memory cursors produce an explicit recoverable restart response', async () => {
  let current = NOW;
  const handler = makeHandler(() => current);
  const rpc = provider();
  const first = await (await handler(request(), ENV, rpc.fetcher)).json();
  current += 31 * 60_000;
  const response = await handler(request(first.cursor), ENV, rpc.fetcher);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).status, 'cursor_expired');
});
