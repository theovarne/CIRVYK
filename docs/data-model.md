# Data model

The contracts below are implemented in `public/modules/engine.js`, `public/modules/observation-store.js` and `public/modules/memory.js`. Existing identifiers containing `circuit` remain stable for saved-record compatibility.

## Inputs and source identity

An engine input contains only recognized fields:

```text
id, signature, mint, slot, timestamp, kind, source,
address, accounts, verified, scopeId
```

`timestamp` is an integer UTC time in milliseconds. Supported `kind` values are `Activity` and `Transfer`. `source` is `live` or `example`; `verified: true` means the supported parser accepted the input, not that an independent audit occurred. User-facing time is formatted in US Eastern (`America/New_York`), selecting EDT or EST for the timestamp. This presentation does not shift stored epochs, UTC window boundaries or exported ISO data.

A source record contains `mode`, `label`, `network`, `mint`, `accounts` and `scopeId`. Scope identity separates networks, target mints, observed accounts and examples. Normalization sorts and deduplicates account lists. An absent scope ID is derived deterministically from the normalized source.

The reader produces live evidence from finalized transactions with target-mint balance changes or supported parsed SPL Token transfer evidence. The browser validates returned scope, timestamp, signature, slot and kind before retaining it. A transaction is not classified as a buy or sell.

Live inputs deduplicate by `signature:mint`. Example inputs deduplicate by non-empty `id` and cannot claim a transaction signature. Engine filtering also records malformed/out-of-window inputs, different sources, unsupported kinds and invalid scope evidence. Rejected inputs remain available with their reason.

## Windows and routing

`finalizeWindow()` receives inputs, a source, rules, a UTC window start, `now`, coverage/parsing state and preceding baseline records. It does not read a clock or fetch data itself.

The default `living-circuit.v1` configuration is:

| Rule | Value |
| --- | --- |
| UTC-aligned window | 60,000 ms |
| Required preceding baseline windows | 5 |
| SURGE minimum accepted inputs | 10 |
| SURGE multiplier | 2 × baseline average |

The interval includes its start and excludes its end: `[start, end)`. Before the end, status is `accumulating`. After the end, incomplete coverage, unresolved parsing or missing live scope yields `incomplete`. Only a `final` record receives a route.

QUIET means zero accepted inputs. SURGE requires the complete five-window baseline, at least ten accepted inputs and at least twice its average. Other non-empty final windows use FLOW. Baseline records must match scope and rules and occupy consecutive preceding windows. Missing or conflicting evidence prevents a complete baseline. A zero baseline has no finite growth ratio, although the count-based SURGE condition still applies.

## Trace contract

The record schema is `circuit.trace.v1`.

| Fields | Meaning |
| --- | --- |
| `schema`, `id` | Format and stable scope/window/rules identity |
| `window` | `start`, `end`, `durationMs` in UTC milliseconds |
| `observedAt`, `source` | Engine invocation time and normalized source provenance |
| `rulesVersion`, `rules` | Exact configuration needed to reproduce the result |
| `inputs`, `validInputs`, `filtered`, `count` | Normalized inputs, accepted inputs, rejection reasons and accepted count |
| `coverage`, `parsingComplete` | Evidence completeness supplied to the engine |
| `baselineEvidence`, `baselineReady`, `baselineAverage`, `baselineReason` | Preceding-window evidence and comparison state |
| `growthRatio`, `path`, `status`, `reason`, `progress` | Derived routing and window state |
| `steps` | Six stage records with component ID, counts, status and detail |

The stable ID is an identity aid produced from deterministic hashes; it is not a cryptographic proof. Late reconciliation replaces the same saved identity. `validateTrace()` checks supported shapes and bounds, reconstructs baseline evidence, reruns `finalizeWindow()` and compares the complete result. A file cannot change a derived count or route without failing validation.

## Observation response versus Trace

`GET /api/observation` returns a bounded batch with `status`, `scope`, `lastChecked`, `latestEventUTC`, `pulses`, `coverage`, `pending`, `cursor`, `reconciledFrom`, `reconciledUntil` and filtered evidence. This is not a saved Trace.

Only a complete batch with no pending work and a valid reconciled interval proves coverage. The store merges those intervals and builds final windows only inside proven coverage. Inputs retained from a partial response are lower-bound observations, not evidence that missing intervals contain zero events. Retention limits can also prevent finalization of affected windows.

## Memory exchange

Browser storage uses an envelope:

```json
{
  "schema": "circuit.memory.v1",
  "traces": []
}
```

`circuit.traces.v1` is the storage key. Limits are 30 records, 3 MiB for the collection and 5,000 inputs per Trace. JSON export carries inputs, rules and baseline evidence; import validates and recomputes before saving. Duplicate IDs in a collection are rejected. Records are sorted newest first and capacity outcomes are reported.

An imported `source.mode: live` is a historical claim in a file, not proof of a current local observation. Playback uses that record's data and timestamp and does not merge it into live counts. Examples carry `mode: example`, an example network and no signatures. PNG snapshots are visual exports, not importable Trace files.

See [Protocol](protocol.md) for instrument semantics and [Development](development.md) for a reproducible example.
