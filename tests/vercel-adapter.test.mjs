import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createApiHandler } from '../lib/vercel-api.mjs';
import { createObservationHandler } from '../lib/observation.mjs';
import configEntry from '../api/config.mjs';
import observationEntry from '../api/observation.mjs';
import { verifyPort } from '../scripts/verify-port.mjs';

const request = (path, method = 'GET') => new Request(`https://circuit.example${path}`, { method });
const env = {
  CIRCUIT_MINT: 'So11111111111111111111111111111111111111112',
  CIRCUIT_OBSERVED_ACCOUNTS: '11111111111111111111111111111111',
  SOLANA_RPC_URL: 'https://provider.example/PRIVATE-RPC-URL',
  SOLANA_RPC_API_KEY: 'PRIVATE-RPC-KEY',
};

test('portable Vercel package preserves authorized frontend/reader bytes and real Source content', async () => {
  const verified = await verifyPort();
  assert.ok(verified.verifiedFiles >= 30);
  assert.equal(verified.brand, 'CIRVYK');
  assert.ok(verified.protectedFiles >= 26);
  assert.ok(verified.brandingChanges.includes('public/config/site.js'));
  assert.ok(verified.brandingChanges.includes('public/source-manifest.json'));
  assert.equal(verified.sourceFiles, 25);
  assert.ok(verified.brandingChanges.includes('README.md'));
  const readme = await fs.readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /pnpm install --frozen-lockfile/);
  assert.match(readme, /node --env-file=\.env scripts\/dev\.mjs/);
  const deployment = await fs.readFile(new URL('../DEPLOYMENT.md', import.meta.url), 'utf8');
  assert.match(deployment, /api\/observation\.mjs/);
  assert.match(deployment, /scripts\/verify-port\.mjs/);
  assert.doesNotMatch(readme, /pnpm dev -- --port|uses the Vinext \/ Vite hosting wrapper/);
  assert.equal(verified.sourceCommit, 'a11f3f07d0faccf699a2772a47c70767b4cad3a0');
  const manifest = JSON.parse(await fs.readFile(new URL('../public/source-manifest.json', import.meta.url), 'utf8'));
  assert.ok(manifest.files.some(file => file.path === 'public/modules/runtime.js'));
  assert.ok(manifest.files.some(file => file.path === 'public/runtime.css'));
  assert.ok(manifest.files.every(file => !/^api\//.test(file.path) && !/^lib\//.test(file.path) && !/\.env|\.vercel|\.openai/.test(file.path)));
});

test('config remains an explicit unconfigured scope or a redacted server-configured scope', async () => {
  const api = createApiHandler();
  const defaults = await api(request('/api/config'));
  assert.equal(defaults.status, 200);
  assert.equal(defaults.headers.get('cache-control'), 'no-store');
  const empty = await defaults.json();
  assert.equal(empty.status, 'unconfigured');
  assert.equal(empty.scope.mint, null);
  assert.deepEqual(empty.scope.observedAccounts, []);
  const configured = await (await api(request('/api/config?SOLANA_RPC_URL=https://untrusted.example'), env)).json();
  assert.equal(configured.status, 'configured');
  assert.equal(configured.scope.mint, env.CIRCUIT_MINT);
  assert.equal(JSON.stringify(configured).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(configured).includes('untrusted'), false);
});

test('all write methods are rejected before any observation or external I/O', async () => {
  let observations = 0;
  const api = createApiHandler({ observation: () => { observations++; throw new Error('Must not execute'); } });
  for (const path of ['/api/config', '/api/observation', '/api/unknown']) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) {
      const response = await api(request(path, method), env);
      assert.equal(response.status, 405);
      assert.equal(response.headers.get('allow'), 'GET');
      assert.equal((await response.json()).error, 'Read-only interface');
    }
  }
  assert.equal(observations, 0);
  assert.equal((await api(request('/api/unknown'))).status, 404);
});

test('the observation route keeps cursor validation and never accepts a client-selected proxy target', async () => {
  const api = createApiHandler();
  for (const query of ['url=https://untrusted.example', 'method=sendTransaction', 'cursor=a&cursor=b', 'cursor=%3Cscript%3E']) {
    assert.equal((await api(request(`/api/observation?${query}`), env)).status, 400);
  }
  const unconfigured = await (await api(request('/api/observation'))).json();
  assert.equal(unconfigured.status, 'unconfigured');
  assert.equal(unconfigured.coverage, 'unavailable');
  assert.deepEqual(unconfigured.pulses, []);
});

test('configured Node adapter passes the exact original request and bounded RPC evidence through unchanged', async () => {
  const now = 1_780_000_030_000, calls = [], forwarded = [];
  const reader = createObservationHandler({ now: () => now, pause: async () => {}, minPollMs: 0 });
  const api = createApiHandler({ observation: (original, config) => { forwarded.push(original.url); return reader(original, config, async (url, options) => {
    const rpc = JSON.parse(options.body); calls.push({ url, ...rpc, headers: options.headers });
    const result = rpc.method === 'getSlot' ? 12345 : rpc.method === 'getBlockTime' ? Math.floor(now / 1000) - 5 : [];
    return Response.json({ jsonrpc: '2.0', id: rpc.id, result });
  }); } });
  const response = await api(request('/api/observation'), env);
  const value = await response.json();
  assert.equal(value.status, 'live');
  assert.equal(value.coverage, 'complete');
  assert.equal(value.reconciledUntil, new Date(now - 5000).toISOString());
  assert.deepEqual(calls.map(call => call.method), ['getSlot', 'getBlockTime', 'getSignaturesForAddress']);
  assert.ok(calls.every(call => call.url === env.SOLANA_RPC_URL));
  assert.equal(calls.at(-1).params[0], env.CIRCUIT_OBSERVED_ACCOUNTS);
  assert.ok(!JSON.stringify(value).includes('PRIVATE'));
  assert.equal(typeof value.cursor, 'string');
  const resumed = await api(request(`/api/observation?cursor=${value.cursor}`), env);
  assert.equal(resumed.status, 200);
  assert.deepEqual(forwarded.map(url => new URL(url).search), ['', `?cursor=${value.cursor}`]);
  assert.deepEqual([...new URL(forwarded[1]).searchParams.keys()], ['cursor']);
});

test('direct Vercel Node endpoints accept clean URLs and keep only an optional cursor query', async () => {
  assert.equal(typeof configEntry.fetch, 'function');
  assert.equal(typeof observationEntry.fetch, 'function');
  assert.equal((await configEntry.fetch(request('/api/config'))).status, 200);
  const clean = await observationEntry.fetch(request('/api/observation'));
  assert.equal(clean.status, 200, 'the Vercel entry must not inject a hidden path query');
  assert.equal((await clean.json()).status, 'unconfigured');
  assert.equal((await observationEntry.fetch(request('/api/observation?cursor=one-cursor'))).status, 200);
  for (const query of ['path=observation', 'url=https://untrusted.example', 'cursor=a&cursor=b']) {
    assert.equal((await observationEntry.fetch(request('/api/observation?' + query))).status, 400);
  }
  const config = JSON.parse(await fs.readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.equal(config.framework, null);
  assert.equal(config.outputDirectory, 'public');
  assert.equal(config.rewrites, undefined, 'direct API files must not add wildcard rewrite query parameters');
  assert.deepEqual(Object.keys(config.functions).sort(), ['api/config.mjs', 'api/observation.mjs']);
  assert.equal(config.functions['api/observation.mjs'].maxDuration, 300);
  assert.equal(config.env, undefined);
});


test('host builds tolerate omitted repository metadata while still rejecting missing application files', async t => {
  const source = fileURLToPath(new URL('../', import.meta.url));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cirvyk-host-build-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.cp(source, root, { recursive: true, filter: filename => {
    const relative = path.relative(source, filename);
    return !relative.split(path.sep).some(part => ['node_modules', '.git', '.vercel', '.openai'].includes(part));
  } });
  await fs.rm(path.join(root, '.gitignore'));
  await fs.rm(path.join(root, '.env.example'));
  const result = await verifyPort(root);
  assert.equal(result.brand, 'CIRVYK');
  await fs.rm(path.join(root, 'public/modules/engine.js'));
  await assert.rejects(() => verifyPort(root), /Every shipped public file/);
});
