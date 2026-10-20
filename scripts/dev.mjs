import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiHandler } from '../lib/vercel-api.mjs';
const handleApi = createApiHandler();

const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));
const port = Number(process.env.PORT || 5175);
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon', '.png': 'image/png', '.ttf': 'font/ttf' };
const server = http.createServer(async (incoming, outgoing) => {
  try {
    const url = new URL(incoming.url || '/', `http://127.0.0.1:${port}`);
    if (url.pathname.startsWith('/api/')) {
      const response = await handleApi(new Request(url, { method: incoming.method, headers: incoming.headers }), process.env);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    if (incoming.method !== 'GET' && incoming.method !== 'HEAD') { outgoing.writeHead(405, { Allow: 'GET, HEAD' }); outgoing.end(); return; }
    const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname).slice(1);
    const filename = path.resolve(publicRoot, relative), safe = path.relative(publicRoot, filename);
    if (safe.startsWith('..') || path.isAbsolute(safe) || !(await fs.lstat(filename)).isFile()) throw new Error('Not found');
    outgoing.writeHead(200, { 'Content-Type': mime[path.extname(filename)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
    outgoing.end(incoming.method === 'HEAD' ? undefined : await fs.readFile(filename));
  } catch { outgoing.writeHead(404, { 'Content-Type': 'text/plain' }); outgoing.end('Not found'); }
});
server.listen(port, '127.0.0.1', () => console.log(`CIRVYK local preview: http://127.0.0.1:${port}`));
