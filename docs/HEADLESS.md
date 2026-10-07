# Headless runner and SEED oracle entries

The SNEED side of the SEED adapter ([plan 11](plans/11-seed-adapter.md)). Built 2026-10-05. The SEED side (`adapters/pra/` in the SEED repository) is **not** built; this is what it will call.

## The runner

```
npm run build:cli      # builds dist/node/cli/headless.js (and copies schema/ to dist/schema, which the validator reads)

node dist/node/cli/headless.js describe
node dist/node/cli/headless.js validate <model.json>
node dist/node/cli/headless.js run <model.json> --out <absDir> [--run-id pra] [--method exact|rare-event|mcub]
                                   [--engine builtin|scram] [--limit-order N] [--timeout-seconds 60]
node dist/node/cli/headless.js cancel --out <absDir>
```

One JSON object on stdout, nothing else. Exit codes: **0** a reply was produced, **2** the model or an argument was refused (`ok: false` with typed errors `{code, field, message, source?, ids?}`), **1** the runner itself failed (`ok: false`).

| Verb | Behaviour |
|---|---|
| `describe` | Engine `sneed-headless`, SCRAM runtime state (`installed`, version, install id, or `E_SETUP_REQUIRED` with the command that fixes it), model format `sneed.fault-tree` 1, methods, the quantities with units, the parameter family `event.probability` in [0, 1], and the meaning statement (not a frequency, not a plant risk figure). |
| `validate` | The same validator the editor uses. Every issue is a typed error labelled `source: "app-content"` (messages quote ids from the model, so SEED must treat them as untrusted data). `E_SCHEMA` is reported as SEED's `E_SCHEMA_INVALID`; our other codes (`E_CYCLE`, `E_PROB_RANGE`, ...) are adapter codes. Warnings stay warnings. |
| `run` | Validates, then runs SCRAM through the installed runtime. A **completed and complete** result writes `<out>/<run-id>/{model.json, results.json, manifest.json}` (the model byte for byte, the full result record, and sha256 of each file plus the model hash and engine identity). Anything else (`truncated`, `failed`, `cancelled`, or completed but incomplete) is exit 0 with that status and a reason and **writes no result**. The engine's own files (exported XML, report, logs) stay under `<out>/work/<work-id>/`. An existing result folder is never overwritten (`E_EXISTS`). |
| `cancel` | Writes `<out>/cancel.requested` containing this run's work id (the running process polls it, and a request naming a different run is ignored), then kills any Linux process carrying the run's owner tag and checks again, repeating for up to 5 seconds because the run process may start its engine just after a kill. `cancelled: true`; `nativeStopped` is true only when no tagged process remains **and** the run process has retired its record or is gone. A failed process query is never read as "nothing running": it gives `nativeStopped: false`. A record that is missing fields, unreadable, not JSON or not a run of this folder is `E_NOT_OWNED` and nothing is killed. A run that already ended: `cancelled: false`. No record at all: `cancelled: false`. |

`run` owns its output folder for one run. It writes `<out>/active-run.json` (work id, folder, process id, state `running`) **exclusively and before the engine can start**, so a cancel from another process can always find the run; keep that order if the runner is edited. A second run in the same folder, a result folder, work folder or cancel request that is already there, or any of these being a link, is refused (`E_EXISTS` or `E_PATH_TRAVERSAL`) before anything is written; nothing existing is followed or replaced. The result is built in a staging folder and renamed into place, so a half-written result never appears. When the run ends the record is rewritten with state `ended` and the final status.

## Event-tree verbs (plan 13, added 2026-10-07)

Additive: the four verbs above, their outputs and every field of `describe` are unchanged (a test compares the key set of `describe`). SEED's adapter does not use these verbs unless it is changed to.

```
node dist/node/cli/headless.js describe-event-trees
node dist/node/cli/headless.js validate-event-tree <tree.json> --model <model.json>
node dist/node/cli/headless.js run-event-tree <tree.json> --model <model.json> --out <absDir> [--run-id et] [--approximation] [--timeout-seconds 60]
```

| Verb | Behaviour |
|---|---|
| `describe-event-trees` | The formats (`sneed.event-tree` 1, `sneed.fault-tree` 1, result `sneed.event-tree-result` 1), the engine (`sneed-bdd`, its version and source hash, `runtime: null`), the limits (12 headings, 4096 sequences), the option `--approximation`, the quantities (`sequence_frequency`, `end_state_frequency`, both **per-year**) and the meaning statement (a frequency per year under stated assumptions; not a probability of failure, not a plant risk figure; end states are named by the author). |
| `validate-event-tree` | Checks the event tree against the fault-tree model file it is given with the validator the editor and the server use. `ok: true` with `treeHash` (the hash of what the tree means) and typed warnings, or exit 2 with typed errors labelled `source: "app-content"`. Fields of a problem in the model file are named under `model`. The model name inside the tree is only a label: the file given and the hash the tree pins decide (`E_STALE_MODEL` when they differ). Files over 4 MiB are refused (`E_BOUNDS_EXCEEDED`). |
| `run-event-tree` | The same ownership protocol as `run`, because it is the same code (one function, `runOwned`, serves both): the run record is created exclusively before the analysis can start, `cancel` stops it the same way (same flag, same record), nothing existing is reused, followed or replaced, and a result is published atomically and only when complete. A tree that is refused is refused **before** any folder or record exists (exit 2). A completed analysis writes `<out>/<run-id>/{event-tree.json, model.json, event-tree-results.json, manifest.json}`: the tree and the model byte for byte, the result record of kind `sneed.event-tree-result` (**never** a `results.json`), and a manifest (`format: "sneed-headless-event-tree-run"`, engine and build, quantity and unit, whether the approximation was asked for, the tree and model hashes, sha256 of every file). A failed, cancelled or incomplete analysis is exit 0 with that status and a reason and writes **no result**. Only the built-in engine analyses event trees; there is no `--engine`. |

Verification: `tests/unit/headless-event-tree.test.ts` (every verb with the real engine and with stand-ins: refusals, the hand numbers of plan 13 case 6.2, hashes, the record before the analysis, cancel, ownership, links) and `tests/unit/headless-event-tree-built.test.ts` (the BUILT JavaScript as a separate process, so the schema file and the worker thread are the built ones); mutation mode `etundo` (headless part) and `seed` (the shared protocol).

## Engine choice

**The default is the built-in engine** (changed 2026-10-06 at the user's request; it was SCRAM). It runs the decision-diagram engine inside the process: no runtime, no WSL2, same files, and the manifest names `sneed-bdd` with `runtime: null`. `--engine scram` needs the installed SCRAM runtime and answers `E_SETUP_REQUIRED` without it. An explicit `--engine` always wins. A caller that has not been updated can keep the old default without a code change by setting the environment variable `SNEED_ENGINE=scram`. `describe` lists both engines under `engines` and says which is the default. **A caller must read the engine from the results** (`manifest.json` and `results.json` name it); it must not assume SCRAM. See [ENGINES.md](ENGINES.md).

## SEED oracle entries (`oracles/seed/`)

14 generated entries: 11 `good` (`top_event_probability`, exact, `abs 1e-12, rel 0`) and 3 `bad-input` (`E_PROB_RANGE`, `E_CYCLE`, `E_MISSING_REF`). Rebuild with `npm run gen:seed-oracles`; never edit by hand (a test compares the files with what the generator writes). Details and what is deliberately missing: [oracles/seed/README.md](../oracles/seed/README.md).

## Verification

- `tests/unit/headless.test.ts` (34): every verb with a stand-in engine: exact replies, exit codes, the record written before the engine, no result for a non-complete run, refusals for each bad argument, the cancel flag, ownership refusals, hostile model text staying data.
- `tests/engine/headless-runner.test.ts` (21): the built runner as a separate process against the installed SCRAM: result equals the independent enumeration oracle, manifest hashes verify, a product-order limit is not a result, a cancel while running ends the run cancelled with no engine left, and every SEED oracle entry run and judged the way SEED will (11 good values within the pinned tolerance, 3 refusals).
- `tests/unit/seed-oracles.test.ts` (21): files equal the generator output, input hashes equal the files, tolerance pins recomputed by an independent canonical JSON, expected values equal exhaustive enumeration, and every entry validates against **SEED's own** `seed.oracle/0.1` schema read from the sibling checkout (read-only; skipped if SEED is absent, with `SEED_REPO` to point elsewhere).
- `tests/engine/process.test.ts`: `hasOwned` with a real owned process.
- Mutation checks: `python tests/mutation/verifier_mutations.py seed` (16 mutations, all caught).

## Time limit and size

`--timeout-seconds` bounds the whole analysis, not only SCRAM: after the engine returns, the checks on its report poll the clock and stop (`failed`, reason `timeout`), and a cancel stops them too. A report with more than 50,000 cut sets is refused without being checked (`too-many-cut-sets`), and a report whose minimality check would take more than a fixed amount of work is refused (`result-too-large-to-verify`). Neither is ever a result. Found by the SEED agent while building `adapters/pra`: an AND of 17 two-event ORs (131072 cut sets) ran for over 15 minutes past a 120 s limit in the old quadratic check. Now: 15 pairs (32768 sets) take about 5 s; 17 pairs end as `too-many-cut-sets` in about 20 s (mostly SCRAM and XML parsing).

Details added after a Codex review of the time-limit fix: the clock is monotonic (`performance.now`) and starts when `analyze()` is entered, so validation, export, the engine identity lookup and the engine all draw on one budget; the engine is given what is left and is not started at all when nothing is left; a result is accepted only if the time is not up at the moment of acceptance (the last steps after the minimality check are linear and not interruptible, so this is the final look); a report file larger than 64 MB is not read, and a product with more events than the model has is malformed at once and never indexed. The engine's own `execInWsl` runs outside the clock only for its fixed Linux-side backstop (15 s). The identity lookup is cached per process with its own 20 s timeouts and is not bounded by a short analysis budget on its first use.

## Known limits

- Windows with WSL2 and the installed runtime only, like the rest of the engine path.
- Cancel is confirmed by a process check, not by a handshake with SCRAM; a process that lingers after being killed is reported as `nativeStopped: false`.
- SEED runs oracle entries with default settings, so the rare-event, min-cut-upper-bound and product-order-limit rows cannot be SEED entries until `seed.oracle` has a settings field.
- The runner does not accept a SEED-reserved run folder as the engine's own folder; it writes beside it in `work/`, so the exclusive-create rule of `analyze()` is untouched.
- `cancel --out` compares the recorded work folder as a string, so the same folder written with forward slashes is `E_NOT_OWNED` (reported by the SEED agent; callers should pass native `path.join` paths, as SEED's adapter does).
- Memory and core budgets are not enforced (SCRAM is single-threaded); only the wall-clock limit is.
