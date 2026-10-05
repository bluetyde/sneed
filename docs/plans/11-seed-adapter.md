# Plan 11: SEED adapter for SNEED (mapping, not built)

Written 2026-10-05 after reading SEED's contract **read-only** (nothing in the SEED repository was touched). This refines the "SEED adapter" section of [plan 06](06-suite-integration.md) now that SEED has real adapters to copy. Nothing here is built.

## What was read

- `experiment-studio/docs/contracts.md` (contracts v0.1, **provisionally** accepted by the user on 2026-10-05; the final sign-off is due after the second real adapter, and changes go through a new schema version).
- `docs/adapter-feed.md` and `docs/adapter-nodal.md`: the two newest adapters, the pattern to follow. RAFT is the first; NODAL's review fixes are on a branch not yet merged.
- `schema/*.schema.json` and `error-codes.json` were not read line by line; the field names below come from contracts.md and must be re-checked against the schemas, not this note, when work starts.

## Shape to copy

An adapter is two files in SEED, `adapters/<app>/cli.cjs` (one process per verb) and `job.cjs` (a detached wrapper that runs the app's headless runner, keeps a heartbeat and writes `native/status.json`), plus the app's own **headless runner** with `describe`, `validate`, `run`, `cancel`, and **oracle entries in SEED format** that the app owns (decision D3), hashed by a generator script in SEED. Each app keeps its configuration in host environment variables, never in a project file or request.

For SNEED that means two pieces of work in two repositories, and neither starts without the user's go-ahead:

1. In `sneed`: `src/cli/headless.ts` (built to `dist/cli/headless.js`), and `oracles/seed/` holding the entries and their models.
2. In SEED: `adapters/pra/{cli,job}.cjs`, tests with a stub runner, tests against the real runner and SCRAM, `docs/adapter-pra.md`. Done in an own clone on a branch and **not merged** without the user's decision, as the FEED adapter was done.

## Verb mapping

| Verb | Mapping |
|---|---|
| `describe` | app `{id: "pra", name: "SNEED", version}`; engine `{SCRAM, 0.16.2}` and the install id; format `sneed.fault-tree` version 1; capabilities (`exact`, `rare-event`, `mcub`, `k-of-n`); quantities below; `oracleCoverage` from the oracle entries; `oraclePin` of the entry set. A missing runtime is warning `W_SOLVER_MISSING`-style (name to choose), as FEED does. |
| `open` | `E_VERB_UNKNOWN`: the editor is the app's web page. (Opening a model in the editor is a possible later verb.) |
| `validate` | The existing `validateModel`: each issue becomes a typed error `{code, field, message, source: "app-content"}`; our codes (`E_CYCLE`, `E_PROB_RANGE`, `E_MISSING_REF`, ...) are adapter codes matching the pattern, with `E_SCHEMA` mapped to `E_SCHEMA_INVALID` and unsupported constructs to `E_UNSUPPORTED`. Warnings stay warnings. `valid` is true when no `E_` problem remains. |
| `run` | Snapshot of exactly one file, the native model. `settings`: `method` (`exact`, `rare-event`, `mcub`) and optionally `limitOrder`; anything else is refused. A request `seed` is refused with `E_UNSUPPORTED` (deterministic). `budget.maxWallSeconds` becomes the run timeout; memory and cores are not enforced and the doc must say so. |
| `status` | From the wrapper's status file, heartbeat and job token, like FEED. |
| `cancel` | Our `execInWsl` already tags SCRAM with an owner tag and `killOwned`; the runner's cancel stops SCRAM inside WSL first, then the wrapper, only when the process command line proves ownership. `cancelled: true` and `nativeStopped` only on confirmation, as contracts section 10 rule 5 requires. |
| `collect` | Only for a completed job. Re-hash the snapshot, parse `results.json` with the existing result parser and checks, and refuse a result that is not `completed` and `complete` (`truncated` and `failed` are never indexed: `E_OUTPUT_INCOMPLETE`). Write per-quantity data files and the `seed.results-index/0.1`. |

## Quantities

| Name | Unit | Normalization | Notes |
|---|---|---|---|
| `top_event_probability` | `1` | `none` (see decision 1) | The value for the chosen method. Never a frequency. |
| `minimal_cut_sets` | `1` | `none` | A data file: each set with its probability. |
| `approximation_value` | `1` | `none` | Only for rare-event and MCUB; can exceed 1, and then carries the existing caveat. |

Every index also carries, in `extensions.pra`: the method, the assumptions block (independence, coherence, constant probabilities), the caveats list, and the statement that the result is a probability under stated assumptions, not a frequency and not a plant risk figure. `verification` is `verified` only for quantities and domains an oracle entry covers, otherwise `unverified`.

## Identity and revisions

- SEED's snapshot hash is the sha256 of the saved bytes, which is our `document_hash`. The semantic `model_hash` is recorded in `extensions.pra.modelHash` so a formatting-only change shows as a new revision in SEED but as the same model in our results (and in the Compare view).
- SEED's "new revision, never a string edit" rule for sweeps is already how we work: a sweep case is a new model document.
- Event probability is the only parameter offered to sweeps and agents: `describe` names a parameter family (`event.probability`, number, unit `1`, min 0, max 1); how a parameter id is bound to one event of one artifact needs the contract's study-parameter format, which has to be read in the schemas before design (open question 2).

## Oracles

Our `tests/oracles.json` entries become `seed.oracle/0.1` entries under `oracles/seed/entries`, each with its model file and sha256: tags `good` for the numerical rows (hand-derived, source kind `hand` or `analytic`, with the enumeration oracle as the `check`), `bad-input` for the refusal rows using our error codes, `known-limit` for truncation. Tolerances stay `abs 1e-12`, `rel 0`, and each entry gets its `toleranceHash`. Coverage is stated by quantity and model class, not "the app is verified": a model with a shape no entry covers stays `unverified` in SEED. The approximation rows (rare-event, MCUB) are separate `good` entries with `quantity` `approximation_value`.

## Acceptance (from plan 06, made concrete)

1. **Parity.** The same model through SEED (CLI and MCP) and through the app directly gives the same top probability and cut sets on every oracle entry (harness test 9).
2. **Revision change** invalidates dependent SEED results.
3. **Cancel** stops only that job's SCRAM; a crash mid-run is `failed`, never a result.
4. **Hostile content.** A model whose names look like instructions is stored and returned as data and starts nothing (typed errors labelled `app-content`).
5. **Refusals are not results.** Truncated, failed and cancelled runs produce no results index.

## Known gaps in our code that this will expose

- `analyze()` creates the run folder itself and throws if it exists; SEED reserves the run folder first. The headless runner has to accept an existing empty folder (or write into a subfolder) without weakening the exclusive-create rule for the app's own runs.
- `analyze()` runs in-process. A per-verb CLI needs a detached job wrapper like FEED's, because `run` must return a `jobId` and exit.
- Result records have no `schema: "seed.*"` field; the adapter builds the index, nothing changes in our record.
- No headless runner exists yet; the recipe-installed SCRAM runtime is already the default engine, so `E_SETUP_REQUIRED` maps directly to our existing `E_SETUP_REQUIRED` code.

## Decisions for the user

1. **Normalization.** The contract's list has `none` and `per-demand`. A static fault-tree probability is often read as "per demand", but our model has no demand concept and the assumptions block says only "constant probability". Recommendation: `none`, with the assumption in `extensions`, until the user decides otherwise.
2. **Permission to start** in the SEED repository (a branch in an own clone, not merged), and to add `oracles/seed/` and `src/cli/headless.ts` to `sneed`.
3. **Timing.** SEED's contract is only provisionally accepted and NODAL's review fixes are unmerged; building the third adapter now means a possible rework if the contract changes. Recommendation: do the SNEED side first (headless runner and oracle entries), since both are useful standalone, and hold the SEED side until NODAL's adapter is merged and the contract is settled.
4. **Shared adapter module.** NODAL's notes say the adapters duplicate about 400 lines of infrastructure and a shared module is a follow-up. A third copy makes that cheaper to do first; that is SEED's owner's call.

## Open questions

1. Is a project's artifact `format` string for us `sneed.fault-tree` with `formatVersion` `1`, matching our `schema.id` and version?
2. How does a study's `parameters` entry (`{id, artifact?, min, max}`) bind to an event inside a model file? To be read in `study.schema.json` and the harness plan before a design is written.
3. How does SEED treat a quantity whose `data` is a set of cut sets rather than a number series or field?
4. Is a result for a method other than `exact` indexable as a verified quantity, or only the exact one? (Our oracle set covers all three on the 2-of-3 model only.)
