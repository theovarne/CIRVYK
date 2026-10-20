# Architecture

CIRVYK is a static browser application with a small, read-only Node.js observation API. It uses HTML, CSS, SVG and native ES modules; there is no frontend framework or application bundle compiler. The repository contains both the browser source and the server reader.

## Application layers

| Layer | Main files | Responsibility |
| --- | --- | --- |
| Document and identity | `public/index.html`, `public/config/site.js` | Page containers, shared project links, metadata and public defaults |
| Processing contract | `public/config/rules.js`, `public/modules/engine.js` | Input normalization, eligibility, deduplication, window results and Trace validation |
| Shared observation | `public/modules/observation-store.js` | One browser poller, retained inputs, reconciled intervals and complete-window records |
| Page coordination | `public/modules/app.js` | Hash navigation, selected Trace/component/time/event, wallet filtering and replay context |
| Instruments | `public/modules/instruments.js`, `public/modules/dashboard.js` | Derived activity, time buckets, waveforms and inspectable events |
| Physical views | `public/modules/renderer.js`, `public/assets/*.svg` | Circuit selection, camera controls, path display and snapshot rendering |
| Local tools | `public/modules/workbench.js`, `public/modules/memory.js` | Deterministic examples, local playback, validated browser storage and JSON exchange |
| Public source reader | `scripts/generate-public-source.mjs`, `public/modules/source-workspace.js` | Reviewed source payload and text-only file reading UI |
| Server API | `api/*.mjs`, `lib/vercel-api.mjs`, `lib/observation.mjs` | Fixed GET routes and bounded finalized Solana observation |

## Data flow

```text
Server-only scope and RPC configuration
             |
     /api/config + /api/observation
             |
      shared ObservationStore
             |
      finalizeWindow() engine <--- explicit local Workbench inputs
             |
        selected Trace
             |
  circuit + instruments + inspector + replay
             |
    validated browser-local Memory
```

The six processing stages are Sensor, Resistor, Capacitor, Comparator, Switch and Memory. They are responsibilities implemented by the same deterministic engine, represented by visual components. They are not six separately deployed services.

## Entry points and scope

The browser loads `/api/config` once through the shared store. A configured scope enables periodic `/api/observation` requests, optionally carrying one opaque `cursor`. The two direct Vercel function files delegate to the same route handler. `scripts/dev.mjs` uses that handler locally and serves the same `public/` directory.

The reader scans finalized transactions involving explicitly configured accounts, then checks target-mint evidence. It does not query every transaction for a mint. Only server configuration selects the RPC endpoint, mint and observed accounts; browser query inputs cannot override them. The checked-in scope has no mint or accounts, so examples run without credentials while live observation remains unconfigured.

The server bounds pagination, transaction work, concurrency and cursor lifetime. Its cursors and request coalescing cache are instance-local, not shared durable state. A cold start can invalidate a cursor; the browser restarts once without it. See [Protocol](protocol.md) for limits and coverage semantics.

## State ownership and selection

`app.js` owns navigation and the active inspection context. Home, Live, Core, Memory, Source, Workbench and Protocol share that context. Core retains the compatibility hash `#circuit`. Page changes do not create independent observation pollers.

`ObservationStore` owns current observed inputs and proven time intervals. It deduplicates live inputs by signature plus mint, retains up to 4,000 inputs by default and rebuilds engine records only for supported windows. New evidence updates an existing window identity instead of creating duplicate activity. Visibility changes pause periodic requests while the page is hidden; no service worker or background collector is provided.

The active context chooses either current observation or a specific example/historical record. Component selection synchronizes the circuit, relative activity and inspector. A grid interval filters the visible waveform/events without changing the whole-window routing result. Event inspection traces its accepted or rejected path. `Clear filters` restores the selected record's full range; `Live scope` exits replay.

Instruments derive their values from the selected record rather than random animation. Environment motion does not generate inputs or logs. Exported snapshots are rendered from actual selected data.

## Persistence and wallet boundary

`memory.js` stores validated records under `circuit.traces.v1` in browser local storage. The limit is 30 records and 3 MiB; writes keep newer windows and report capacity or validation errors. There is no backend Memory database. JSON imports are parsed as data, strictly validated and recomputed with the engine. Imported declarations do not become locally observed live evidence.

`wallet.js` discovers compatible Solana Wallet Standard providers, with recognized injected-provider fallbacks. A successful user-initiated connection supplies a public address for filtering already observed records. Account changes, disconnects, rejected connections and cancelled requests update that local filter. The controller does not call signing, transaction or token-approval methods.

## Build and publication boundary

`npm run build` runs `scripts/verify-port.mjs`; it validates the reviewed assets, configuration contracts and generated public source manifest without compiling or rewriting the application. The Source viewer's allowlist is narrower than this repository: it omits server configuration and deployment internals. Publishing the complete repository does not make private environment values public.

See [Development](development.md), [Data model](data-model.md) and [Deployment](../DEPLOYMENT.md) for setup, record structure and hosting details.
