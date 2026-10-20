import {formatEasternDateTime} from './time.js';
import { BRAND_NAME } from '../config/site.js';
const SCHEMA = 'living-circuit.public-source.v1';
export const PUBLIC_SOURCE_PATHS = Object.freeze([
  'README.md', 'public/config/rules.js', 'public/config/site.js',
  'public/modules/engine.js', 'public/modules/memory.js',
  'public/modules/observation-store.js', 'public/modules/wallet.js',
  'public/modules/renderer.js', 'public/modules/dashboard.js',
  'public/modules/instruments.js', 'public/modules/workbench.js',
  'public/modules/source-workspace.js', 'public/modules/time.js', 'docs/living-circuit.md', 'docs/protocol.md', 'docs/wallet-assets.md',
  'public/modules/app.js', 'public/index.html', 'public/styles.css',
  'public/restoration.css', 'public/workbench.css', 'public/source-workspace.css',
  'public/fonts-local.css', 'public/header-wallet.css',
]);
const MAX_FILES = 64;
const MAX_BYTES = 2_000_000;
const KEYWORDS = new Set('async await break case catch class const continue debugger default delete do else export extends false finally for from function get if import in instanceof let new null of return set static super switch this throw true try typeof undefined var void while with yield'.split(' '));
const byteLength = value => new TextEncoder().encode(value).length;
const lineCount = content => content ? content.split(/\r\n|\r|\n/).length - (/\r\n$|[\r\n]$/.test(content) ? 1 : 0) : 0;

function quotedEnd(text, start) {
  const quote = text[start]; let end = start + 1;
  while (end < text.length) { if (text[end] === '\\') end += 2; else if (text[end++] === quote) break; }
  return Math.min(end, text.length);
}

function tokenizeHtml(text) {
  const tokens = []; let cursor = 0; let inTag = false;
  const push = (kind, end) => { tokens.push({kind, text: text.slice(cursor, end)}); cursor = end; };
  while (cursor < text.length) {
    const rest = text.slice(cursor);
    if (!inTag && rest.startsWith('<!--')) { const end = text.indexOf('-->', cursor + 4); push('comment', end < 0 ? text.length : end + 3); continue; }
    if (!inTag && /^<!doctype\b/i.test(rest)) { const end = text.indexOf('>', cursor + 2); push('keyword', end < 0 ? text.length : end + 1); continue; }
    if (!inTag && /^<\/?[A-Za-z]/.test(rest)) {
      push('punctuation', cursor + (rest.startsWith('</') ? 2 : 1));
      const name = /^[\w:-]+/.exec(text.slice(cursor)); push('keyword', cursor + name[0].length); inTag = true; continue;
    }
    if (!inTag) { const next = text.indexOf('<', cursor + 1); push('plain', next < 0 ? text.length : next); continue; }
    if (rest.startsWith('/>') || rest.startsWith('>')) { push('punctuation', cursor + (rest.startsWith('/>') ? 2 : 1)); inTag = false; continue; }
    if ('"\''.includes(text[cursor])) { push('string', quotedEnd(text, cursor)); continue; }
    const attribute = /^[\w:-]+/.exec(rest);
    if (attribute) { push('function', cursor + attribute[0].length); continue; }
    const space = /^\s+/.exec(rest);
    if (space) { push('plain', cursor + space[0].length); continue; }
    push(text[cursor] === '=' ? 'punctuation' : 'plain', cursor + 1);
  }
  return tokens;
}

function tokenizeCss(text) {
  const tokens = []; let cursor = 0;
  const push = (kind, end) => { tokens.push({kind, text: text.slice(cursor, end)}); cursor = end; };
  while (cursor < text.length) {
    const rest = text.slice(cursor);
    if (rest.startsWith('/*')) { const end = text.indexOf('*/', cursor + 2); push('comment', end < 0 ? text.length : end + 2); continue; }
    if ('"\''.includes(text[cursor])) { push('string', quotedEnd(text, cursor)); continue; }
    const word = /^(?:@[\w-]+|--[\w-]+(?=\s*:)|[-a-z][\w-]*(?=\s*:)|!important\b)/i.exec(rest);
    if (word) { push('keyword', cursor + word[0].length); continue; }
    const number = /^(?:#[\da-f]{8}\b|#[\da-f]{6}\b|#[\da-f]{4}\b|#[\da-f]{3}\b|[+-]?(?:\d*\.\d+|\d+)(?:e[+-]?\d+)?(?:%|[a-z]+)?)/i.exec(rest);
    if (number) { push('number', cursor + number[0].length); continue; }
    const name = /^(?:[.#][\w-]+|[-a-z][\w-]*)/i.exec(rest);
    if (name) { push(name[0].startsWith('.') || name[0].startsWith('#') || /^\s*\(/.test(rest.slice(name[0].length)) ? 'function' : 'plain', cursor + name[0].length); continue; }
    const space = /^\s+/.exec(rest);
    if (space) { push('plain', cursor + space[0].length); continue; }
    push(/[{}()[\];:,.>+~=]/.test(text[cursor]) ? 'punctuation' : 'plain', cursor + 1);
  }
  return tokens;
}

// A text lexer, never an evaluator or an HTML renderer. All original text survives.
export function tokenizeSource(source, language = 'javascript') {
  const text = String(source);
  if (language === 'html') return tokenizeHtml(text);
  if (language === 'css') return tokenizeCss(text);
  if (language === 'markdown') {
    return text.split(/(\r\n|\r|\n)/).map(part => ({kind: /^#{1,6}\s/.test(part) ? 'heading' : /^\s*[-*]\s|^\s*\d+\.\s/.test(part) ? 'keyword' : /^```/.test(part) ? 'comment' : 'plain', text: part}));
  }
  const tokens = [];
  let cursor = 0;
  const push = (kind, end) => { tokens.push({kind, text: text.slice(cursor, end)}); cursor = end; };
  while (cursor < text.length) {
    const rest = text.slice(cursor);
    if (rest.startsWith('//')) { const end = text.indexOf('\n', cursor); push('comment', end < 0 ? text.length : end); continue; }
    if (rest.startsWith('/*')) { const end = text.indexOf('*/', cursor + 2); push('comment', end < 0 ? text.length : end + 2); continue; }
    if ('"\'`'.includes(text[cursor])) {
      const quote = text[cursor]; let end = cursor + 1;
      while (end < text.length) { if (text[end] === '\\') end += 2; else if (text[end++] === quote) break; }
      push('string', Math.min(end, text.length)); continue;
    }
    const number = /^(?:0x[\da-f]+|\d[\d_]*(?:\.\d[\d_]*)?(?:e[+-]?\d+)?)/i.exec(rest);
    if (number) { push('number', cursor + number[0].length); continue; }
    const word = /^[A-Za-z_$][\w$]*/.exec(rest);
    if (word) { push(KEYWORDS.has(word[0]) ? 'keyword' : /^\s*\(/.test(rest.slice(word[0].length)) ? 'function' : 'plain', cursor + word[0].length); continue; }
    const spacing = /^\s+/.exec(rest);
    if (spacing) { push('plain', cursor + spacing[0].length); continue; }
    push(/[{}()[\];.,]/.test(text[cursor]) ? 'punctuation' : 'plain', cursor + 1);
  }
  return tokens;
}

export function validatePublicManifest(value) {
  if (!value || value.schema !== SCHEMA || !Array.isArray(value.files) || value.files.length < 1 || value.files.length > MAX_FILES || !Number.isFinite(Date.parse(value.generatedAt))) throw new Error('Invalid public source manifest.');
  const paths = new Set(); let bytes = 0; let lines = 0;
  const files = value.files.map(file => {
    if (!file || typeof file.path !== 'string' || !PUBLIC_SOURCE_PATHS.includes(file.path) || !/^[\w./-]{1,180}$/.test(file.path) || file.path.startsWith('/') || file.path.split('/').some(part => part === '..' || !part) || paths.has(file.path)) throw new Error('Invalid public source path.');
    if (!['javascript', 'json', 'markdown', 'typescript', 'html', 'css'].includes(file.language) || typeof file.content !== 'string' || byteLength(file.content) > 300_000 || file.bytes !== byteLength(file.content) || file.lines !== lineCount(file.content)) throw new Error('Invalid public source file.');
    paths.add(file.path); bytes += file.bytes; lines += file.lines;
    return {path: file.path, language: file.language, content: file.content, bytes: file.bytes, lines: file.lines};
  });
  if (bytes > MAX_BYTES || value.stats?.files !== files.length || value.stats?.bytes !== bytes || value.stats?.lines !== lines) throw new Error('Public source statistics do not match the files.');
  return {schema: SCHEMA, generatedAt: value.generatedAt, stats: {files: files.length, bytes, lines}, files};
}

const sizeLabel = bytes => bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;


export function mountSourceWorkspace(root, options = {}) {
  if (!root?.ownerDocument || typeof root.replaceChildren !== 'function') throw new TypeError('A source workspace mount element is required.');
  const doc = root.ownerDocument;
  const abort = new AbortController();
  let destroyed = false; let manifest = null; let selected = null; let feedbackTimer; let copyRevision = 0;
  const cleanups = [];
  const listen = (element, type, fn) => { element.addEventListener(type, fn); cleanups.push(() => element.removeEventListener(type, fn)); };
  const el = (tag, className, text) => { const node = doc.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
  root.classList.add('src-workspace'); root.setAttribute('aria-label', 'Public project source workspace');
  const release = el('header', 'src-release');
  const identity = el('div', 'src-release-identity'); identity.append(el('span', '', 'PUBLIC PROJECT SOURCE'), el('strong', '', `${BRAND_NAME} / implementation`));
  const statistics = el('dl', 'src-statistics');
  const metrics = {};
  for (const [key, label] of [['files', 'Indexed files'], ['lines', 'Source lines'], ['bytes', 'Text payload'], ['generated', 'Generated · US Eastern']]) { const group = el('div'); const value = el('dd', '', '—'); metrics[key] = value; group.append(el('dt', '', label), value); statistics.append(group); }
  release.append(identity, statistics);
  const sidebar = el('aside', 'src-sidebar');
  const about = el('header', 'src-about'); about.append(el('span', '', 'REVIEWED FILE SET'), el('h2', '', `${BRAND_NAME} / source`), el('p', '', 'Actual rules, browser modules, page markup, styles and documentation shipped with this preview.'));
  const searchLabel = el('label', 'src-search'); searchLabel.append(el('span', '', 'Find a file'));
  const search = el('input'); search.type = 'search'; search.placeholder = 'Filter by path…'; search.autocomplete = 'off'; searchLabel.append(search);
  const treeHeader = el('div', 'src-tree-header'); const shownCount = el('b', '', '—'); treeHeader.append(el('span', '', 'Files'), shownCount);
  const tree = el('nav', 'src-tree'); tree.setAttribute('aria-label', 'Public source files');
  const readme = el('article', 'src-readme'); const readmeHead = el('header'); const openReadme = el('button', '', 'Open README'); openReadme.type = 'button'; readmeHead.append(el('span', '', 'README.md'), openReadme); const readmeText = el('pre', 'src-readme-excerpt', 'Loading project documentation…'); readme.append(readmeHead, readmeText);
  sidebar.append(about, searchLabel, treeHeader, tree, readme);
  const editor = el('section', 'src-editor'); editor.setAttribute('aria-label', 'Selected source file');
  const fileHead = el('header', 'src-file-head'); const fileIdentity = el('div'); const filePath = el('strong', '', 'Select a file'); const fileSize = el('span', '', '—'); fileIdentity.append(filePath, fileSize); const copy = el('button', 'src-copy', 'Copy file'); copy.type = 'button'; copy.disabled = true; fileHead.append(fileIdentity, copy);
  const codeMeta = el('div', 'src-code-meta'); const language = el('span', '', 'TEXT'); const codeState = el('span', '', 'Loading the public file index…'); codeMeta.append(language, codeState);
  const codeScroll = el('div', 'src-code-scroll'); codeScroll.tabIndex = 0; codeScroll.setAttribute('aria-label', 'Source code. Scroll within this region.');
  const codeLines = el('ol', 'src-code-lines'); codeScroll.append(codeLines); editor.append(fileHead, codeMeta, codeScroll);
  const footer = el('footer', 'src-footer'); const note = el('span', '', 'Reviewed public files · local source index'); const status = el('span', 'src-status', 'Loading'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); footer.append(note, status);
  root.replaceChildren(release, sidebar, editor, footer);

  const setStatus = text => { status.textContent = text; };
  const renderCode = file => {
    const rows = []; let line = el('li'); let code = el('code'); line.append(code); rows.push(line);
    for (const token of tokenizeSource(file.content, file.language)) {
      const pieces = token.text.split(/\r\n|\r|\n/);
      pieces.forEach((part, index) => { if (index) { line = el('li'); code = el('code'); line.append(code); rows.push(line); } if (part) code.append(el('span', `src-token-${token.kind}`, part)); });
    }
    if (rows.length > 1 && /\r\n$|[\r\n]$/.test(file.content)) rows.pop();
    codeLines.replaceChildren(...rows); codeScroll.scrollTop = 0; codeScroll.scrollLeft = 0;
  };
  function selectFile(path) {
    if (destroyed || !manifest) return false;
    const file = manifest.files.find(entry => entry.path === path); if (!file) return false;
    // A pending clipboard request belongs to the file selected when it started.
    // Switching files must invalidate both its result and its feedback timeout.
    copyRevision++; clearTimeout(feedbackTimer);
    selected = file; filePath.textContent = file.path; filePath.title = file.path; fileSize.textContent = `${file.lines.toLocaleString()} lines · ${sizeLabel(file.bytes)}`; language.textContent = file.language.toUpperCase(); codeState.textContent = 'Exact published file · read only'; copy.disabled = false; copy.textContent = 'Copy file'; renderCode(file);
    for (const button of tree.querySelectorAll('button[data-source-path]')) { const active = button.dataset.sourcePath === path; button.classList.toggle('is-selected', active); if (active) { button.setAttribute('aria-current', 'true'); let parent = button.parentElement; while (parent && parent !== tree) { if (parent.tagName === 'DETAILS') parent.open = true; parent = parent.parentElement; } } else button.removeAttribute('aria-current'); }
    setStatus(`${file.path} selected`); options.onFileChange?.({path: file.path, language: file.language, lines: file.lines}); return true;
  }
  function renderTree() {
    if (!manifest || destroyed) return;
    const matches = manifest.files.filter(file => file.path.toLowerCase().includes(search.value.trim().toLowerCase()));
    shownCount.textContent = `${matches.length} / ${manifest.files.length}`;
    const hierarchy = {directories: new Map(), files: []};
    for (const file of matches) { const pieces = file.path.split('/'); let branch = hierarchy; for (const segment of pieces.slice(0, -1)) { if (!branch.directories.has(segment)) branch.directories.set(segment, {directories: new Map(), files: []}); branch = branch.directories.get(segment); } branch.files.push(file); }
    const build = (branch, parent) => {
      for (const [name, child] of branch.directories) { const details = el('details'); details.open = true; const summary = el('summary'); summary.append(el('i', '', '⌄'), el('span', '', name)); const body = el('div', 'src-tree-branch'); build(child, body); details.append(summary, body); parent.append(details); }
      for (const file of branch.files) { const button = el('button'); button.type = 'button'; button.dataset.sourcePath = file.path; button.title = file.path; if (selected?.path === file.path) { button.className = 'is-selected'; button.setAttribute('aria-current', 'true'); } button.append(el('i', '', file.language === 'markdown' ? '≡' : file.language === 'html' ? '<>' : file.language === 'css' ? '#' : '{}'), el('span', '', file.path.split('/').at(-1)), el('em', '', String(file.lines))); parent.append(button); }
    };
    tree.replaceChildren(); if (matches.length) build(hierarchy, tree); else tree.append(el('p', 'src-empty', 'No public files match this path.'));
  }
  listen(search, 'input', renderTree);
  listen(tree, 'click', event => { const button = event.target.closest('button[data-source-path]'); if (button && tree.contains(button)) selectFile(button.dataset.sourcePath); });
  listen(tree, 'keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const controls = [...tree.querySelectorAll('summary,button')].filter(node => { let parent = node.parentElement; while (parent && parent !== tree) { if (parent.tagName === 'DETAILS' && !parent.open && parent.firstElementChild !== node) return false; parent = parent.parentElement; } return true; });
    const index = controls.indexOf(doc.activeElement); if (index < 0) return; event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1 : Math.max(0, Math.min(controls.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))); controls[next]?.focus();
  });
  listen(openReadme, 'click', () => selectFile('README.md'));
  listen(copy, 'click', async () => {
    if (!selected) return; const path = selected.path; const content = selected.content; const revision = ++copyRevision;
    clearTimeout(feedbackTimer); copy.textContent = 'Copying…'; setStatus(`Copying ${path}…`);
    try {
      const clipboard = doc.defaultView?.navigator?.clipboard;
      if (!clipboard?.writeText) throw new Error('Clipboard is unavailable.');
      await clipboard.writeText(content);
      if (destroyed || revision !== copyRevision) return; copy.textContent = 'Copied'; setStatus(`${path} copied`); feedbackTimer = setTimeout(() => { if (!destroyed && revision === copyRevision) copy.textContent = 'Copy file'; }, 1800);
    } catch { if (!destroyed && revision === copyRevision) { copy.textContent = 'Copy unavailable'; setStatus('Clipboard access was denied. Select text in the code region to copy it.'); } }
  });
  const load = async () => {
    const url = new URL(options.manifestUrl ?? '/source-manifest.json', doc.baseURI);
    if (url.origin !== new URL(doc.baseURI).origin) throw new Error('The source index must use the same origin.');
    const response = await (options.fetch ?? globalThis.fetch.bind(globalThis))(url, {signal: abort.signal, credentials: 'same-origin', cache: 'no-cache'});
    if (!response.ok) throw new Error(`Source index returned ${response.status}.`);
    const raw = await response.text(); if (byteLength(raw) > MAX_BYTES * 2) throw new Error('Source index is too large.');
    const loaded = validatePublicManifest(JSON.parse(raw)); if (destroyed) return null; manifest = loaded;
    metrics.files.textContent = manifest.stats.files.toLocaleString(); metrics.lines.textContent = manifest.stats.lines.toLocaleString(); metrics.bytes.textContent = sizeLabel(manifest.stats.bytes); metrics.generated.textContent = formatEasternDateTime(manifest.generatedAt); metrics.generated.title = `${formatEasternDateTime(manifest.generatedAt,{offset:true})}. Source manifest build time; not a chain event or a commit.`;
    const documentation = manifest.files.find(file => file.path === 'README.md'); readmeText.textContent = documentation ? documentation.content.split(/\r\n|\r|\n/).slice(0, 24).join('\n') : 'No README was included in this public file set.'; openReadme.disabled = !documentation;
    renderTree(); const firstPath = manifest.files.some(file => file.path === 'public/modules/engine.js') ? 'public/modules/engine.js' : manifest.files[0].path; if (!selectFile(options.initialPath ?? firstPath)) selectFile(firstPath);
    return manifest;
  };
  const ready = load().catch(error => { if (destroyed || error.name === 'AbortError') return null; codeState.textContent = 'Public source could not be loaded'; tree.replaceChildren(el('p', 'src-empty', 'Refresh this page to retry the public source index.')); setStatus(error.message); options.onError?.(error); return null; });
  return {ready, selectFile, get selectedPath() { return selected?.path ?? null; }, destroy() { destroyed = true; copyRevision++; abort.abort(); clearTimeout(feedbackTimer); cleanups.forEach(cleanup => cleanup()); root.replaceChildren(); root.classList.remove('src-workspace'); }};
}
