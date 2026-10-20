import { handleObservation, getPublicObservationConfig } from './observation.mjs';

const json = (value, status = 200, extra = {}) => Response.json(value, {
  status,
  headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra },
});

/** Fixed, read-only routes; URL and header inputs never become RPC configuration. */
export function createApiHandler({ observation = handleObservation } = {}) {
  return async function handleApi(request, env = {}) {
    if (request.method !== 'GET') return json({ error: 'Read-only interface' }, 405, { Allow: 'GET' });
    const path = new URL(request.url).pathname;
    if (path === '/api/config') return json(getPublicObservationConfig(env));
    if (path === '/api/observation') return observation(request, env);
    return json({ error: 'Route not found' }, 404);
  };
}
