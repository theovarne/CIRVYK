import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {formatEasternRange} from '../public/modules/time.js';
import { BRAND_NAME, SITE } from '../public/config/site.js';
import { buildExample, finalizeWindow, TRACE_SCHEMA } from '../public/modules/engine.js';
import { exportTrace, MEMORY_KEY, MEMORY_SCHEMA } from '../public/modules/memory.js';

const app = fs.readFileSync(new URL('../public/modules/app.js', import.meta.url), 'utf8');
function shippedFunction(name) {
  const marker = new RegExp(`(?:async )?function ${name}\\(`).exec(app);
  assert.ok(marker, `Missing shipped function ${name}`);
  const lineEnd = app.indexOf('\n', marker.index), firstLine = app.slice(marker.index, lineEnd);
  if (firstLine.endsWith('}')) return firstLine;
  const end = app.indexOf('\n}', lineEnd);
  assert.notEqual(end, -1, `Missing function boundary for ${name}`);
  return app.slice(marker.index, end + 2);
}
const trace = () => finalizeWindow(buildExample('burst'));

test('the actual Snapshot renderer paints the centralized brand into the PNG canvas and preserves its evidence text', async () => {
  const selected = trace(), painted = [], downloads = [], revoked = [], messages = [];
  let rendered = null, redraws = 0, imageDraws = 0, encodedType = null;
  const context2d = {
    fillStyle: '', font: '', fillRect() {},
    fillText(text, x, y) { painted.push({ text, x, y, font: this.font }); },
    drawImage() { imageDraws++; },
  };
  const canvas = {
    width: 0, height: 0, getContext(type) { assert.equal(type, '2d'); return context2d; },
    toBlob(callback, type) { encodedType = type; callback(new Blob(['rendered canvas bytes'], { type })); },
  };
  class Image {
    naturalWidth = 1440; naturalHeight = 810;
    set src(value) { this.uri = value; queueMicrotask(() => this.onload()); }
  }
  const context = {
    BRAND_NAME, SITE, Blob, Image, formatEasternRange,
    renderer: { ready: Promise.resolve(), error: null, setResult(value) { rendered = value; }, snapshotSvg() { return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1440 810"/>'; } },
    document: { createElement(tag) { assert.equal(tag, 'canvas'); return canvas; } },
    URL: { createObjectURL() { return 'blob:actual-snapshot-svg'; }, revokeObjectURL(value) { revoked.push(value); } },
    notify(message) { messages.push(message); }, traceLabel: () => 'Example inputs',
    utc: value => new Date(value).toISOString(), time: value => new Date(value).toISOString(),
    download(blob, name) { downloads.push({ blob, name }); }, renderStage() { redraws++; },
  };
  vm.createContext(context); vm.runInContext(shippedFunction('exportSnapshot'), context);
  await context.exportSnapshot(selected);
  assert.equal(BRAND_NAME, 'CIRVYK');
  assert.equal(SITE.brand.name, BRAND_NAME);
  assert.equal(rendered, selected);
  assert.deepEqual(painted[0], { text: BRAND_NAME, x: 55, y: 70, font: '38px sans-serif' });
  assert.ok(painted.some(row => row.text.includes('EXAMPLE INPUTS / SAVED TRACE SNAPSHOT')));
  assert.ok(painted.some(row => row.text.includes(`${selected.count} valid inputs`) && row.text.includes(selected.path)));
  assert.ok(painted.some(row => row.text.includes(selected.rulesVersion)));
  assert.ok(painted.some(row => row.text.includes(selected.source.scopeId)));
  assert.ok(painted.some(row => row.text.includes('2026-10-15 20:05:00 EDT') && row.text.includes('20:06:00 EDT')));
  assert.ok(!painted.some(row => row.text.includes('2026-10-16T00:05:00')));
  assert.equal(painted.some(row => row.text.includes('Living Circuit')), false);
  assert.equal(canvas.width, 1600); assert.equal(canvas.height, 1120);
  assert.equal(imageDraws, 1); assert.equal(encodedType, 'image/png');
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].name, `cirvyk-snapshot-${selected.id}.png`);
  assert.equal(downloads[0].blob.type, 'image/png');
  assert.deepEqual(revoked, ['blob:actual-snapshot-svg']);
  assert.equal(redraws, 1);
  assert.ok(messages.includes('Snapshot PNG download started.'));
});

test('single Trace and saved-memory exports use the new filenames without changing stored keys or JSON schemas', async () => {
  const selected = trace(), downloads = [];
  const context = {
    BRAND_NAME, SITE, Blob, exportTrace,
    S: { saved: [selected], detailId: selected.id },
    notify() {}, syncSavedMemory: () => true,
    download(blob, name) { downloads.push({ blob, name }); },
  };
  const marker = "$('#memoryDetail').addEventListener('click',async e=>";
  const start = app.indexOf(marker), end = app.indexOf('\n});', start);
  assert.notEqual(start, -1); assert.notEqual(end, -1);
  let callback;
  context.$ = selector => {
    assert.equal(selector, '#memoryDetail');
    return { addEventListener(type, listener) { assert.equal(type, 'click'); callback = listener; } };
  };
  vm.createContext(context);
  vm.runInContext(app.slice(start, end + 4), context);
  await callback({ target: { closest(selector) { return selector === '[data-memory-action]' ? { dataset: { memoryAction: 'json' } } : null; } } });
  vm.runInContext(shippedFunction('exportSavedMemory'), context);
  context.exportSavedMemory();
  assert.equal(downloads[0].name, `cirvyk-trace-${selected.id}.json`);
  assert.deepEqual(JSON.parse(await downloads[0].blob.text()), selected);
  assert.equal(downloads[1].name, 'cirvyk-saved-traces.json');
  const saved = JSON.parse(await downloads[1].blob.text());
  assert.equal(MEMORY_KEY, 'circuit.traces.v1');
  assert.equal(MEMORY_SCHEMA, 'circuit.memory.v1');
  assert.equal(TRACE_SCHEMA, 'circuit.trace.v1');
  assert.equal(saved.schema, MEMORY_SCHEMA);
  assert.deepEqual(saved.traces, [selected]);
});
