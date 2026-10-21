import { BRAND_NAME } from '../public/config/site.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {generatePublicSource, PUBLIC_SOURCE_FILES, SOURCE_SCHEMA, countSourceLines} from '../scripts/generate-public-source.mjs';
import {PUBLIC_SOURCE_PATHS, tokenizeSource, validatePublicManifest, mountSourceWorkspace} from '../public/modules/source-workspace.js';
import {sourceDocument} from './helpers/source-dom.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const date = '2026-10-17T08:00:00.000Z';
const required = ['public/config/rules.js', 'public/config/site.js', 'public/modules/engine.js'];
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'circuit-public-source-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  for (const filename of required) { await fs.mkdir(path.dirname(path.join(root, filename)), {recursive: true}); await fs.writeFile(path.join(root, filename), 'export const publicValue = 1;\n'); }
  return root;
}
const manifestFile = (content = 'export const n = 1;\n') => ({path: 'public/modules/engine.js', language: 'javascript', bytes: Buffer.byteLength(content), lines: countSourceLines(content), content});
const manifest = files => ({schema: SOURCE_SCHEMA, generatedAt: date, stats: {files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0), lines: files.reduce((n, f) => n + f.lines, 0)}, files});

test('the build and browser use the same bounded public allowlist', () => {
  assert.deepEqual(PUBLIC_SOURCE_FILES, PUBLIC_SOURCE_PATHS);
  assert.ok(PUBLIC_SOURCE_FILES.length <= 26);
  for (const filename of PUBLIC_SOURCE_FILES) assert.doesNotMatch(filename, /(^|\/)\.env|\.openai|\.git|observation\.mjs|api\/|server|credentials/);
});

test('the actual project manifest contains exact file content and measured counts', async () => {
  const output = await generatePublicSource(project, {write: false, generatedAt: date});
  assert.equal(output.schema, SOURCE_SCHEMA);
  assert.equal(output.generatedAt, date);
  assert.deepEqual(validatePublicManifest(output).stats, output.stats);
  for (const file of output.files) {
    assert.ok(PUBLIC_SOURCE_FILES.includes(file.path));
    assert.equal(file.content, await fs.readFile(path.join(project, file.path), 'utf8'));
    assert.equal(file.bytes, Buffer.byteLength(file.content));
    assert.equal(file.lines, countSourceLines(file.content));
  }
  assert.ok(output.files.some(file => file.path === 'public/modules/engine.js'));
  assert.ok(output.files.some(file => file.path === 'README.md'));
});

test('the public controller, page markup and every shipped stylesheet are indexed with their actual language', async () => {
  const output = await generatePublicSource(project, {write: false, generatedAt: date});
  const expected = [
    ['public/modules/app.js', 'javascript'], ['public/index.html', 'html'],
    ...(await fs.readdir(path.join(project, 'public'))).filter(name => name.endsWith('.css')).map(name => [`public/${name}`, 'css']),
  ];
  assert.equal(expected.length, 9);
  for (const [filename, language] of expected) {
    assert.ok(PUBLIC_SOURCE_FILES.includes(filename), `${filename} must be an explicit reviewed entry`);
    const file = output.files.find(file => file.path === filename);
    assert.equal(file?.language, language);
    assert.equal(file.content, await fs.readFile(path.join(project, filename), 'utf8'));
  }
  assert.equal(output.stats.files, output.files.length);
});

test('unlisted env, hosting, server, and arbitrary files never enter the manifest', async t => {
  const root = await fixture(t);
  for (const filename of ['.env', '.openai/hosting.json', 'lib/observation.mjs', 'public/arbitrary.js']) {
    await fs.mkdir(path.dirname(path.join(root, filename)), {recursive: true});
    await fs.writeFile(path.join(root, filename), 'PRIVATE_MATERIAL_MUST_NOT_BE_PUBLISHED');
  }
  const output = await generatePublicSource(root, {generatedAt: date});
  assert.deepEqual(output.files.map(file => file.path).sort(), required.sort());
  const saved = await fs.readFile(path.join(root, 'public/source-manifest.json'), 'utf8');
  assert.doesNotMatch(saved, /PRIVATE_MATERIAL/);
  assert.deepEqual(JSON.parse(saved), output);
});

test('missing required public rules stop generation', async t => {
  const root = await fixture(t);
  await fs.unlink(path.join(root, 'public/config/rules.js'));
  await assert.rejects(generatePublicSource(root, {write: false}), {code: 'ENOENT'});
});

test('symlinked public files cannot publish a private source', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, '.private'), 'do not publish');
  await fs.unlink(path.join(root, 'public/config/site.js'));
  await fs.symlink(path.join(root, '.private'), path.join(root, 'public/config/site.js'));
  await assert.rejects(generatePublicSource(root, {write: false}), /regular local file/);
});

test('credential-like material in an otherwise approved file fails closed', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'public/config/site.js'), "export const key = 'ghp_1234567890abcdefghijklmnop';\n");
  await assert.rejects(generatePublicSource(root, {write: false}), /Private credential-like material/);
  await assert.rejects(fs.access(path.join(root, 'public/source-manifest.json')));
});

test('new controller, HTML and CSS entries retain the same credential rejection boundary', async t => {
  const root = await fixture(t);
  for (const filename of ['public/modules/app.js', 'public/index.html', 'public/styles.css']) {
    await fs.writeFile(path.join(root, filename), '/* ghp_1234567890abcdefghijklmnop */');
    await assert.rejects(generatePublicSource(root, {write: false}), /Private credential-like material/);
    await fs.unlink(path.join(root, filename));
  }
});

test('binary and oversized approved files are refused', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'public/config/site.js'), 'a\0b');
  await assert.rejects(generatePublicSource(root, {write: false}), /Non-text/);
  await fs.writeFile(path.join(root, 'public/config/site.js'), 'x'.repeat(300_001));
  await assert.rejects(generatePublicSource(root, {write: false}), /exceeds/);
});

test('source tokens preserve markup and every original character as inert text', () => {
  const samples = [
    ['javascript', 'export const value = "<img src=x onerror=alert(1)>";\n/* block\ncomment */\nconst n = 60_000;\n'],
    ['javascript', 'const value = `line1\n${neverEvaluate()} <script>throw 1</script>`; // exact\n'],
    ['markdown', '# Actual documentation\n<script>alert(1)</script>\n- source text\n```js\nconst n = 1;\n```\n'],
    ['json', '{"unsafe":"</code><script>run()</script>","count":12}\n'],
    ['html', '<!doctype html>\r\n<!-- never rendered -->\n<section data-name="value"><img src=x onerror="run()"><script>run()</script></section>\n'],
    ['css', '/* never injected */\r\n:root { --accent: #75dcd7; }\n.panel:hover { width: calc(100% - 2px); content: "</style><script>run()</script>"; }\n'],
  ];
  for (const [language, content] of samples) {
    const tokens = tokenizeSource(content, language);
    assert.equal(tokens.map(token => token.text).join(''), content);
    assert.ok(tokens.every(token => ['plain', 'heading', 'comment', 'keyword', 'function', 'string', 'number', 'punctuation'].includes(token.kind)));
  }
});

test('HTML and CSS lexers distinguish structure, attributes, declarations and values without parsing them', () => {
  const html = tokenizeSource('<main class="console"><!-- note --></main>', 'html');
  assert.ok(html.some(token => token.kind === 'keyword' && token.text === 'main'));
  assert.ok(html.some(token => token.kind === 'function' && token.text === 'class'));
  assert.ok(html.some(token => token.kind === 'string' && token.text === '"console"'));
  assert.ok(html.some(token => token.kind === 'comment' && token.text === '<!-- note -->'));
  const css = tokenizeSource('@media (min-width: 760px) { .panel { color: #75dcd7; } }', 'css');
  assert.ok(css.some(token => token.kind === 'keyword' && token.text === '@media'));
  assert.ok(css.some(token => token.kind === 'keyword' && token.text === 'color'));
  assert.ok(css.some(token => token.kind === 'function' && token.text === '.panel'));
  assert.ok(css.some(token => token.kind === 'number' && token.text === '#75dcd7'));
  for (const [language, content] of [['html', '<p title="unfinished'], ['html', '<!-- unfinished'], ['css', '/* unfinished'], ['css', '.x { content: "unfinished']]) assert.equal(tokenizeSource(content, language).map(token => token.text).join(''), content);
});

test('the workspace never inserts source content through HTML or evaluation APIs', async () => {
  const content = await fs.readFile(path.join(project, 'public/modules/source-workspace.js'), 'utf8');
  assert.doesNotMatch(content, /\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML\s*\(|\beval\s*\(|new\s+Function\s*\(/);
  assert.match(content, /node\.textContent = text/);
});

test('manifest validation rejects private paths, duplicates, and false statistics', () => {
  assert.throws(() => validatePublicManifest(manifest([{...manifestFile(), path: '.env'}])), /path/);
  assert.throws(() => validatePublicManifest(manifest([{...manifestFile(), path: '../public/modules/engine.js'}])), /path/);
  assert.throws(() => validatePublicManifest(manifest([manifestFile(), manifestFile()])), /path/);
  const falseStats = manifest([manifestFile()]); falseStats.stats.bytes++;
  assert.throws(() => validatePublicManifest(falseStats), /statistics/);
  const falseFileSize = manifest([manifestFile()]); falseFileSize.files[0].bytes++;
  assert.throws(() => validatePublicManifest(falseFileSize), /file/);
});

test('manifest validation bounds payload and accepts source text with HTML characters', () => {
  const content = '<script>inert();</script>\n';
  assert.equal(validatePublicManifest(manifest([manifestFile(content)])).files[0].content, content);
  assert.throws(() => validatePublicManifest(manifest([manifestFile('a'.repeat(300_001))])), /file/);
});

test('line counts match editor rows for LF, CRLF, CR and trailing newlines', () => {
  for (const [text, expected] of [['', 0], ['one', 1], ['one\n', 1], ['one\ntwo\n', 2], ['one\r\ntwo\r\n', 2], ['one\rtwo', 2]]) assert.equal(countSourceLines(text), expected);
});

async function mountedWorkspace(t, clipboard, files = [manifestFile(), {...manifestFile('export const rule = 60;\n'), path: 'public/config/rules.js'}]) {
  const doc = sourceDocument(clipboard), root = doc.createElement('div');
  const workspace = mountSourceWorkspace(root, {fetch: async () => ({ok: true, text: async () => JSON.stringify(manifest(files))})});
  t.after(() => workspace.destroy()); await workspace.ready;
  return {doc, root, workspace, copy: root.querySelectorAll('.src-copy')[0], status: root.querySelectorAll('.src-status')[0]};
}

test('HTML and CSS file switching preserves exact copied text and creates only inert code rows', async t => {
  const html = '<main><img src="https://invalid.test/pixel" onerror="run()">\n<script>run()</script></main>\n';
  const css = '.panel { content: "</style><script>run()</script>"; color: #75dcd7; }\n';
  const files = [
    {...manifestFile(html), path: 'public/index.html', language: 'html'},
    {...manifestFile(css), path: 'public/styles.css', language: 'css'},
  ];
  const copied = [], {root, workspace, copy} = await mountedWorkspace(t, {writeText: async text => { copied.push(text); }}, files);
  for (const file of files) {
    assert.ok(workspace.selectFile(file.path));
    const rows = root.querySelectorAll('.src-code-lines')[0].children;
    assert.equal(rows.length, file.lines);
    assert.equal(rows.map(row => row.textContent).join('\n') + '\n', file.content);
    assert.equal(root.querySelectorAll('img').length, 0);
    assert.equal(root.querySelectorAll('script').length, 0);
    assert.equal(root.querySelectorAll('style').length, 0);
    await copy.dispatch('click');
  }
  assert.deepEqual(copied, [html, css]);
});

test('a late clipboard result cannot mark a different selected source file as copied', async t => {
  let finish; const written = [];
  const {workspace, copy, status} = await mountedWorkspace(t, {writeText: text => { written.push(text); return new Promise(resolve => { finish = resolve; }); }});
  const pending = copy.dispatch('click');
  assert.equal(copy.textContent, 'Copying…');
  workspace.selectFile('public/config/rules.js'); finish(); await pending;
  assert.deepEqual(written, ['export const n = 1;\n']);
  assert.equal(copy.textContent, 'Copy file');
  assert.equal(status.textContent, 'public/config/rules.js selected');
});

test('clipboard denial remains recoverable and an outdated failure does not replace file selection', async t => {
  let fail;
  const {workspace, copy, status} = await mountedWorkspace(t, {writeText: () => new Promise((resolve, reject) => { fail = reject; })});
  const first = copy.dispatch('click'); fail(new Error('denied')); await first;
  assert.equal(copy.textContent, 'Copy unavailable');
  assert.match(status.textContent, /Select text in the code region/);
  const second = copy.dispatch('click'); workspace.selectFile('public/config/rules.js'); fail(new Error('denied')); await second;
  assert.equal(copy.textContent, 'Copy file');
  assert.equal(status.textContent, 'public/config/rules.js selected');
});

test('file filtering keeps the open source and keyboard traversal skips collapsed branches', async t => {
  const {doc, root, workspace} = await mountedWorkspace(t, {writeText: async () => {}});
  const tree = root.querySelectorAll('.src-tree')[0], search = root.querySelectorAll('input')[0];
  const buttons = tree.querySelectorAll('button[data-source-path]');
  const branch = buttons.find(button => button.dataset.sourcePath === 'public/modules/engine.js').parentElement.parentElement;
  branch.open = false; tree.querySelectorAll('summary')[0].focus();
  let prevented = false; await tree.dispatch('keydown', {key: 'End', preventDefault() { prevented = true; }});
  assert.ok(prevented); assert.notEqual(doc.activeElement.dataset.sourcePath, 'public/modules/engine.js');
  search.value = 'no-matching-file'; await search.dispatch('input');
  assert.equal(tree.querySelectorAll('button').length, 0);
  assert.equal(workspace.selectedPath, 'public/modules/engine.js');
  search.value = 'rules'; await search.dispatch('input');
  assert.deepEqual(tree.querySelectorAll('button').map(button => button.dataset.sourcePath), ['public/config/rules.js']);
});

test('Source identity and heading use the configured application brand', async t => {
  const {root} = await mountedWorkspace(t, {writeText: async () => {}});
  assert.equal(root.querySelectorAll('.src-release-identity')[0].textContent, `PUBLIC PROJECT SOURCE${BRAND_NAME} / implementation`);
  assert.equal(root.querySelectorAll('.src-about')[0].querySelectorAll('h2')[0].textContent, `${BRAND_NAME} / source`);
});
