import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { generatePublicSource } from './generate-public-source.mjs';
import { syncBrand } from './sync-brand.mjs';
import { BRAND_NAME } from '../public/config/site.js';

export const SEVEN_FIXES_BASE_COMMIT = '34efdacc6d1d831a9e8f7fb2d04a3a2055d43a3c';
export const HOST_MANAGED_METADATA = new Set(['.gitignore', '.env.example', '.vercelignore', 'vercel.json']);
export const SEVEN_FIXES_ALLOWED_PATHS = new Set([
  'public/modules/app.js', 'public/modules/memory.js', 'public/modules/dashboard.js',
  'public/modules/workbench.js', 'public/styles.css', 'public/workbench.css',
  'public/index.html', 'public/config/site.js', 'public/source-manifest.json',
  'scripts/sync-brand.mjs', 'scripts/verify-port.mjs', 'README.md', 'DEPLOYMENT.md',
  'docs/development.md', 'docs/media/cirvyk-header.jpg',
  'docs/media/cirvyk-overview.jpg', 'docs/media/cirvyk-inspector.jpg',
]);
export function isSevenFixesPath(relative) {
  return typeof relative === 'string' && !path.isAbsolute(relative)
    && !relative.split('/').some(part => !part || part === '..' || part.startsWith('.'))
    && (SEVEN_FIXES_ALLOWED_PATHS.has(relative) || /^tests\/[\w./-]+\.mjs$/.test(relative));
}

export const RUNTIME_BASE_COMMIT = 'fa6015263263f9056c5083e41d6ca12110d30839';
export const RUNTIME_ALLOWED_PATHS = new Set([
  'public/modules/runtime.js', 'public/runtime.css', 'public/assets/runtime-components.svg',
  'public/modules/app.js', 'public/modules/source-workspace.js', 'public/index.html', 'public/config/site.js',
  'public/source-manifest.json', 'scripts/verify-port.mjs',
  'scripts/generate-public-source.mjs', 'README.md', 'docs/media/cirvyk-runtime.jpg',
  'tests/runtime.test.mjs', 'tests/app-interactions.test.mjs', 'tests/vercel-adapter.test.mjs',
  'tests/source-workspace.test.mjs',
]);
export function isRuntimePath(relative) {
  return typeof relative === 'string' && !path.isAbsolute(relative)
    && !relative.split('/').some(part => !part || part === '..' || part.startsWith('.'))
    && RUNTIME_ALLOWED_PATHS.has(relative);
}

export const CONTRACT_ADDRESS_BASE_COMMIT = '346dafa82800b3bdcd09df20ef53eda1b3c548ea';
export const CONTRACT_ADDRESS = 'HE7BnoVVEGmjTn3MRffaZGZCNCHrwWWKmuhQKNRXpump';
export const CONTRACT_ADDRESS_ALLOWED_PATHS = new Set([
  'public/config/site.js', 'public/modules/app.js', 'README.md', 'public/source-manifest.json',
  'scripts/verify-port.mjs', 'tests/vercel-adapter.test.mjs', 'tests/observation.test.mjs',
  'docs/media/cirvyk-header.jpg', 'docs/media/cirvyk-overview.jpg',
  'docs/media/cirvyk-inspector.jpg', 'docs/media/cirvyk-runtime.jpg',
]);
export function isContractAddressPath(relative) {
  return typeof relative === 'string' && !path.isAbsolute(relative)
    && !relative.split('/').some(part => !part || part === '..' || part.startsWith('.'))
    && CONTRACT_ADDRESS_ALLOWED_PATHS.has(relative);
}

async function verifyDigest(root, entry, description) {
  assert.ok(typeof entry.path === 'string' && !path.isAbsolute(entry.path)
    && !entry.path.split('/').some(part => !part || part === '..' || part.startsWith('.')), `Invalid reviewed path: ${entry.path}`);
  assert.match(entry.sha256, /^[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0, `Invalid reviewed size: ${entry.path}`);
  const filename = path.join(root, entry.path);
  const info = await fs.lstat(filename);
  assert.ok(info.isFile() && !info.isSymbolicLink(), `Only regular reviewed files are allowed: ${entry.path}`);
  const bytes = await fs.readFile(filename);
  assert.equal(bytes.length, entry.bytes, `${description} size: ${entry.path}`);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, `${description}: ${entry.path}`);
}

export async function verifyPort(root = fileURLToPath(new URL('../', import.meta.url))) {
  const provenance = JSON.parse(await fs.readFile(path.join(root, 'provenance.json'), 'utf8'));
  assert.equal(provenance.sourceCommit, 'a11f3f07d0faccf699a2772a47c70767b4cad3a0');
  const contractAddress = provenance.contractAddress;
  const contractReviewed = new Set();
  if (contractAddress) {
    assert.equal(contractAddress.baseCommit, CONTRACT_ADDRESS_BASE_COMMIT, 'Contract-address review must retain the accepted Runtime baseline');
    assert.equal(contractAddress.canonical, 'https://www.cirvyk.xyz');
    assert.equal(contractAddress.mint, CONTRACT_ADDRESS, 'Only the user-provided contract address is authorized');
    assert.equal(contractAddress.network, 'mainnet-beta');
    assert.match(contractAddress.baselineSnapshotSha256, /^[a-f0-9]{64}$/);
    assert.ok(Array.isArray(contractAddress.changes) && contractAddress.changes.length > 0, 'Contract-address activation requires an explicit change list');
    assert.ok(Array.isArray(contractAddress.protectedFiles) && contractAddress.protectedFiles.length > 0, 'Contract-address activation must protect the existing implementation');
    for (const entry of contractAddress.changes) {
      assert.ok(isContractAddressPath(entry.path), `Unreviewed contract-address change: ${entry.path}`);
      assert.ok(!contractReviewed.has(entry.path), `Duplicate contract-address change: ${entry.path}`);
      assert.match(entry.previousSha256, /^[a-f0-9]{64}$/, `Contract-address changes must refer to existing accepted files: ${entry.path}`);
      contractReviewed.add(entry.path);
      await verifyDigest(root, entry, 'Contract-address reviewed bytes differ');
    }
    for (const required of ['public/config/site.js', 'README.md', 'public/source-manifest.json', 'scripts/verify-port.mjs']) {
      assert.ok(contractReviewed.has(required), `The contract-address review must include ${required}`);
    }
    const siteEntry = contractAddress.changes.find(entry => entry.path === 'public/config/site.js');
    const reviewedSite = (await import(`${pathToFileURL(path.join(root, siteEntry.path)).href}?review=${siteEntry.sha256}`)).SITE;
    assert.equal(reviewedSite.token.mint, CONTRACT_ADDRESS, 'Configured CA must match the exact user-provided address');
    assert.equal(reviewedSite.token.network, 'mainnet-beta', 'The configured CA is for Solana mainnet');
    for (const review of [provenance.branding, provenance.palette, provenance.walletAccess,
      provenance.publication, provenance.logo, provenance.sevenFixes, provenance.runtimeFeature]) {
      for (const entry of review.protectedFiles) {
        assert.ok(!contractReviewed.has(entry.path), `A prior review cannot still protect an authorized contract-address overlap: ${entry.path}`);
      }
    }
  }
  const runtime = provenance.runtimeFeature;
  const runtimeReviewed = new Set();
  if (runtime) {
    assert.equal(runtime.baseCommit, RUNTIME_BASE_COMMIT, 'Runtime review must retain the accepted CIRVYK baseline');
    assert.equal(runtime.canonical, 'https://www.cirvyk.xyz');
    assert.match(runtime.baselineSnapshotSha256, /^[a-f0-9]{64}$/);
    assert.ok(Array.isArray(runtime.changes) && runtime.changes.length > 0, 'Runtime additions require an explicit reviewed change list');
    assert.ok(Array.isArray(runtime.protectedFiles) && runtime.protectedFiles.length > 0, 'Runtime additions must protect the existing implementation');
    for (const entry of runtime.changes) {
      assert.ok(isRuntimePath(entry.path), `Unreviewed runtime change: ${entry.path}`);
      assert.ok(!runtimeReviewed.has(entry.path), `Duplicate runtime change: ${entry.path}`);
      assert.ok(entry.previousSha256 === null || /^[a-f0-9]{64}$/.test(entry.previousSha256), `Invalid runtime baseline digest: ${entry.path}`);
      runtimeReviewed.add(entry.path);
      await verifyDigest(root, entry, 'Runtime reviewed bytes differ');
    }
    for (const required of ['public/modules/runtime.js', 'public/runtime.css', 'public/assets/runtime-components.svg',
      'public/modules/app.js', 'public/index.html', 'public/config/site.js',
      'public/source-manifest.json', 'scripts/verify-port.mjs', 'tests/runtime.test.mjs',
      'docs/media/cirvyk-runtime.jpg']) {
      assert.ok(runtimeReviewed.has(required), `The runtime review must include ${required}`);
    }
    for (const review of [provenance.branding, provenance.palette, provenance.walletAccess,
      provenance.publication, provenance.logo, provenance.sevenFixes]) {
      for (const entry of review.protectedFiles) {
        assert.ok(!runtimeReviewed.has(entry.path), `A prior review cannot still protect an authorized runtime overlap: ${entry.path}`);
      }
    }
  }
  const latest = provenance.sevenFixes;
  assert.equal(latest?.baseCommit, SEVEN_FIXES_BASE_COMMIT, 'Seven-fix review must retain the accepted baseline');
  assert.equal(latest?.canonical, 'https://www.cirvyk.xyz');
  assert.ok(Array.isArray(latest.changes) && latest.changes.length > 0, 'Seven fixes require an explicit reviewed change list');
  assert.ok(Array.isArray(latest.protectedFiles) && latest.protectedFiles.length > 0, 'Seven fixes must protect the existing implementation');
  const sevenReviewed = new Set();
  for (const entry of latest.changes) {
    assert.ok(isSevenFixesPath(entry.path), `Unreviewed seven-fix change: ${entry.path}`);
    assert.ok(!sevenReviewed.has(entry.path), `Duplicate seven-fix change: ${entry.path}`);
    assert.ok(entry.previousSha256 === null || /^[a-f0-9]{64}$/.test(entry.previousSha256), `Invalid seven-fix baseline digest: ${entry.path}`);
    sevenReviewed.add(entry.path);
    await verifyDigest(root, entry, 'Seven-fix reviewed bytes differ');
  }
  for (const required of ['scripts/verify-port.mjs', 'public/source-manifest.json']) {
    assert.ok(sevenReviewed.has(required), `The seven-fix review must include ${required}`);
  }
  for (const review of [provenance.branding, provenance.palette, provenance.walletAccess, provenance.publication, provenance.logo]) {
    for (const entry of review.protectedFiles) {
      assert.ok(!sevenReviewed.has(entry.path), `A prior review cannot still protect an authorized seven-fix overlap: ${entry.path}`);
      assert.ok(!HOST_MANAGED_METADATA.has(entry.path), `Host-managed metadata must not be byte-protected: ${entry.path}`);
    }
  }
  const publicPaths = [];
  async function walk(relative) {
    for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      const target = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await walk(target);
      else { assert.ok(entry.isFile() && !entry.isSymbolicLink(), `Only regular public files are allowed: ${target}`); publicPaths.push(target); }
    }
  }
  await walk('public');
  const expected = [...publicPaths, 'lib/observation.mjs'].sort();
  assert.deepEqual(provenance.files.map(file => file.path).sort(), expected, 'Every shipped public file must be in the original-byte manifest');
  for (const entry of provenance.files) {
    assert.ok(entry.path.startsWith('public/') || entry.path === 'lib/observation.mjs');
    const bytes = await fs.readFile(path.join(root, entry.path));
    assert.equal(bytes.byteLength, entry.bytes, `${entry.path} changed size`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, `${entry.path} changed from the authorized V1.1 port`);
  }
  assert.equal(provenance.branding.name, BRAND_NAME, 'Reviewed website identity must match configuration');
  const allowedBrandFiles = new Set([
    'README.md', 'docs/protocol.md', 'DEPLOYMENT.md', 'NOTICE.md',
    'public/index.html', 'public/config/site.js', 'public/modules/app.js',
    'public/modules/engine.js', 'public/modules/source-workspace.js',
    'public/assets/circuit-board.svg', 'public/assets/circuit-backplane.svg',
    'public/assets/circuit-icon.svg', 'public/favicon.svg', 'public/source-manifest.json',
  ]);
  for (const entry of provenance.branding.changes) {
    assert.ok(allowedBrandFiles.has(entry.path), `Unreviewed branding change: ${entry.path}`);
    const bytes = await fs.readFile(path.join(root, entry.path));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, `${entry.path} differs from reviewed branding`);
    assert.match(entry.previousSha256, /^[a-f0-9]{64}$/);
  }
  for (const entry of provenance.branding.protectedFiles) {
    const bytes = await fs.readFile(path.join(root, entry.path));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, `Branding must preserve ${entry.path}`);
  }
  const paletteFiles = new Set([
    'public/styles.css', 'public/restoration.css', 'public/workbench.css',
    'public/source-workspace.css', 'public/modules/dashboard.js',
    'public/assets/circuit-board.svg', 'public/assets/circuit-backplane.svg',
  ]);
  assert.equal(provenance.palette.accent, '#7fe03b');
  for (const entry of provenance.palette.changes) {
    assert.ok(paletteFiles.has(entry.path), `Unreviewed palette change: ${entry.path}`);
    const bytes = await fs.readFile(path.join(root, entry.path));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, `${entry.path} differs from the reviewed reference color`);
    assert.match(entry.previousSha256, /^[a-f0-9]{64}$/);
  }
  for (const entry of provenance.palette.protectedFiles) {
    const bytes = await fs.readFile(path.join(root, entry.path));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, `Palette must preserve ${entry.path}`);
  }
  const featureFiles = new Set([
    'README.md', 'docs/protocol.md', 'docs/wallet-assets.md',
    'public/index.html', 'public/config/site.js', 'public/modules/app.js',
    'public/modules/wallet.js', 'public/modules/source-workspace.js',
    'public/header-wallet.css', 'public/source-manifest.json',
    'public/assets/social-x.svg', 'public/assets/social-github.svg',
    'public/assets/wallets/okx.png', 'public/assets/wallets/phantom.svg',
    'public/assets/wallets/backpack.png', 'public/assets/wallets/coinbase.svg',
    'public/assets/wallets/solflare.svg',
  ]);
  for (const entry of provenance.walletAccess.changes) {
    assert.ok(featureFiles.has(entry.path), `Unreviewed wallet/header change: ${entry.path}`);
    const bytes = await fs.readFile(path.join(root, entry.path));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, `${entry.path} differs from reviewed wallet access`);
  }
  for (const entry of provenance.walletAccess.protectedFiles) {
    const bytes = await fs.readFile(path.join(root, entry.path));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, `Wallet access must preserve ${entry.path}`);
  }
  assert.equal(provenance.publication.repository, 'https://github.com/theovarne/CIRVYK');
  assert.equal(provenance.publication.displayTimeZone, 'America/New_York');
  const publicationPaths = new Set([
    'README.md', 'DEPLOYMENT.md', 'NOTICE.md', '.gitignore', '.env.example', 'package.json',
    'docs/protocol.md', 'docs/architecture.md', 'docs/development.md', 'docs/data-model.md',
    'docs/licenses/IBM-Plex-OFL.txt', 'docs/licenses/Inter-Tight-OFL.txt',
    'docs/media/cirvyk-header.jpg', 'docs/media/cirvyk-overview.jpg', 'docs/media/cirvyk-inspector.jpg',
    'public/index.html', 'public/modules/app.js', 'public/modules/dashboard.js',
    'public/modules/instruments.js', 'public/modules/source-workspace.js',
    'public/modules/workbench.js', 'public/modules/time.js', 'public/source-manifest.json',
  ]);
  for (const entry of provenance.publication.changes) {
    assert.ok(publicationPaths.has(entry.path), `Unreviewed publication change: ${entry.path}`);
    // Preserve historical review records without hashing host-managed metadata.
    // The existing semantic Vercel guard below remains the runtime contract.
    if (HOST_MANAGED_METADATA.has(entry.path)) continue;
    const bytes = await fs.readFile(path.join(root, entry.path));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, `${entry.path} differs from reviewed publication`);
  }
  for (const entry of provenance.publication.protectedFiles) {
    const bytes = await fs.readFile(path.join(root, entry.path));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, `Publication must preserve ${entry.path}`);
  }
  const logoPaths = new Set([
    'public/assets/circuit-icon.svg', 'public/favicon.svg', 'public/favicon.ico',
    'public/assets/brand/apple-touch-icon.png', 'public/assets/brand/icon-192.png',
    'public/assets/brand/icon-512.png', 'public/assets/brand/share-card.png',
    'public/index.html', 'public/config/site.js', 'public/source-manifest.json',
    'README.md', 'NOTICE.md', 'docs/media/cirvyk-header.jpg',
    'docs/media/cirvyk-overview.jpg', 'docs/media/cirvyk-inspector.jpg',
    'scripts/dev.mjs', 'scripts/verify-port.mjs', 'tests/mobile-assets.test.mjs',
  ]);
  assert.equal(provenance.logo?.brand, BRAND_NAME, 'Reviewed logo identity must match CIRVYK');
  assert.equal(provenance.logo.baseCommit, '4f02a7ccb739f71e20540ae8498115224d6b28ff');
  assert.ok(Array.isArray(provenance.logo.changes) && provenance.logo.changes.length > 0, 'Logo changes must be explicitly reviewed');
  assert.ok(Array.isArray(provenance.logo.protectedFiles) && provenance.logo.protectedFiles.length > 0, 'Logo review must protect existing implementation');
  const logoReviewed = new Set();
  for (const entry of provenance.logo.changes) {
    assert.ok(logoPaths.has(entry.path), `Unreviewed logo change: ${entry.path}`);
    assert.ok(!logoReviewed.has(entry.path), `Duplicate logo change: ${entry.path}`);
    logoReviewed.add(entry.path);
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    assert.ok(entry.previousSha256 === null || /^[a-f0-9]{64}$/.test(entry.previousSha256), `Invalid prior logo digest: ${entry.path}`);
    const bytes = await fs.readFile(path.join(root, entry.path));
    assert.equal(bytes.byteLength, entry.bytes, `${entry.path} differs from reviewed logo size`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, `${entry.path} differs from reviewed logo identity`);
  }
  assert.deepEqual([...logoReviewed].sort(), [...logoPaths].sort(), 'Every authorized logo asset and integration must be reviewed');
  const logoProtected = new Set();
  for (const entry of provenance.logo.protectedFiles) {
    assert.ok(typeof entry.path === 'string' && !path.isAbsolute(entry.path) && !entry.path.split('/').some(part => !part || part === '..'), 'Invalid logo-protected path');
    assert.ok(!logoPaths.has(entry.path) && !logoProtected.has(entry.path), `Invalid overlapping logo protection: ${entry.path}`);
    assert.ok(!HOST_MANAGED_METADATA.has(entry.path), `Host-managed metadata must retain its existing verification contract: ${entry.path}`);
    logoProtected.add(entry.path);
    const bytes = await fs.readFile(path.join(root, entry.path));
    assert.equal(bytes.byteLength, entry.bytes, `Logo update must preserve size: ${entry.path}`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, `Logo update must preserve ${entry.path}`);
  }
  for (const required of [...publicPaths, 'lib/observation.mjs', 'lib/vercel-api.mjs', 'api/config.mjs', 'api/observation.mjs']) {
    if (!logoPaths.has(required) && !sevenReviewed.has(required) && !runtimeReviewed.has(required) && !contractReviewed.has(required)) assert.ok(logoProtected.has(required), `Logo review must protect ${required}`);
  }
  const sevenProtected = new Set();
  for (const entry of latest.protectedFiles) {
    assert.ok(!sevenReviewed.has(entry.path) && !sevenProtected.has(entry.path), `Invalid overlapping seven-fix protection: ${entry.path}`);
    assert.ok(!HOST_MANAGED_METADATA.has(entry.path), `Host-managed metadata must retain semantic verification: ${entry.path}`);
    sevenProtected.add(entry.path);
    await verifyDigest(root, entry, 'Seven fixes must preserve implementation');
  }
  for (const required of [...publicPaths, 'lib/observation.mjs', 'lib/vercel-api.mjs', 'api/config.mjs', 'api/observation.mjs']) {
    if (!sevenReviewed.has(required) && !runtimeReviewed.has(required) && !contractReviewed.has(required)) assert.ok(sevenProtected.has(required), `Seven-fix review must protect ${required}`);
  }
  const deployment = JSON.parse(await fs.readFile(path.join(root, 'deployment-manifest.json'), 'utf8'));
  assert.equal(deployment.sourceCommit, provenance.sourceCommit);
  assert.equal(deployment.staticOutput, 'public');
  const portable = new Set();
  for (const entry of deployment.files) {
    assert.ok(!HOST_MANAGED_METADATA.has(entry.path), `Host-managed metadata cannot be hash-protected by the portable manifest: ${entry.path}`);
    assert.ok(!portable.has(entry.path), `Duplicate portable file: ${entry.path}`);
    portable.add(entry.path);
    await verifyDigest(root, entry, 'Portable source bytes differ');
    if (!sevenReviewed.has(entry.path) && !runtimeReviewed.has(entry.path) && !contractReviewed.has(entry.path) && entry.path !== 'provenance.json') {
      assert.ok(sevenProtected.has(entry.path), `The latest review must protect portable source: ${entry.path}`);
    }
  }
  for (const required of [...expected, ...sevenReviewed, ...runtimeReviewed, ...contractReviewed, 'provenance.json']) {
    assert.ok(portable.has(required), `Portable manifest omitted ${required}`);
  }
  const runtimeProtected = new Set();
  if (runtime) {
    for (const entry of runtime.protectedFiles) {
      assert.ok(!runtimeReviewed.has(entry.path) && !runtimeProtected.has(entry.path), `Invalid overlapping runtime protection: ${entry.path}`);
      assert.ok(!HOST_MANAGED_METADATA.has(entry.path), `Host-managed metadata must retain semantic verification: ${entry.path}`);
      runtimeProtected.add(entry.path);
      await verifyDigest(root, entry, 'Runtime additions must preserve implementation');
    }
    for (const required of portable) {
      if (!runtimeReviewed.has(required) && !contractReviewed.has(required) && required !== 'provenance.json') {
        assert.ok(runtimeProtected.has(required), `Runtime review must protect portable source: ${required}`);
      }
    }
    for (const reviewed of [...runtimeReviewed, ...runtimeProtected]) {
      assert.ok(portable.has(reviewed), `The portable manifest must include runtime-reviewed file: ${reviewed}`);
    }
  }
  const contractProtected = new Set();
  if (contractAddress) {
    for (const entry of contractAddress.protectedFiles) {
      assert.ok(!contractReviewed.has(entry.path) && !contractProtected.has(entry.path), `Invalid overlapping contract-address protection: ${entry.path}`);
      assert.ok(!HOST_MANAGED_METADATA.has(entry.path), `Host-managed metadata must retain semantic verification: ${entry.path}`);
      contractProtected.add(entry.path);
      await verifyDigest(root, entry, 'Contract-address activation must preserve implementation');
    }
    for (const required of portable) {
      if (!contractReviewed.has(required) && required !== 'provenance.json') {
        assert.ok(contractProtected.has(required), `Contract-address review must protect portable source: ${required}`);
      }
    }
    for (const reviewed of [...contractReviewed, ...contractProtected]) {
      assert.ok(portable.has(reviewed), `The portable manifest must include contract-address-reviewed file: ${reviewed}`);
    }
  }
  // Vercel rewrites its working config after upload. Protect its runtime contract,
  // while byte hashes above continue to cover the shipped assets and API sources.
  const config = JSON.parse(await fs.readFile(path.join(root, 'vercel.json'), 'utf8'));
  const expectedConfig = provenance.branding.protectedConfiguration;
  for (const key of ['framework', 'buildCommand', 'outputDirectory', 'functions', 'headers']) {
    assert.deepEqual(config[key], expectedConfig[key], `Branding must preserve Vercel ${key}`);
  }
  assert.equal(config.rewrites, undefined);
  assert.equal(config.routes, undefined);
  assert.ok((await syncBrand(root, { write: false })).matches, 'Static metadata must match the centralized website identity');
  const shipped = JSON.parse(await fs.readFile(path.join(root, 'public/source-manifest.json'), 'utf8'));
  const measured = await generatePublicSource(root, { write: false, generatedAt: shipped.generatedAt });
  assert.deepEqual(shipped, measured, 'Source must show the exact actual reviewed files and measured counts');
  return { verifiedFiles: provenance.files.length, brand: BRAND_NAME, accent: provenance.palette.accent, paletteChanges: provenance.palette.changes.length, brandingChanges: provenance.branding.changes.map(entry => entry.path), logoChanges: logoReviewed.size, sevenFixChanges: sevenReviewed.size, sevenFixProtected: sevenProtected.size, runtimeChanges: runtimeReviewed.size, runtimeProtected: runtimeProtected.size, contractAddressChanges: contractReviewed.size, contractAddressProtected: contractProtected.size, portableFiles: portable.size, protectedFiles: logoProtected.size + 1, sourceFiles: measured.stats.files, sourceBytes: measured.stats.bytes, sourceCommit: provenance.sourceCommit };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await verifyPort()));
}
