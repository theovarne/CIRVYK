import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as identity from '../public/config/site.js';
import {TRACE_SCHEMA, RULES, buildExample, finalizeWindow} from '../public/modules/engine.js';
import {MEMORY_KEY, MEMORY_SCHEMA, loadTraces, saveTrace} from '../public/modules/memory.js';
import {SOURCE_SCHEMA} from '../scripts/generate-public-source.mjs';
import {syncBrand} from '../scripts/sync-brand.mjs';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const text = markup => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const attribute = (tag, name) => tag.match(new RegExp(`\\b${name}=["']([^"']*)["']`, 'i'))?.[1];

test('the supplied CIRVYK identity is shared by configuration and the initial accessible page', async () => {
  assert.equal(identity.BRAND_NAME, 'CIRVYK');
  assert.equal(identity.SITE.brand.name, identity.BRAND_NAME);
  assert.notEqual(identity.SITE.brand.workingTitle, true, 'the supplied name is no longer a working title');
  const html = await read('public/index.html');
  const title = text(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '');
  assert.match(title, /^CIRVYK(?:\s|$)/);
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  const ogTitle = tags.find(tag => attribute(tag, 'property') === 'og:title');
  assert.equal(attribute(ogTitle ?? '', 'content'), title, 'the share title must match the visible document title');
  for (const [key, name] of [['name', 'application-name'], ['property', 'og:site_name'], ['name', 'twitter:title']]) {
    const tag = tags.find(item => attribute(item, key) === name);
    assert.equal(attribute(tag ?? '', 'content'), 'CIRVYK', `${name} must identify the supplied brand`);
  }
  const marks = [...html.matchAll(/<([\w-]+)\b[^>]*\bdata-brand(?=[\s=>])[^>]*>([\s\S]*?)<\/\1>/gi)];
  assert.ok(marks.length >= 3, 'header, hero and footer must identify the supplied brand before JS runs');
  for (const mark of marks) assert.equal(text(mark[2]), 'CIRVYK');
  const homeBrand = html.match(/<a\b[^>]*class=["'][^"']*\bbrand\b[^"']*["'][^>]*>/i)?.[0] ?? '';
  assert.match(attribute(homeBrand, 'aria-label') ?? '', /CIRVYK/);
  const header = html.match(/<header\b[^>]*class=["'][^"']*\bsite-header\b[^"']*["'][^>]*>([\s\S]*?)<\/header>/i)?.[1] ?? '';
  const headerBrand = header.match(/<a\b[^>]*class=["'][^"']*\bbrand\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? '';
  assert.equal(text(headerBrand), 'CIRVYK', 'the header wordmark must not duplicate the name or append a version');
  const footer = html.match(/<footer\b[^>]*class=["'][^"']*\bsite-footer\b[^"']*["'][^>]*>([\s\S]*?)<\/footer>/i)?.[1] ?? '';
  assert.match(text(footer), /CIRVYK \/ Deterministic signal system/, 'static brand synchronization must retain the footer descriptor');
  assert.doesNotMatch(text(html), /Circuit remains a replaceable working title|Replaceable Circuit working icon/i);
});

test('Core keeps the existing circuit route while the ordinary circuit concept remains readable', async () => {
  const html = await read('public/index.html');
  const navigation = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)]
    .find(match => attribute(`<a ${match[1]}>`, 'data-nav') === 'circuit');
  assert.ok(navigation, 'the physical circuit page must remain in navigation');
  assert.equal(attribute(`<a ${navigation[1]}>`, 'href'), '#circuit');
  assert.equal(text(navigation[2]), 'Core');
  const coreHeading = html.match(/<section\b[^>]*\bdata-page=["']circuit["'][^>]*>[\s\S]*?<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? '';
  assert.equal(text(coreHeading), 'CIRVYK Core', 'synchronizing the nested brand must retain the Core heading suffix');
  const visible = text(html);
  assert.match(visible, /\ba circuit\b/, 'a brand rename must not replace the ordinary electronics term');
  assert.match(visible, /Sensor/);
  assert.match(visible, /Memory/);
});

test('all seven runtime page titles and the generated static identity agree', async () => {
  for (const [page, title] of Object.entries({home: 'CIRVYK', live: 'Live | CIRVYK', circuit: 'Core | CIRVYK', memory: 'Memory | CIRVYK', source: 'Source | CIRVYK', workbench: 'Workbench | CIRVYK', protocol: 'Protocol | CIRVYK'})) {
    assert.equal(identity.pageTitle(page), title);
  }
  const result = await syncBrand(undefined, {write: false});
  assert.equal(result.brand, 'CIRVYK');
  assert.equal(result.matches, true, 'the delivered HTML must already contain its generated metadata and wordmarks');
  const html = await read('public/index.html');
  assert.equal(text(html.match(/<title>(.*?)<\/title>/i)?.[1] ?? ''), identity.pageTitle('home'));
});

test('records saved before the rename remain readable under their existing storage and schema contracts', async () => {
  assert.equal(TRACE_SCHEMA, 'circuit.trace.v1');
  assert.equal(RULES.version, 'living-circuit.v1');
  assert.equal(MEMORY_KEY, 'circuit.traces.v1');
  assert.equal(MEMORY_SCHEMA, 'circuit.memory.v1');
  assert.equal(SOURCE_SCHEMA, 'living-circuit.public-source.v1');
  const trace = finalizeWindow(buildExample('burst'));
  const previous = JSON.stringify({schema: 'circuit.memory.v1', traces: [trace]});
  const values = new Map([['circuit.traces.v1', previous]]);
  const storage = {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value))};
  const loaded = loadTraces(storage);
  assert.equal(loaded.error, null);
  assert.deepEqual(loaded.traces, [trace]);
  const saved = saveTrace(trace, storage);
  assert.equal(saved.error, null);
  assert.deepEqual([...values.keys()], ['circuit.traces.v1']);
  assert.equal(JSON.parse(values.get('circuit.traces.v1')).schema, 'circuit.memory.v1');
  const app = await read('public/modules/app.js');
  for (const [name, expected] of [['PROVENANCE_KEY', 'circuit.imported-traces.v1'], ['TRUSTED_KEY', 'circuit.observed-traces.v1']]) {
    assert.equal(app.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`))?.[1], expected);
  }
});

test('SVG identity and engraved marks use CIRVYK without renaming the technical asset contracts', async () => {
  for (const path of ['assets/circuit-board.svg', 'assets/circuit-backplane.svg', 'assets/circuit-icon.svg', 'favicon.svg']) {
    const svg = await read(`public/${path}`);
    const outer = svg.match(/<svg\b[^>]*>/i)?.[0] ?? '';
    assert.match(attribute(outer, 'aria-label') ?? '', /CIRVYK/, `${path} needs the current accessible identity`);
    const labels = [...svg.matchAll(/<(?:text|title)\b[^>]*>([\s\S]*?)<\/(?:text|title)>/gi)].map(match => text(match[1]));
    assert.ok(!labels.some(label => label === 'CIRCUIT' || /^Circuit\s*·/.test(label)), `${path} still exposes the former brand`);
    assert.doesNotMatch(svg, /Replaceable Circuit working icon|\bOHMIUM\b/i);
    for (const mark of svg.matchAll(/<text\b[^>]*class=["'][^"']*(?:core-mark|backplane-mark)[^"']*["'][^>]*>([\s\S]*?)<\/text>/gi)) {
      assert.equal(text(mark[1]), 'CIRVYK');
    }
  }
  const board = await read('public/assets/circuit-board.svg');
  assert.match(board, /data-component=["']circuit["']/, 'the passive circuit support keeps its existing technical ID');
});
