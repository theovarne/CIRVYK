import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createWalletController, isPublicAddress } from '../public/modules/wallet.js';

const ADDRESS_A = '11111111111111111111111111111111';
const ADDRESS_B = 'So11111111111111111111111111111111111111112';
const account = address => ({ address, chains: ['solana:mainnet'], features: [] });
class Host extends EventTarget { Event = Event; }

function legacy(fields = {}) {
  const provider = new EventEmitter();
  provider.calls = [];
  provider.connect = async () => { provider.calls.push('connect'); return { publicKey: { toBase58: () => ADDRESS_A } }; };
  provider.disconnect = async () => { provider.calls.push('disconnect'); };
  for (const method of ['signMessage', 'signTransaction', 'signAllTransactions', 'sendTransaction']) {
    provider[method] = () => { provider.calls.push(method); throw new Error('Signing must never be called'); };
  }
  return Object.assign(provider, fields);
}

function standard(fields = {}) {
  const callbacks = new Set();
  const wallet = {
    name: 'Standard Solana', chains: ['solana:mainnet'], accounts: [], calls: [],
    features: {
      'standard:connect': { async connect() { wallet.calls.push('connect'); return { accounts: [account(ADDRESS_A)] }; } },
      'standard:disconnect': { async disconnect() { wallet.calls.push('disconnect'); } },
      'standard:events': { on(name, callback) { assert.equal(name, 'change'); callbacks.add(callback); return () => callbacks.delete(callback); } },
      'solana:signTransaction': { signTransaction() { wallet.calls.push('signTransaction'); throw new Error('Must never sign'); } },
    },
    emit(change) { for (const callback of [...callbacks]) callback(change); },
    listenerCount: () => callbacks.size,
  };
  return Object.assign(wallet, fields);
}

function announce(host, wallet) {
  const event = new Event('wallet-standard:register-wallet');
  Object.defineProperty(event, 'detail', { value: api => api.register(wallet) });
  host.dispatchEvent(event);
}

test('public addresses are base58 decoded and must contain exactly 32 bytes', () => {
  assert.equal(isPublicAddress(ADDRESS_A), true);
  assert.equal(isPublicAddress(ADDRESS_B), true);
  for (const invalid of [null, {}, '', 'A'.repeat(32), '1'.repeat(44), '0'.repeat(44), ADDRESS_B + '1', ` ${ADDRESS_B}`, '<script>']) assert.equal(isPublicAddress(invalid), false);
});

test('only detected callable legacy wallets are listed, with safe presentation metadata', () => {
  const host = new Host();
  host.phantom = { solana: legacy() };
  host.solflare = { connect: 'unavailable' };
  host.backpack = legacy();
  host.okxwallet = { solana: legacy() };
  const controller = createWalletController({ host });
  assert.deepEqual(controller.list(), [
    { id: 'phantom', name: 'Phantom', brandId: 'phantom', kind: 'legacy', icon: null },
    { id: 'backpack', name: 'Backpack', brandId: 'backpack', kind: 'legacy', icon: null },
    { id: 'okx', name: 'OKX Wallet', brandId: 'okx', kind: 'legacy', icon: null },
  ]);
  assert.equal(controller.address, null);
  assert.deepEqual(host.phantom.solana.calls, []);
  controller.destroy();
});

test('legacy public connect, account switch and disconnect never call signing methods', async () => {
  const host = new Host(), provider = legacy(), changes = [], messages = [];
  host.phantom = { solana: provider };
  const controller = createWalletController({ host, onChange: (address, meta) => changes.push({ address, meta }), onMessage: message => messages.push(message) });
  assert.equal(await controller.connect('phantom'), true);
  assert.equal(controller.address, ADDRESS_A);
  provider.emit('accountChanged', { toBase58: () => ADDRESS_B });
  assert.equal(controller.address, ADDRESS_B);
  assert.equal(changes.at(-1).meta.reason, 'account-changed');
  await controller.disconnect();
  assert.equal(controller.address, null);
  assert.equal(changes.at(-1).address, null);
  assert.deepEqual(provider.calls, ['connect', 'disconnect']);
  assert.equal(provider.listenerCount('accountChanged'), 0);
  assert.ok(messages.length >= 3);
  controller.destroy();
});

test('refused legacy connection reports failure and clears address', async () => {
  const host = new Host(), messages = [];
  host.solflare = legacy({ async connect() { const error = new Error('User rejected'); error.code = 4001; throw error; } });
  const controller = createWalletController({ host, onMessage: message => messages.push(message) });
  assert.equal(await controller.connect('solflare'), false);
  assert.equal(controller.address, null);
  assert.match(messages.at(-1), /declined/);
  assert.equal(host.solflare.listenerCount('disconnect'), 0);
  controller.destroy();
});

test('malformed public address is rejected on connect and on later account changes', async () => {
  const host = new Host(), provider = legacy();
  host.phantom = { solana: provider };
  const controller = createWalletController({ host });
  provider.connect = async () => ({ publicKey: 'A'.repeat(32) });
  assert.equal(await controller.connect('phantom'), false);
  assert.equal(controller.address, null);
  provider.connect = async () => ({ publicKey: ADDRESS_A });
  assert.equal(await controller.connect('phantom'), true);
  provider.emit('accountChanged', 'malformed');
  assert.equal(controller.address, null);
  assert.equal(provider.listenerCount('accountChanged'), 0);
  controller.destroy();
});

test('legacy disconnect events and disconnect refusal always clear local state', async () => {
  const host = new Host(), provider = legacy(), messages = [];
  host.okxwallet = { solana: provider };
  const controller = createWalletController({ host, onMessage: message => messages.push(message) });
  await controller.connect('okx');
  provider.emit('disconnect');
  assert.equal(controller.address, null);
  await controller.connect('okx');
  provider.disconnect = async () => { throw new Error('Extension unavailable'); };
  await controller.disconnect();
  assert.equal(controller.address, null);
  assert.match(messages.at(-1), /cleared locally/);
  controller.destroy();
});

test('Wallet Standard app-ready handshake discovers already loaded Solana wallets', async () => {
  const host = new Host(), wallet = standard();
  host.addEventListener('wallet-standard:app-ready', event => event.detail.register(wallet));
  const controller = createWalletController({ host });
  assert.deepEqual(controller.list(), [{ id: 'standard:1', name: 'Standard Solana', brandId: null, kind: 'standard', icon: null }]);
  assert.deepEqual(wallet.calls, []);
  assert.equal(await controller.connect('standard:1'), true);
  assert.equal(controller.address, ADDRESS_A);
  wallet.emit({ accounts: [account(ADDRESS_B)] });
  assert.equal(controller.address, ADDRESS_B);
  wallet.emit({ accounts: [] });
  assert.equal(controller.address, null);
  assert.equal(wallet.listenerCount(), 0);
  assert.deepEqual(wallet.calls, ['connect']);
  controller.destroy();
});

test('Wallet Standard register event discovers late injection and excludes other chains/stubs', async () => {
  const host = new Host(), controller = createWalletController({ host });
  announce(host, standard({ name: 'Ethereum only', chains: ['eip155:1'] }));
  announce(host, standard({ name: 'Stub', features: { 'standard:connect': {} } }));
  assert.deepEqual(controller.list(), []);
  const wallet = standard();
  announce(host, wallet);
  announce(host, wallet);
  assert.equal(controller.list().length, 1);
  assert.equal(await controller.connect(controller.list()[0].id), true);
  await controller.disconnect();
  assert.equal(controller.address, null);
  assert.equal(wallet.listenerCount(), 0);
  assert.deepEqual(wallet.calls, ['connect', 'disconnect']);
  controller.destroy();
});

test('standard refusal and invalid/non-Solana accounts cannot apply an address filter', async () => {
  const host = new Host(), controller = createWalletController({ host });
  const wallet = standard();
  wallet.features['standard:connect'].connect = async () => { throw new Error('User cancelled'); };
  announce(host, wallet);
  const id = controller.list()[0].id;
  assert.equal(await controller.connect(id), false);
  wallet.features['standard:connect'].connect = async () => ({ accounts: [{ address: ADDRESS_A, chains: ['eip155:1'] }, account('A'.repeat(32))] });
  assert.equal(await controller.connect(id), false);
  assert.equal(controller.address, null);
  controller.destroy();
});

test('same installed brand is not offered twice through standard and legacy discovery', () => {
  const host = new Host();
  host.phantom = { solana: legacy() };
  const controller = createWalletController({ host });
  announce(host, standard({ name: 'Phantom' }));
  assert.deepEqual(controller.list(), [{ id: 'standard:1', name: 'Phantom', brandId: 'phantom', kind: 'standard', icon: null }]);
  controller.destroy();
});

test('destroy detaches listeners and ignores a pending connect result', async () => {
  const host = new Host(), provider = legacy();
  let finish;
  provider.connect = () => new Promise(resolve => { finish = resolve; });
  host.phantom = { solana: provider };
  const controller = createWalletController({ host });
  const result = controller.connect('phantom');
  controller.destroy();
  finish({ publicKey: ADDRESS_A });
  assert.equal(await result, false);
  assert.equal(controller.address, null);
  assert.equal(provider.listenerCount('accountChanged'), 0);
  assert.deepEqual(controller.list(), []);
});

test('explicit disconnect cancels a pending connection and stale events cannot restore it', async () => {
  const host = new Host(), provider = legacy();
  let finish;
  provider.connect = () => new Promise(resolve => { finish = resolve; });
  host.phantom = { solana: provider };
  const controller = createWalletController({ host });
  const result = controller.connect('phantom');
  await controller.disconnect();
  provider.emit('accountChanged', ADDRESS_B);
  finish({ publicKey: ADDRESS_A });
  assert.equal(await result, false);
  assert.equal(controller.address, null);
  controller.destroy();
});

test('catalog always offers five recognizable wallets, with unavailable providers disabled by metadata', async () => {
  const controller = createWalletController({ host: new Host() });
  assert.deepEqual(controller.catalog().map(({ brandId, name, installed, kind }) => ({ brandId, name, installed, kind })), [
    { brandId: 'okx', name: 'OKX Wallet', installed: false, kind: null },
    { brandId: 'phantom', name: 'Phantom', installed: false, kind: null },
    { brandId: 'backpack', name: 'Backpack', installed: false, kind: null },
    { brandId: 'coinbase', name: 'Coinbase Wallet', installed: false, kind: null },
    { brandId: 'solflare', name: 'Solflare', installed: false, kind: null },
  ]);
  assert.equal(await controller.connect('coinbase'), false);
  assert.equal(controller.address, null);
  controller.destroy();
});

test('Coinbase uses its actual Solana namespace and never touches an EVM provider', async () => {
  const host = new Host(), provider = legacy();
  provider.publicKey = { toBase58: () => ADDRESS_A };
  provider.connect = async () => { provider.calls.push('connect'); };
  host.coinbaseSolana = provider;
  Object.defineProperty(host, 'ethereum', { get() { throw new Error('Do not use an EVM provider'); } });
  const controller = createWalletController({ host });
  assert.equal(controller.catalog().find(item => item.brandId === 'coinbase').installed, true);
  assert.equal(await controller.connect('coinbase'), true);
  assert.equal(controller.address, ADDRESS_A);
  await controller.disconnect();
  assert.deepEqual(provider.calls, ['connect', 'disconnect']);
  controller.destroy();
});

test('register/unregister and refresh notify availability changes without polling or duplicate notifications', async () => {
  const host = new Host(), notifications = [];
  const controller = createWalletController({ host, onProvidersChange: rows => notifications.push(rows) });
  controller.refresh();
  assert.equal(notifications.length, 1);
  controller.refresh();
  assert.equal(notifications.length, 1);
  host.phantom = { solana: legacy() };
  controller.refresh();
  assert.equal(notifications.length, 2);
  assert.equal(notifications.at(-1).find(row => row.brandId === 'phantom').installed, true);
  let unregister;
  const wallet = standard({ name: 'Phantom' });
  host.dispatchEvent(Object.assign(new Event('wallet-standard:register-wallet'), { detail: api => { unregister = api.register(wallet); } }));
  assert.equal(notifications.length, 3);
  assert.equal(notifications.at(-1).find(row => row.brandId === 'phantom').kind, 'standard');
  await controller.connect('standard:1');
  unregister();
  assert.equal(controller.address, null);
  assert.equal(wallet.listenerCount(), 0);
  assert.equal(notifications.length, 4);
  assert.equal(notifications.at(-1).find(row => row.brandId === 'phantom').kind, 'legacy');
  unregister();
  assert.equal(notifications.length, 4);
  controller.destroy();
});

test('brand aliases and duplicate standard announcements produce a single catalog entry', () => {
  const host = new Host(), controller = createWalletController({ host });
  announce(host, standard({ name: 'OKX' }));
  announce(host, standard({ name: 'OKX Wallet' }));
  announce(host, standard({ name: 'Coinbase' }));
  host.okxwallet = { solana: legacy() };
  host.coinbaseSolana = legacy();
  assert.equal(controller.list().length, 2);
  assert.equal(controller.catalog().length, 5);
  assert.equal(controller.catalog().filter(row => row.installed).length, 2);
  assert.equal(controller.catalog()[0].name, 'OKX Wallet');
  controller.destroy();
});

test('one broken injected extension does not hide other available wallets', async () => {
  const host = new Host();
  Object.defineProperty(host, 'phantom', { get() { throw new Error('Unavailable extension'); } });
  host.backpack = { solana: legacy() };
  const controller = createWalletController({ host });
  assert.deepEqual(controller.list().map(row => row.brandId), ['backpack']);
  assert.equal(await controller.connect('backpack'), true);
  controller.destroy();
});

test('provider icons cannot introduce external requests or markup into the wallet picker', () => {
  const host = new Host(), controller = createWalletController({ host });
  announce(host, standard({ name: 'External image', icon: 'https://tracker.invalid/icon.svg' }));
  announce(host, standard({ name: 'Markup', icon: '<svg onload="alert(1)" />' }));
  announce(host, standard({ name: 'Local image', icon: 'data:image/png;base64,aGVsbG8=' }));
  assert.deepEqual(controller.list().map(row => row.icon), [null, null, 'data:image/png;base64,aGVsbG8=']);
  assert.equal(controller.catalog().length, 8);
  controller.destroy();
});

test('closing the picker cancels only pending connection and ignores later success or account events', async () => {
  const host = new Host(), provider = legacy(), changes = [];
  let finish;
  provider.connect = () => new Promise(resolve => { finish = resolve; });
  host.phantom = { solana: provider };
  const controller = createWalletController({ host, onChange: value => changes.push(value) });
  const result = controller.connect('phantom');
  assert.equal(controller.pending, true);
  provider.emit('accountChanged', ADDRESS_B);
  assert.equal(controller.address, null);
  assert.deepEqual(changes, []);
  assert.equal(controller.cancelPending(), true);
  assert.equal(controller.pending, false);
  finish({ publicKey: ADDRESS_A });
  assert.equal(await result, false);
  assert.equal(controller.address, null);
  assert.equal(provider.listenerCount('accountChanged'), 0);
  assert.equal(controller.cancelPending(), false);
  provider.connect = async () => ({ publicKey: ADDRESS_A });
  assert.equal(await controller.connect('phantom'), true);
  assert.equal(controller.cancelPending(), false);
  assert.equal(controller.address, ADDRESS_A);
  controller.destroy();
});

test('a repeated click during one permission request does not prompt twice', async () => {
  const host = new Host(), provider = legacy();
  let finish, calls = 0;
  provider.connect = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  host.phantom = { solana: provider };
  const controller = createWalletController({ host });
  const pending = controller.connect('phantom');
  assert.equal(await controller.connect('phantom'), false);
  assert.equal(calls, 1);
  finish({ publicKey: ADDRESS_A });
  assert.equal(await pending, true);
  assert.equal(await controller.connect('phantom'), true);
  assert.equal(calls, 1);
  controller.destroy();
});

test('stale disconnect success or rejection cannot replace a newer wallet connection status', async () => {
  for (const rejectDisconnect of [false, true]) {
    const host = new Host(), first = legacy(), second = legacy(), messages = [];
    let finish;
    first.disconnect = () => new Promise((resolve, reject) => { finish = rejectDisconnect ? () => reject(new Error('Old extension disconnected')) : resolve; });
    host.phantom = { solana: first };
    host.solflare = second;
    const controller = createWalletController({ host, onMessage: value => messages.push(value) });
    await controller.connect('phantom');
    const disconnecting = controller.disconnect();
    await controller.connect('solflare');
    const latest = messages.at(-1);
    finish();
    await disconnecting;
    assert.equal(controller.address, ADDRESS_A);
    assert.equal(messages.at(-1), latest);
    assert.equal(first.listenerCount('accountChanged'), 0);
    controller.destroy();
  }
});

test('silent disconnect clears state immediately and never posts a late status over a manual filter', async () => {
  for (const rejectDisconnect of [false, true]) {
    const host = new Host(), provider = legacy(), messages = [], changes = [];
    let finish, applicationFilter = null;
    provider.disconnect = () => new Promise((resolve, reject) => {
      finish = rejectDisconnect ? () => reject(new Error('Extension timeout')) : resolve;
    });
    host.phantom = { solana: provider };
    const controller = createWalletController({ host, onChange: value => { changes.push(value); applicationFilter = value; }, onMessage: value => messages.push(value) });
    await controller.connect('phantom');
    const messageCount = messages.length;
    const disconnecting = controller.disconnect({ silent: true });
    assert.equal(controller.address, null);
    assert.equal(changes.at(-1), null);
    assert.equal(provider.listenerCount('accountChanged'), 0);
    // The caller can apply a pasted address without waiting for this extension promise.
    applicationFilter = ADDRESS_B;
    provider.emit('accountChanged', ADDRESS_A);
    assert.equal(applicationFilter, ADDRESS_B);
    finish();
    await disconnecting;
    assert.equal(messages.length, messageCount);
    assert.equal(controller.address, null);
    assert.equal(applicationFilter, ADDRESS_B);
    controller.destroy();
  }
});
