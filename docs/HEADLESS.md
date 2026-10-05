# Headless runner and SEED oracle entries

The SNEED side of the SEED adapter ([plan 11](plans/11-seed-adapter.md)). Built 2026-10-05. The SEED side (`adapters/pra/` in the SEED repository) is **not** built; this is what it will call.

## The runner

```
npm run build:cli      # builds dist/node/cli/headless.js (and copies schema/ to dist/schema, which the validator reads)

node dist/node/cli/headless.js describe
node dist/node/cli/headless.js validate <model.json>
node dist/node/cli/headless.js run <model.json> --out <absDir> [--run-id pra] [--method exact|rare-event|mcub]
                                   [--limit-order N] [--timeout-seconds 60]
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

## SEED oracle entries (`oracles/seed/`)

14 generated entries: 11 `good` (`top_event_probability`, exact, `abs 1e-12, rel 0`) and 3 `bad-input` (`E_PROB_RANGE`, `E_CYCLE`, `E_MISSING_REF`). Rebuild with `npm run gen:seed-oracles`; never edit by hand (a test compares the files with what the generator writes). Details and what is deliberately missing: [oracles/seed/README.md](../oracles/seed/README.md).

## Verification

- `tests/unit/headless.test.ts` (34): every verb with a stand-in engine: exact replies, exit codes, the record written before the engine, no result for a non-complete run, refusals for each bad argument, the cancel flag, ownership refusals, hostile model text staying data.
- `tests/engine/headless-runner.test.ts` (21): the built runner as a separate process against the installed SCRAM: result equals the independent enumeration oracle, manifest hashes verify, a product-order limit is not a result, a cancel while running ends the run cancelled with no engine left, and every SEED oracle entry run and judged the way SEED will (11 good values within the pinned tolerance, 3 refusals).
- `tests/unit/seed-oracles.test.ts` (21): files equal the generator output, input hashes equal the files, tolerance pins recomputed by an independent canonical JSON, expected values equal exhaustive enumeration, and every entry validates against **SEED's own** `seed.oracle/0.1` schema read from the sibling checkout (read-only; skipped if SEED is absent, with `SEED_REPO` to point elsewhere).
- `tests/engine/process.test.ts`: `hasOwned` with a real owned process.
- Mutation checks: `python tests/mutation/verifier_mutations.py seed` (16 mutations, all caught).

## Known limits

- Windows with WSL2 and the installed runtime only, like the rest of the engine path.
- Cancel is confirmed by a process check, not by a handshake with SCRAM; a process that lingers after being killed is reported as `nativeStopped: false`.
- SEED runs oracle entries with default settings, so the rare-event, min-cut-upper-bound and product-order-limit rows cannot be SEED entries until `seed.oracle` has a settings field.
- The runner does not accept a SEED-reserved run folder as the engine's own folder; it writes beside it in `work/`, so the exclusive-create rule of `analyze()` is untouched.
- Memory and core budgets are not enforced (SCRAM is single-threaded); only the wall-clock limit is.
