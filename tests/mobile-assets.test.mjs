import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { buildExample, finalizeWindow } from '../public/modules/engine.js';
import { buildInstrumentModel } from '../public/modules/instruments.js';

// Use the CSS parser already supplied by the declared Tailwind build plugin.
const require = createRequire(import.meta.url);
const postcss = require('postcss');
const css = postcss.parse(await readFile(new URL('../public/restoration.css', import.meta.url), 'utf8'));
function declarations(selector, width) {
  const result = {};
  css.walkRules(rule => {
    if (!rule.selectors.includes(selector)) return;
    for (let parent = rule.parent; parent; parent = parent.parent) {
      if (parent.type !== 'atrule' || parent.name !== 'media') continue;
      const max = parent.params.match(/max-width:\s*(\d+)px/), min = parent.params.match(/min-width:\s*(\d+)px/);
      if (max && width > Number(max[1]) || min && width < Number(min[1]) || !max && !min) return;
    }
    rule.walkDecls(declaration => { result[declaration.prop] = declaration.value; });
  });
  return result;
}

test('all 60 UTC buckets fit phone widths as 44px targets without a fixed-height clipping row', () => {
  const trace = finalizeWindow(buildExample('burst'));
  const model = buildInstrumentModel(trace, { bucketMs: 1000 });
  assert.equal(model.bins.length, 60);
  for (const width of [320, 375, 390, 430, 600]) {
    const grid = declarations('.time-grid', width), cell = declarations('.grid-cell', width);
    const [minimum] = grid['grid-template-columns'].match(/minmax\((\d+)px,\s*1fr\)/).slice(1).map(Number);
    assert.match(grid['grid-template-columns'], /auto-fit/);
    assert.ok(minimum >= 44 && parseFloat(cell['min-width']) >= 44 && parseFloat(cell['min-height']) >= 44);
    const gap = parseFloat(grid.gap), horizontalPadding = 24;
    const available = width - horizontalPadding;
    const columns = Math.floor((available + gap) / (minimum + gap));
    const actualCellWidth = (available - (columns - 1) * gap) / columns;
    assert.ok(actualCellWidth >= 44 && columns * actualCellWidth + (columns - 1) * gap <= available + .001);
    assert.ok(Math.ceil(model.bins.length / columns) * columns >= 60);
    assert.equal(grid.overflow, 'visible');
    assert.equal(declarations('.instrument-grid', width)['grid-auto-rows'], 'auto');
    assert.equal(declarations('.activity-instrument', width).height, 'auto');
  }
  // The desktop density remains independent of the larger phone targets.
  assert.equal(declarations('.time-grid', 1440)['grid-template-columns'], 'repeat(12,minmax(0,1fr))');
});

test('favicon links resolve to real SVG and three bounded ICO images', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const links = [...html.matchAll(/<link\b[^>]*rel="icon"[^>]*>/g)].map(match => match[0]);
  assert.equal(links.length, 2);
  for (const link of links) {
    const href = link.match(/href="([^"]+)"/)[1];
    assert.ok(['/favicon.svg', '/favicon.ico'].includes(href));
    assert.ok((await stat(new URL(`../public${href}`, import.meta.url))).size > 0);
  }
  const svg = await readFile(new URL('../public/favicon.svg', import.meta.url), 'utf8');
  assert.equal(svg.trim(), (await readFile(new URL('../public/assets/circuit-icon.svg', import.meta.url), 'utf8')).trim());
  assert.doesNotMatch(svg, /<script|<foreignObject|href=|\son\w+=/i);
  const ico = await readFile(new URL('../public/favicon.ico', import.meta.url));
  assert.equal(ico.readUInt16LE(0), 0); assert.equal(ico.readUInt16LE(2), 1); assert.equal(ico.readUInt16LE(4), 3);
  const sizes = [];
  for (let index = 0; index < 3; index++) {
    const at = 6 + index * 16, width = ico[at], height = ico[at + 1];
    const bytes = ico.readUInt32LE(at + 8), offset = ico.readUInt32LE(at + 12);
    assert.equal(width, height); sizes.push(width);
    assert.ok(offset >= 54 && offset + bytes <= ico.length);
    assert.equal(ico.subarray(offset, offset + 8).toString('hex'), '89504e470d0a1a0a');
  }
  assert.deepEqual(sizes.sort((a,b) => a-b), [16,32,48]);
  assert.match(html, /<main\b[^>]*id="main"[^>]*tabindex="-1"/);
});
