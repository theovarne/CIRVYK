// Public address filtering only. No transaction, signing, or approval methods are used.
// Wallet Standard discovery follows its register-wallet / app-ready event protocol:
// https://github.com/wallet-standard/wallet-standard/blob/master/packages/core/app/src/wallets.ts
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** A Solana public address must decode to exactly 32 bytes, including leading zeroes. */
export function isPublicAddress(address) {
  if (typeof address !== 'string' || address.length < 32 || address.length > 44) return false;
  let value = 0n;
  for (const char of address) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) return false;
    value = value * 58n + BigInt(digit);
  }
  let decodedBytes = 0;
  while (value > 0n) { decodedBytes++; value >>= 8n; }
  let leadingZeros = 0;
  while (address[leadingZeros] === '1') leadingZeros++;
  return decodedBytes + leadingZeros === 32;
}

function publicKeyText(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value.toBase58 === 'function') return value.toBase58();
  if (value && typeof value.toString === 'function') return value.toString();
  return null;
}

const isSolanaChain = chain => typeof chain === 'string' && chain.startsWith('solana:');
const safeName = name => typeof name === 'string' && name.trim().length > 0 && name.length <= 80 ? name.trim() : null;
const canonicalName = name => name.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/wallet$/, '');
const WALLET_BRANDS = Object.freeze([
  { brandId: 'okx', name: 'OKX Wallet' },
  { brandId: 'phantom', name: 'Phantom' },
  { brandId: 'backpack', name: 'Backpack' },
  { brandId: 'coinbase', name: 'Coinbase Wallet' },
  { brandId: 'solflare', name: 'Solflare' },
]);
const knownBrand = name => WALLET_BRANDS.find(brand => canonicalName(brand.name) === canonicalName(name));
// Provider images are displayed only as <img> data, never fetched remotely or injected as markup.
const safeIcon = icon => typeof icon === 'string' && icon.length <= 131072 && /^data:image\/(?:svg\+xml|png|webp|jpeg|gif);base64,[A-Za-z0-9+/=]+$/.test(icon) ? icon : null;

function standardAccount(accounts) {
  if (!Array.isArray(accounts)) return null;
  const account = accounts.find(item => item && Array.isArray(item.chains) && item.chains.some(isSolanaChain) && isPublicAddress(item.address));
  return account?.address ?? null;
}

function compatibleWallet(wallet) {
  try {
    return wallet && safeName(wallet.name) && Array.isArray(wallet.chains) && wallet.chains.some(isSolanaChain) && typeof wallet.features?.['standard:connect']?.connect === 'function';
  } catch { return false; }
}

export function createWalletController({ host = globalThis.window, onChange = () => {}, onMessage = () => {}, onProvidersChange = () => {} } = {}) {
  let selected = null, address = null, revision = 0, destroyed = false, nextId = 0, pending = false, lastCatalog = '';
  const standards = new Map();
  const standardIds = new WeakMap();
  const removers = [];
  const notify = message => { try { onMessage(message); } catch { /* A consumer callback cannot break wallet cleanup. */ } };
  const changed = (value, meta) => { address = value; try { onChange(value, meta); } catch { /* State remains valid if the UI callback fails. */ } };
  const detach = () => { for (const off of removers.splice(0)) { try { off(); } catch { /* Continue cleaning all subscriptions. */ } } };

  function clear(reason, message) {
    revision++;
    const provider = selected?.name;
    detach();
    selected = null;
    pending = false;
    changed(null, { provider, reason });
    if (message) notify(message);
  }

  function register(...wallets) {
    if (destroyed) return () => {};
    const added = [];
    for (const wallet of wallets) {
      if (!compatibleWallet(wallet) || standards.size >= 32 || [...standards.values()].some(item => item.provider === wallet)) continue;
      let id = standardIds.get(wallet);
      if (!id) { id = `standard:${++nextId}`; standardIds.set(wallet, id); }
      const brand = knownBrand(safeName(wallet.name));
      standards.set(id, { id, name: brand?.name ?? safeName(wallet.name), brandId: brand?.brandId ?? null, kind: 'standard', provider: wallet });
      added.push(id);
    }
    if (added.length) providersChanged();
    let active = true;
    return () => {
      if (!active || destroyed) return;
      active = false;
      for (const id of added) {
        const entry = standards.get(id);
        standards.delete(id);
        if (selected?.provider === entry?.provider) clear('provider-unregistered', 'The wallet is no longer available. Public address filter cleared.');
      }
      if (added.length) providersChanged();
    };
  }

  const api = Object.freeze({ register });
  const onRegister = event => {
    if (destroyed || typeof event?.detail !== 'function') return;
    try { event.detail(api); } catch { notify('A wallet could not register. You can still paste a public address.'); }
  };
  if (host?.addEventListener && host?.dispatchEvent) {
    host.addEventListener('wallet-standard:register-wallet', onRegister);
    try {
      const EventType = host.Event ?? globalThis.Event;
      const event = new EventType('wallet-standard:app-ready', { bubbles: false, cancelable: false });
      Object.defineProperty(event, 'detail', { value: api });
      host.dispatchEvent(event);
    } catch { notify('Wallet discovery is unavailable. You can still paste a public address.'); }
  }

  function listEntries() {
    if (destroyed) return [];
    const entries = [];
    const seenBrands = new Set();
    for (const entry of standards.values()) {
      if (!compatibleWallet(entry.provider) || (entry.brandId && seenBrands.has(entry.brandId))) continue;
      if (entry.brandId) seenBrands.add(entry.brandId);
      entries.push(entry);
    }
    const seenProviders = new Set(entries.map(entry => entry.provider));
    const standardNames = new Set(entries.map(entry => canonicalName(entry.name)));
    const candidates = [
      ['phantom', () => host?.phantom?.solana ?? (host?.solana?.isPhantom ? host.solana : null)],
      ['solflare', () => host?.solflare],
      ['backpack', () => host?.backpack?.solana ?? host?.backpack ?? (host?.solana?.isBackpack ? host.solana : null)],
      ['okx', () => host?.okxwallet?.solana],
      // Coinbase's Solana namespace; never use its EVM window.ethereum provider.
      // https://github.com/anza-xyz/wallet-adapter/blob/master/packages/wallets/coinbase/src/adapter.ts
      ['coinbase', () => host?.coinbaseSolana],
    ];
    for (const [id, read] of candidates) {
      try {
        const provider = read(), brand = WALLET_BRANDS.find(item => item.brandId === id);
        if (!provider || typeof provider.connect !== 'function' || seenProviders.has(provider) || standardNames.has(canonicalName(brand.name))) continue;
        seenProviders.add(provider);
        entries.push({ id, brandId: id, name: brand.name, provider, kind: 'legacy' });
      } catch { /* One inaccessible extension must not hide the others. */ }
    }
    return entries;
  }

  function presentation(entry) {
    let icon = null;
    try { icon = safeIcon(entry.provider.icon); } catch { /* Use the local brand icon or fallback. */ }
    return { id: entry.id, name: entry.name, kind: entry.kind, brandId: entry.brandId, icon };
  }

  function catalog() {
    const entries = listEntries();
    return [
      ...WALLET_BRANDS.map(brand => {
        const entry = entries.find(item => item.brandId === brand.brandId);
        return entry ? { ...presentation(entry), installed: true } : { ...brand, id: brand.brandId, kind: null, installed: false, icon: null };
      }),
      ...entries.filter(entry => !entry.brandId).map(entry => ({ ...presentation(entry), installed: true })),
    ];
  }

  function providersChanged() {
    if (destroyed) return [];
    const rows = catalog(), signature = JSON.stringify(rows);
    if (signature !== lastCatalog) {
      lastCatalog = signature;
      try { onProvidersChange(rows); } catch { /* Discovery continues if the UI callback fails. */ }
    }
    return rows;
  }

  function bind(entry, token) {
    const isCurrent = () => !destroyed && revision === token && selected?.provider === entry.provider;
    const accountChanged = value => {
      if (!isCurrent()) return;
      let next;
      try { next = publicKeyText(value); } catch { next = null; }
      if (!next || !isPublicAddress(next)) {
        clear(next ? 'invalid-address' : 'disconnected', next ? 'The wallet returned an invalid public address. Filter cleared.' : 'Wallet disconnected. Public address filter cleared.');
        return;
      }
      // A provider may emit an account before its permission request settles.
      // Only the successful, still-current connect result may apply that address.
      if (pending) return;
      if (next !== address) {
        changed(next, { provider: entry.name, reason: 'account-changed' });
        notify('Wallet address changed. The filter only covers records observed by this site.');
      }
    };
    if (entry.kind === 'standard') {
      const events = entry.provider.features?.['standard:events'];
      if (typeof events?.on === 'function') {
        const off = events.on('change', change => {
          if (!isCurrent() || !change || !Object.hasOwn(change, 'accounts')) return;
          accountChanged(standardAccount(change.accounts));
        });
        if (typeof off === 'function') removers.push(off);
      }
    } else if (typeof entry.provider.on === 'function') {
      const listeners = {
        accountChanged,
        disconnect: () => { if (isCurrent()) clear('disconnected', 'Wallet disconnected. Public address filter cleared.'); },
        change: change => {
          if (!isCurrent() || !change) return;
          if (typeof change === 'string' || typeof change.toBase58 === 'function') accountChanged(change);
          else if (Object.hasOwn(change, 'publicKey')) accountChanged(change.publicKey);
          else if (Object.hasOwn(change, 'address')) accountChanged(change.address);
          else if (Object.hasOwn(change, 'accounts')) accountChanged(Array.isArray(change.accounts) ? change.accounts[0]?.address ?? change.accounts[0] : null);
        },
      };
      for (const [event, listener] of Object.entries(listeners)) {
        entry.provider.on(event, listener);
        removers.push(() => {
          const off = entry.provider.off ?? entry.provider.removeListener;
          if (typeof off === 'function') off.call(entry.provider, event, listener);
        });
      }
    }
  }

  async function connect(id) {
    if (destroyed) return false;
    const entry = listEntries().find(item => item.id === id);
    if (!entry) { notify('That wallet is not available. Choose a detected wallet or paste a public address.'); return false; }
    if (selected?.provider === entry.provider) return !pending && address !== null;
    if (selected || address) clear('switching');
    const token = ++revision;
    selected = entry;
    pending = true;
    try {
      bind(entry, token);
      let next;
      if (entry.kind === 'standard') {
        const feature = entry.provider.features['standard:connect'];
        const result = await feature.connect();
        next = standardAccount(result?.accounts ?? entry.provider.accounts);
      } else {
        const result = await entry.provider.connect();
        next = publicKeyText(result?.publicKey ?? entry.provider.publicKey);
      }
      if (destroyed || revision !== token) return false;
      if (!isPublicAddress(next)) throw new Error('No valid Solana public address was returned.');
      pending = false;
      changed(next, { provider: entry.name, reason: 'connected' });
      notify('Wallet connected for public address filtering. Results only cover records observed by this site.');
      return true;
    } catch (error) {
      if (destroyed || revision !== token) return false;
      clear('connection-rejected');
      const reason = error?.code === 4001 || /reject|denied|cancel/i.test(String(error?.message ?? '')) ? 'Connection declined.' : 'Could not connect to that wallet.';
      notify(`${reason} No address filter was applied. You can paste a public address instead.`);
      return false;
    }
  }

  async function disconnect({ silent = false } = {}) {
    const entry = selected;
    clear('disconnected');
    const token = revision;
    try {
      if (entry?.kind === 'standard') {
        const feature = entry.provider.features?.['standard:disconnect'];
        if (typeof feature?.disconnect === 'function') await feature.disconnect();
      } else if (typeof entry?.provider?.disconnect === 'function') await entry.provider.disconnect();
      if (!silent && !destroyed && revision === token) notify('Public address filter cleared.');
    } catch {
      if (!silent && !destroyed && revision === token) notify('Public address filter cleared locally. The wallet did not confirm disconnection.');
    }
  }

  function cancelPending() {
    if (destroyed || !pending) return false;
    clear('connection-cancelled');
    notify('Connection cancelled locally. No address filter was applied.');
    return true;
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    host?.removeEventListener?.('wallet-standard:register-wallet', onRegister);
    clear('destroyed');
    standards.clear();
  }

  return {
    list: () => listEntries().map(presentation),
    catalog, refresh: providersChanged,
    connect, disconnect, cancelPending,
    get address() { return address; },
    get pending() { return pending; },
    destroy,
  };
}
