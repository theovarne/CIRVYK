# Development

## Local setup

Use Node.js 22 or 24 and pnpm 10.28.0 with the committed `pnpm-lock.yaml`. The application uses native browser ES modules and Node's built-in APIs. PostCSS is a development dependency used by layout tests, not a production bundler.

```sh
git clone https://github.com/theovarne/CIRVYK.git
cd CIRVYK
pnpm install --frozen-lockfile
pnpm test
pnpm build
pnpm dev
```

Open `http://127.0.0.1:5175`. The local server serves `public/` and both API routes using the same handler as Vercel. Set `PORT` to change its loopback port. A static file server alone can show the document but cannot provide the observation API.

| Command | Actual work |
| --- | --- |
| `pnpm dev` | Runs `scripts/dev.mjs`; no hot-reload compiler |
| `pnpm test` | Runs `node --test tests/*.test.mjs` |
| `pnpm build` | Runs the read-only provenance/configuration/Source integrity verifier |
| `node scripts/generate-public-source.mjs` | Regenerates the allowlisted Source payload after reviewed changes |
| `node scripts/sync-brand.mjs` | Synchronizes static metadata with the shared brand configuration |

`npm run dev`, `npm test` and `npm run build` invoke the same package scripts after dependencies are installed. Keep pnpm as the lockfile source of truth.

## Configuration

No environment values are required to explore local examples. The checked-in mint and observed-account list are empty. Live mode requires a deliberate server-side scope.

| Environment variable | Purpose and visibility |
| --- | --- |
| `CIRCUIT_MINT` | Target Solana mint; required for live observation, exposed as public scope |
| `CIRCUIT_OBSERVED_ACCOUNTS` | Comma- or whitespace-separated accounts to scan, maximum four; required for live observation, exposed as public scope |
| `CIRCUIT_NETWORK` | `mainnet-beta` by default; also `devnet` or `testnet`; public scope |
| `SOLANA_RPC_URL` | Optional server-only RPC endpoint; defaults to the selected network's public endpoint |
| `SOLANA_RPC_API_KEY` | Optional server-only bearer credential for that provider |
| `PORT` | Local preview port; defaults to `5175` |

The application reads `process.env`; `scripts/dev.mjs` does not automatically load `.env` files. Supply environment values through the shell, a process manager or the host's environment settings. To load a private local `.env` file explicitly, use Node's built-in support:

```sh
node --env-file=.env scripts/dev.mjs
```

Do not commit that file or put RPC credentials in `public/config/site.js`. The RPC URL must use HTTPS, except for HTTP on localhost loopback addresses. `/api/config` redacts the URL and provider key while exposing the selected scope.

`public/config/site.js` holds identity, public links, token defaults, the 15-second browser poll interval and default retained-input limit. `public/config/rules.js` owns the processing and Memory limits. Changing the brand does not change compatible schema IDs, storage keys or the `#circuit` route.

## Reproduce an inspection or replay issue

1. Start the app with no live scope and open `#workbench`.
2. Choose Short burst, 60 seconds and one batch. Execute or use Step.
3. Expect 12 received, 12 accepted, zero filtered, baseline average 3, growth ratio 4 and SURGE.
4. Inspect a stage, open the result in Core and verify the selected component and Trace agree with the instruments.
5. Save the Trace to Memory, reopen it and export its JSON. Importing that file should reproduce the same record under the same ID.
6. Use `Clear filters` for the full selected record or `Live scope` to leave replay. Reset view changes camera framing only.

The default 60-second fixture covers `2026-10-16T00:05:00Z` through `2026-10-16T00:06:00Z`. It is explicitly local example data. The interface displays time in US Eastern (`America/New_York`), with EDT or EST chosen for the timestamp. UTC window boundaries, stored epoch values and exported ISO timestamps remain unchanged. Preserve the exported JSON and note the route, source mode, interval, selected component, time filter and browser version when investigating a discrepancy. Wallet addresses are optional local filters, not required test fixtures.

## Change rules safely

Edit the supported rule contract in `public/config/rules.js`, then review `finalizeWindow()` and `validateTrace()` together. Baseline identity includes the exact rule configuration; old and new rules cannot share baseline evidence. Workbench changes its local window length through a copied rule object without changing live rules.

Use meaningful engine tests for boundaries, deduplication, coverage, baseline continuity and routing. Run the existing interaction, instrument, Memory, wallet, Source, Workbench and server adapter suites. Preserve saved-record identifiers unless an explicit migration is implemented.

The Source page displays actual allowlisted source files. After a reviewed source or documentation change, regenerate its manifest. `pnpm build` also compares SHA-256 provenance and approved-change records; intentionally changed files require corresponding reviewed digest updates. Do not disable the checks or populate new hashes merely to hide an unexplained difference. Build verifies the current files without modifying them.

## Deploy and review

The existing host is Vercel. `vercel.json` selects the static `public` output and two direct Node function routes. See [DEPLOYMENT.md](../DEPLOYMENT.md) for settings, API behavior and exclusions. A Git push and a successful local build do not independently prove that a public deployment changed.

Before publishing, inspect the staged files, exclude local credentials and caches, run the real checks, then open the tested version. Verify the project GitHub link without replacing the internal Source view, keyboard navigation, a local example, Memory import/export and a selected-path replay. Use actual current captures for README media; caption examples as examples.
