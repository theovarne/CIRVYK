# CIRVYK implementation reference

This document describes CIRVYK's browser engine and bounded observation interface. The page at `#protocol` provides the reading layout; `#source` exposes reviewed public implementation files. Existing rule, schema, storage and deployment identifiers remain unchanged for compatibility; they are not the current brand name.

## 1. Deterministic processing

```
Sensor → Resistor → Capacitor → Comparator → Switch → Memory
```

`finalizeWindow({inputs, windowStart, now, coverage, parsingComplete, baseline, source, rules})` is pure. It normalizes the source and inputs, sorts inputs deterministically, filters them, derives the baseline and selects the result. It does not read clocks, network, DOM or storage itself.

The default `living-circuit.v1` rules are 60,000 milliseconds per UTC-aligned window, five preceding baseline windows, a minimum of ten accepted inputs for SURGE and a multiplier of two. Supported kinds are Activity and Transfer. The rule identifier is retained for compatibility; the CIRVYK rename does not change this contract.

The interval is `[start, end)`. The current time before `end` produces `accumulating`. An ended window with incomplete coverage, unresolved parsing or missing live scope produces `incomplete`. Only a final, complete window can produce QUIET, FLOW or SURGE. User-facing times use US Eastern (`America/New_York`) with automatic EDT/EST labels. Stored epochs, exported ISO timestamps and UTC-aligned processing windows remain unchanged.

For a final window:

- QUIET: zero accepted inputs.
- SURGE: all five consecutive preceding windows qualify, count ≥ 10, and count ≥ 2 × baseline average.
- FLOW: a non-empty final window that does not satisfy SURGE.

Baseline records must share the exact scope and rule configuration, be final with complete coverage and parsing, and occupy consecutive preceding intervals. A gap or conflicting count stops the baseline. Incomplete baseline gives null average and ratio. A zero complete baseline gives a null finite ratio; the count-based route condition still applies.

## 2. Input eligibility

Normalized input keys are `id, signature, mint, slot, timestamp, kind, source, address, accounts, verified, scopeId`.

Checks cover a valid integer UTC timestamp inside the selected interval, matching source mode, verified parser flag, supported kind and matching scope. A live input must also have the supported signature form, non-negative integer slot, target mint and configured observation accounts. It deduplicates by signature plus mint. An example requires a non-empty ID, deduplicates by that ID and cannot contain a claimed transaction signature.

Every rejected input remains inspectable as `{input, reason}`. These rules are bounded eligibility filtering rather than comprehensive anti-abuse detection.

## 3. Trace schema

Current schema: `circuit.trace.v1`, retained as the compatible record-format identifier.

| Field | Meaning |
| --- | --- |
| schema | Record format identifier |
| id | Stable scope/window/rules identity; not a cryptographic proof |
| window | start, end, durationMs, in UTC milliseconds |
| observedAt | The time passed into this engine invocation |
| source | mode, label, network, mint, accounts, scopeId |
| rulesVersion | Attached rule version |
| rules | version, windowMs, baselineWindows, surgeMinInputs, surgeMultiplier, supportedKinds |
| inputs | Normalized and sorted bounded input list |
| validInputs | Accepted inputs after eligibility and deduplication |
| filtered | Rejected input/reason pairs |
| count | validInputs.length |
| coverage | complete, partial or missing |
| parsingComplete | Boolean parsing condition supplied to the engine |
| baselineEvidence | Qualifying preceding-window identities, scope, count and completeness |
| baselineReady | Whether the required consecutive baseline is available |
| baselineAverage | Mean accepted baseline count or null |
| baselineReason | Baseline availability explanation |
| growthRatio | count / positive baselineAverage for a final window, else null |
| path | QUIET, FLOW, SURGE or null |
| status | accumulating, incomplete or final |
| reason | Pending-state explanation or null |
| progress | Window elapsed fraction, clamped to 0–1 |
| steps | Six id/name/label/inputCount/outputCount/status/detail records |

`validateTrace()` validates allowed shapes, reconstructs baseline evidence, reruns `finalizeWindow()` and compares every derived field with a stable representation. Imported JSON is data only.

## 4. Instrument semantics

`instruments.js` derives a read-only model from one selected Trace. It has no network calls, clock reads or random values.

- Relative activity uses input checks, filter checks, accepted Pulses, window evaluations, path selections and Trace preparations as explicit units. The final three are whole-window operations, not one operation per Pulse and not proof of a disk write.
- Each grid cell is an explicit interval labeled in US Eastern time, with EDT or EST selected for its timestamp. Its accepted count is a proven zero only when the Trace is final with complete coverage and parsing. In unknown coverage the model retains observed lower bounds separately and gives no completed bucket count.
- Waveform series are timestamped inputs and accepted inputs after filtering. They share an Eastern-time bucket axis and Pulse-per-bucket units; the underlying UTC-aligned buckets do not change. Equal curves are possible when no inputs were filtered; no random series is generated.
- Selecting a time subrange filters visible events and counts but does not recalculate the whole-window route or its baseline.
- Accepted final events can inspect all six stages. Rejected events stop at Sensor/Resistor; accepted incomplete events cannot claim a concluded Comparator/Switch/Memory path.

A file's declared `source.mode = live` is not proof of a current observation. The view positively distinguishes local observation, historical replay, imported claims and examples.

## 5. Read-only observation and coverage

One ObservationStore is shared across Home, Live, Core, Memory and the other pages. Page switching does not create another poller. It pauses periodic polling when hidden and keeps actual prior inputs/times on failure.

The Solana adapter checks finalized transactions involving explicitly configured accounts or pools, then inspects target-mint token balance or supported parsed SPL Token evidence. It is not an all-transactions index for a mint and does not classify an ordinary transfer as a buy or sell. Address membership is not beneficial ownership.

The current target is unconfigured because a new mint and explicit observed accounts were not supplied. CIRVYK is the configured brand. The X and GitHub links use the supplied project accounts; the token ticker, CA and trade link remain unconfigured. Optional RPC credentials stay server-side and are excluded from the public source set.

| State | Interpretation |
| --- | --- |
| unconfigured / invalid_configuration | Missing or invalid explicit scope; local examples remain available |
| ready / checking | Configuration loaded / shared request in progress |
| live + complete | Scan, finalized UTC boundary and parsing reconciled |
| live + partial | Only bounded/partial evidence or unresolved work is available |
| unavailable / error / rate_limited | Current proof is unavailable; retain previous successful evidence and timestamps |
| cursor_expired | Cursor changed scope or expired; restart once without it |

Only `[reconciledFrom,reconciledUntil)` is a proven range. Finalized slot and block time establish the upper boundary; unresolved parsing constrains it. Limits: four accounts, three pages × 50 signatures per account, 150 transactions per check, concurrency three, two retries, minimum 12-second request interval. Default browser polling is approximately 15 seconds; cursor memory is bounded to 100 entries and 30 minutes. Default retained browser inputs are 4,000. Pagination or retention limits are not exhaustive-history claims.

## 6. Local Workbench

Supported parameters are three patterns (1/12/6 inputs per batch), 60/120/300-second windows, one to five batches and 0.5×/1×/2×/4× playback speed. Automatic/manual replay, Execute, Pause, Step, Reset and Inspect result operate locally. Parameters rebuild the example record and device/waveform outputs through the actual engine. Reset retains the selected parameters. Live rules are unchanged.

The five preceding complete example windows each have three accepted inputs. Short burst with 60 seconds and one batch covers `2026-10-16T00:05:00Z` to `2026-10-16T00:06:00Z`: 12 received, 12 accepted, zero filtered; baseline average three, growth ratio four, SURGE. Fixture inputs have example provenance and no signatures.

The chassis and passive rails are display geometry. No remote worker registration, CPU allocation, burn activation, reward or transaction is part of Workbench execution.

## 7. Memory, provenance and public source

Memory keeps at most 30 records and 3 MB in the current browser, newest first. A stable window identity is updated rather than duplicated after late reconciliation. Quota or validation failures return explicit errors. JSON export includes the bounded inputs, rule configuration and baseline needed for replay; Snapshot is an actual downloadable PNG.

Imported historical chain declarations are not rechecked merely by importing them and do not enter locally observed live counts. Memory is not permanent, global, on-chain or collected while the page is closed.

Source generation uses an exact public path allowlist. It reads actual files, computes line/byte/file counts, rejects symlinks, oversized or credential-like material, and never walks the project to discover arbitrary files. Environment files, hosting metadata, server adapter and credentials are excluded. The browser presents content with text nodes, never HTML evaluation, and supports file switching, keyboard navigation, highlighting, copy and local scroll.

Wallet discovery uses Solana Wallet Standard registration and recognized injected Solana providers. The chooser displays OKX Wallet, Phantom, Backpack, Coinbase Wallet and Solflare, along with other compatible registered providers. Unavailable providers remain unavailable rather than simulated. A user-initiated connection supplies a public address for local filtering; the controller does not request signatures, transactions or token approvals. A matching address does not establish beneficial ownership or classify trading direction.

## 8. Shared operating context

Home provides the overview. Live inspects retained evidence. Core presents physical structure and processing; its compatibility route remains `#circuit`. Memory selects historical records. Source reads actual implementation. Workbench runs explicit local examples. Protocol is the technical manual.

The shared context identifies source and the selected range in US Eastern time. Component selection synchronizes circuit/activity/inspector. Grid selection synchronizes the visible time range, waveform and events. Event selection exposes its input and path. Saved Trace selection uses that record's data. `Clear filters` restores the full selection; `Live scope` exits replay; Home returns to the overview. Camera reset changes framing only.
