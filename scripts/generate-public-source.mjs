import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const SOURCE_SCHEMA = 'living-circuit.public-source.v1';
// Exact, reviewed public files only. Never discover files by walking the project.
// Server adapters, environment files, hosting metadata, credentials and Git are excluded.
export const PUBLIC_SOURCE_FILES = Object.freeze([
  'README.md',
  'public/config/rules.js',
  'public/config/site.js',
  'public/modules/engine.js',
  'public/modules/memory.js',
  'public/modules/observation-store.js',
  'public/modules/wallet.js',
  'public/modules/renderer.js',
  'public/modules/dashboard.js',
  'public/modules/runtime.js',
  'public/modules/instruments.js',
  'public/modules/workbench.js',
  'public/modules/source-workspace.js',
  'public/modules/time.js',
  'docs/living-circuit.md',
  'docs/protocol.md',
  'docs/wallet-assets.md',
  'public/modules/app.js',
  'public/index.html',
  'public/styles.css',
  'public/restoration.css',
  'public/workbench.css',
  'public/source-workspace.css',
  'public/fonts-local.css',
  'public/header-wallet.css',
  'public/runtime.css',
]);
const REQUIRED_FILES = new Set(['public/config/rules.js', 'public/config/site.js', 'public/modules/engine.js']);
const MAX_FILE_BYTES = 300_000;
const MAX_TOTAL_BYTES = 2_000_000;

export function countSourceLines(content) {
  return content ? content.split(/\r\n|\r|\n/).length - (/\r\n$|[\r\n]$/.test(content) ? 1 : 0) : 0;
}

function assertPublicText(content, relativePath) {
  const privateMaterial = [
    /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
    /\b(?:sk-(?:proj-|svcacct-)?|gh[pousr]_)[A-Za-z0-9_-]{20,}/,
    /\bxox[baprs]-[A-Za-z0-9-]{15,}/,
    /\b(?:AWS_SECRET_ACCESS_KEY|SOLANA_RPC_API_KEY|OAI_SITES_AUTHORIZATION)\s*[:=]\s*["'][^"'\s]{8,}["']/i,
  ];
  if (privateMaterial.some(pattern => pattern.test(content))) throw new Error(`Private credential-like material in ${relativePath}; public source generation stopped.`);
  if (content.includes('\0')) throw new Error(`Non-text public source: ${relativePath}`);
}

export async function generatePublicSource(projectRoot = fileURLToPath(new URL('../', import.meta.url)), options = {}) {
  const root = await fs.realpath(projectRoot);
  const files = [];
  for (const relativePath of PUBLIC_SOURCE_FILES) {
    const filename = path.join(root, relativePath);
    let info;
    try { info = await fs.lstat(filename); }
    catch (error) { if (error.code === 'ENOENT' && !REQUIRED_FILES.has(relativePath)) continue; throw error; }
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Public source must be a regular local file: ${relativePath}`);
    const resolved = await fs.realpath(filename);
    if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error(`Public source escapes project: ${relativePath}`);
    if (info.size > MAX_FILE_BYTES) throw new Error(`Public source file exceeds ${MAX_FILE_BYTES} bytes: ${relativePath}`);
    const content = await fs.readFile(filename, 'utf8');
    assertPublicText(content, relativePath);
    const language = relativePath.endsWith('.md') ? 'markdown' : relativePath.endsWith('.html') ? 'html' : relativePath.endsWith('.css') ? 'css' : 'javascript';
    files.push({path: relativePath, language, bytes: Buffer.byteLength(content), lines: countSourceLines(content), content});
  }
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const stats = {files: files.length, lines: files.reduce((sum, file) => sum + file.lines, 0), bytes: files.reduce((sum, file) => sum + file.bytes, 0)};
  if (stats.bytes > MAX_TOTAL_BYTES) throw new Error('Public source payload exceeds its bounded size.');
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(generatedAt))) throw new Error('Invalid source generation timestamp.');
  const manifest = {schema: SOURCE_SCHEMA, generatedAt, scope: 'Reviewed public project files. Server adapters, environment values and hosting credentials are excluded.', stats, files};
  if (options.write !== false) {
    await fs.mkdir(path.join(root, 'public'), {recursive: true});
    await fs.writeFile(path.join(root, 'public/source-manifest.json'), `${JSON.stringify(manifest)}\n`);
  }
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = await generatePublicSource();
  console.log(`Public source: ${manifest.stats.files} files, ${manifest.stats.lines} lines, ${manifest.stats.bytes} bytes.`);
}
