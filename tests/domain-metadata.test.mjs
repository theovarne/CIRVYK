import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {SITE} from '../public/config/site.js';
import {syncBrand} from '../scripts/sync-brand.mjs';

test('the formal domain owns canonical and share identity without changing hash routes', async () => {
  assert.equal(SITE.canonical,'https://www.cirvyk.xyz');
  const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
  assert.equal((html.match(/rel="canonical"/g)||[]).length,1);
  assert.match(html,/<link rel="canonical" href="https:\/\/www\.cirvyk\.xyz\/">/);
  for (const key of ['og:url','og:image','twitter:image']) {
    const tag=html.match(new RegExp(`<meta (?:property|name)="${key}"[^>]*>`))?.[0];
    assert.ok(tag,`${key} must be present`);
    assert.match(tag,/content="https:\/\/www\.cirvyk\.xyz\//);
  }
  assert.match(html,/href="#circuit" data-nav="circuit"/);
  assert.doesNotMatch(html,/circuit-living-v11\.vercel\.app/);
});

test('metadata synchronization repairs stale canonical/share fields and stays idempotent', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'cirvyk-domain-'));
  try {
    await mkdir(path.join(root,'public'));
    const filename=path.join(root,'public/index.html');
    await writeFile(filename,'<!doctype html><html><head><title>Old</title><link rel="canonical" href="https://old.invalid/"><meta property="og:url" content="https://old.invalid/"><meta property="og:image" content="https://old.invalid/share.png"><meta name="twitter:image" content="https://old.invalid/share.png"></head><body><span data-brand>Old</span></body></html>');
    assert.equal((await syncBrand(root)).matches,false);
    assert.equal((await syncBrand(root,{write:false})).matches,true);
    const html=await readFile(filename,'utf8');
    assert.doesNotMatch(html,/old\.invalid/);
    assert.equal((html.match(/rel="canonical"/g)||[]).length,1);
    assert.equal((html.match(/share-card\.png\?v=cube-1/g)||[]).length,2);
  } finally {await rm(root,{recursive:true,force:true});}
});
