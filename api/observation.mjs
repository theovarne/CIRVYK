import { createApiHandler } from '../lib/vercel-api.mjs';

// Direct Node.js Web Standard endpoint. No rewrite parameters enter the reader.
const handle = createApiHandler();
export default { fetch: (request) => handle(request, process.env) };
