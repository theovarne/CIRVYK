# Deployment

This directory is the runnable CIRVYK project root. The public site is [www.cirvyk.xyz](https://www.cirvyk.xyz/#home), and the source repository is [theovarne/CIRVYK](https://github.com/theovarne/CIRVYK). The retained hosting project name is a technical identifier, not an alternative public brand.

## Vercel configuration

| Setting | Value |
| --- | --- |
| Existing project | `circuit-living-v11` |
| Framework | Other (`framework: null`) |
| Build command | `npm run build` |
| Static output | `public` |
| Functions | `api/config.mjs`, `api/observation.mjs` |
| Maximum function duration | 300 seconds |
| Supported package runtime | Node.js 22 or 24 |
| Package manager | pnpm 10.28.0, committed `pnpm-lock.yaml` |

The frontend is static HTML, CSS, SVG and native ES modules. The two Node Web Standard `fetch(request)` endpoints delegate through `lib/vercel-api.mjs` to `lib/observation.mjs`. `vercel.json` does not use wildcard rewrites or inject internal query parameters.

No environment variables are required to serve the site and run examples. To configure live observation, provide `CIRCUIT_MINT` and `CIRCUIT_OBSERVED_ACCOUNTS` in the server environment. `CIRCUIT_NETWORK`, `SOLANA_RPC_URL` and `SOLANA_RPC_API_KEY` are optional. See [Development](docs/development.md#configuration) for their exact meaning. RPC URLs and keys are omitted from public configuration responses.

## Validate and deploy

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm build
```

`scripts/verify-port.mjs` is the read-only build integrity check, not a bundling step: it validates public-file digests, approved changes, deployment configuration and the exact generated Source payload. The committed `public/` directory is the static output. API source must also be deployed; uploading only that directory to a static host would omit observation.

Use the existing authorized Vercel project and account when deploying. A locally linked checkout may be deployed with the authenticated Vercel CLI; inspect its selected project before creating or promoting a deployment. Deploy a preview, test the browser and API, then promote the tested deployment through the established host workflow when a public update is intended. Publishing this repository alone does not prove that Vercel deployed it, and these instructions do not require renaming the project or changing domain bindings.

## API contract

| Request | Behavior |
| --- | --- |
| `GET /api/config` | Redacted scope, configuration state and limits |
| `GET /api/observation` | Bounded finalized-account observation |
| `GET /api/observation?cursor=…` | Continue an instance-local observation cursor |
| Other methods on known endpoints | JSON 405, `Allow: GET` |
| Unknown API route | Vercel 404; the local server returns JSON 404 for GET |

Only one optional `cursor` query parameter is accepted by the observation route. Browser parameters cannot select a different RPC server, mint, observed account list or RPC method. The endpoints do not sign or submit transactions.

Cursors and request coalescing caches are instance-local. Another instance or a cold start can return HTTP 409 `cursor_expired`; the browser retries once without the cursor and retains earlier inputs. Coalescing is not a global rate limiter. Provider timeouts, unresolved parsing and bounded scans preserve partial/unavailable states instead of proving zero activity.

## Source and publication integrity

`provenance.json` records the inherited engineering baseline and reviewed changes. Its source commit is provenance metadata; the published repository does not need to contain the original project's Git history. `public/source-manifest.json` contains only explicit reviewed public files, and its counts are measured from those actual files. Regenerate it after a reviewed allowlisted source or documentation change, then update the corresponding reviewed provenance records before building.

The full repository includes server source, tests, scripts, documentation, assets and deployment configuration. The browser's Source workspace intentionally exposes a smaller allowlist. `deployment-manifest.json` records the selected delivery files and hashes; it is an integrity artifact, not a replacement for application source.

`.vercelignore` and `.gitignore` exclude local dependency directories, private environment files, host linking state and credentials. Check the actual staged file list before publishing; ignore rules do not remove previously tracked secrets. Do not upload `.vercel/`, local authentication files, browser profiles or unrelated workspace records.

For local API behavior and configuration, see [Development](docs/development.md). For coverage and replay semantics, see [Protocol](docs/protocol.md).
