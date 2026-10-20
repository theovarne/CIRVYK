import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { generatePublicSource } from './generate-public-source.mjs';
import { syncBrand } from './sync-brand.mjs';
import { BRAND_NAME } from '../public/config/site.js';

export async function verifyPort(root = fileURLToPath(new URL('../', import.meta.url))) {
  const provenance = JSON.parse(await fs.readFile(path.join(root, 'provenance.json'), 'utf8'));
  assert.equal(provenance.sourceCommit, 'a11f3f07d0faccf699a2772a47c70767b4cad3a0');
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
    const bytes = await fs.readFile(path.join(root, entry.path));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, `${entry.path} differs from reviewed publication`);
  }
  for (const entry of provenance.publication.protectedFiles) {
    const bytes = await fs.readFile(path.join(root, entry.path));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, `Publication must preserve ${entry.path}`);
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
  return { verifiedFiles: provenance.files.length, brand: BRAND_NAME, accent: provenance.palette.accent, paletteChanges: provenance.palette.changes.length, brandingChanges: provenance.branding.changes.map(entry => entry.path), protectedFiles: provenance.publication.protectedFiles.length + 1, sourceFiles: measured.stats.files, sourceBytes: measured.stats.bytes, sourceCommit: provenance.sourceCommit };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await verifyPort()));
}
