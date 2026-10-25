# Engines

SNEED has two analysis engines. Both produce the same result record through the same checks (`assess` in `src/core/result.ts`), so the rest of the app (results, lessons, compare, the SEED runner) does not care which one answered. The record names the engine that produced it.

| | Built-in (`sneed-bdd`) | SCRAM |
|---|---|---|
| Where | inside the app, `src/engines/bdd/` | the installed runtime in WSL2 (`docs/RUNTIME.md`) |
| Install | none | `npm run runtime -- install` (built from pinned source) |
| Licence | MIT, same as SNEED, written from the published algorithms | GPL-3.0, never bundled |
| How | reads the native model directly; a reduced ordered binary decision diagram and Rauzy's minimal solutions | exports Open-PSA XML, runs the engine, parses its report |
| K-of-N | built into the diagram, exact for every shape | native `atleast` is wrong for some shapes, so the exporter expands it |
| Limits | 2000 events, 2,000,000 diagram nodes, 50,000 cut sets, a 20-million-number cache budget, a 1 GB heap for its thread, whole-analysis time limit, cancel | product-order limit, 50,000 cut sets, report size cap, time limit, cancel |
| Default | **yes (editor, server and headless runner)** | optional; also the independent cross-check |

The editor's **Engine** list chooses: **Built-in** (default), **SCRAM**, or **Both**. With Both the built-in answer is shown, SCRAM is run too, and the Results tab says whether they agree. A difference is shown as a difference (probability, or the cut sets only one engine found) and the numbers are called unverified until it is explained. With no SCRAM runtime installed, Both still answers and says there is no second opinion. A result made with another engine than the one selected is shown as out of date.

The headless runner (`docs/HEADLESS.md`) takes `--engine builtin|scram`. Its default is the **built-in** engine (flipped 2026-10-06); `SNEED_ENGINE=scram` restores SCRAM as the default for a caller that has not been updated.

## The built-in engine

- **Diagram.** Variables are the basic events reachable from the top, in the order a depth-first walk first meets them (any order gives the same answer; only the size changes). AND and OR are the usual memoised apply operations. K-of-N is built from them for monotone functions: at least `j` of `f[i..]` holds when at least `j` of `f[i+1..]` holds, or `f[i]` holds and at least `j-1` of `f[i+1..]` hold. No negation exists anywhere, because a coherent tree never needs it.
- **Probability.** `P(node) = p * P(failed branch) + (1 - p) * P(working branch)`, memoised, for independent events. Floating point; on the hand-checkable models the error is far below the `1e-12` tolerance of the oracles.
- **Minimal cut sets.** Rauzy's minimal solutions: the sets of the working branch, plus the failed branch's sets with the variable added, minus any set the working branch already has. (A set of the failed branch can never strictly contain a set of the working branch, because the function is monotone, so no subset test is needed; the mutation run found the subset test was dead code.)
- **Product-order limit.** `limitOrder` is honoured the way SCRAM honours it: only cut sets up to that order are reported, the probability stays the exact one, and the shared checks call the result truncated (never complete) when the reported sets explain less than the whole.
- **Approximations.** Rare-event and min-cut-upper-bound values are computed from the cut sets with the rules in `result.ts`; a rare-event sum above 1 is shown labelled with the bound 1 as the probability, exactly as for SCRAM.
- **Its own thread.** The solver runs in a worker thread (`isolate.ts`, `worker.ts`), so the server's event loop stays free: an HTTP cancel, a disconnect or the headless runner's cancel poll are heard while it computes, the thread is terminated at the time limit, and its heap is limited (default 1 GB; a model that needs more ends as `too-much-memory` while the server process lives). Built as plain JavaScript the worker is `dist/node/engines/bdd/worker.js`; under tsx or a test runner it is the `.ts` file loaded with `--import tsx`.
- **Limits fail loudly.** Node limit, cut-set cap, event cap, cache budget, heap limit, time limit and cancel each end the run as `failed` (reasons `too-many-nodes`, `too-many-cut-sets`, `too-many-events`, `too-much-memory`, `timeout`, `engine-error` for anything unexpected) or `cancelled`, with no numbers. Never a partial number presented as complete.
- **Recursion depth** is bounded by the number of events (at most 2000), gates are walked iteratively, and K-of-N is built bottom-up over its inputs, so neither a chain of 1500 gates nor a vote over 12000 gates overflows the stack.
- **Small probabilities.** MCUB is computed as `-expm1(sum(log1p(-p)))`, so a cut set of probability 1e-20 is not rounded to 0. Probabilities are compared relatively everywhere (the result checks and the cross-check), with no absolute floor, so 0 and 1e-20 are different.

## Verification

Nothing in the engine is checked by itself alone:

1. Every numerical entry of `tests/oracles.json` (hand-derived, tolerance `1e-12`), including the approximation rows, through the whole analysis.
2. 2000 small and 300 larger seeded random trees (probabilities including 0 and 1, repeated references, K-of-N) against exhaustive enumeration with exact rational arithmetic (`tests/oracle/`, which shares no code with the engine): probability within `1e-12`, cut sets exactly equal.
3. The same trees under four different variable orders each: identical cut sets, probability within `1e-12`.
4. The same models through SCRAM (`tests/engine/bdd-vs-scram.test.ts`): hand oracles, both approximations, and 40 random trees: same probability to SCRAM's printed precision, same cut sets.
5. The shapes SCRAM's native K-of-N gets wrong, against the enumerator.
6. Limits, cancel, a time limit that has passed, a 1500-level chain, a hard 14-pair model (16384 cut sets) in about 2 seconds.
7. Mutation tests: `python tests/mutation/verifier_mutations.py engines` (31 deliberate breaks of the diagram, the solver, the thread, the analysis, the cross-check, the engine choice; all caught).
8. Codex review of the engine (2026-10-06): 8 findings (MCUB cancellation, absolute tolerance in the cross-check, an abort thrown past the result checks, a blocking solver that no cancel could reach, unbounded cache memory, stack depth in K-of-N, and the same timeout escape), all confirmed and fixed with tests.

Unit tests: `tests/unit/bdd.test.ts`, `crosscheck.test.ts`, engine choice blocks in `server.test.ts`, `web-editor.test.ts`, `headless.test.ts`; e2e: `e2e/engines.spec.ts`, `failures.spec.ts`, `a11y.spec.ts`.

## Known limits

- Floating point, not exact rationals. Probabilities are compared to SCRAM at its printed precision (about six digits).
- A model with more than 2000 reachable events, or more than 50,000 minimal cut sets, is refused (for SCRAM too, at the same cut-set cap).
- The engine's identity has no binary hash (it is a version, `0.1.0`); a source hash can be added when it is packaged.
- No importance measures, uncertainty or time (plan 07).

## Common-cause groups (plan 15, stage C2, 2026-10-25)

The built-in fault-tree analysis handles beta-factor groups (`common_cause_groups` in the model, [SCHEMA.md](SCHEMA.md)). `src/core/ccf.ts` expands each group before the solver runs: a member keeps its id and becomes an OR gate of its own independent part `<member>.independent` (probability `(1 - beta) x Q`) and one group event `<group>.CCF` (probability `beta x Q`) shared by all members. The cut sets use these names. The result record keeps the original model's `model_hash`, gives the expansion's hash as `exported_input_hash`, and carries `common_cause {method, groups, note}`. It is a different kind of result from one with independent events.

The SCRAM path, the Open-PSA export, event trees and importance measures refuse a model with groups (`E_CCF_NOT_ANALYSED`), because an engine that ignored a group would give the independent answer without a word. Verification: the six frozen cases in `tests/oracles-common-cause.json`, and 80 random trees with groups against `tests/oracle/groups.ts`, which evaluates the group definition itself with exact rationals and shares no code with the expansion.

## Engine identity (2026-10-06)
SCRAM's identity is the sha-256 of its binary. The built-in engine has no binary, so its identity is the hash of the source files that decide what it computes: every `src/engines/bdd/*.ts` file (solver, diagram, importance, workers), everything those import at run time (followed through relative imports, `import type` excluded: today `src/core/{result,canonical,bounds,validate,report,export}.ts`) and the data files read at run time (`schema/model.schema.json`), each by path and content with line endings normalised. It is generated into `src/engines/bdd/build-id.ts` by `npm run gen:engine-id` (which lists the files), and `tests/unit/engine-id.test.ts` fails when the committed value no longer matches the sources, and checks that the set is closed under imports, so a change to the solver or to anything it relies on cannot ship under the old identity.
- **Recorded** as `engine.sha256` in every built-in result record (`results.json`, the headless `manifest.json`), in the field SCRAM fills with its binary's hash; listed in `/api/health` and in the headless `describe` (`engines.builtin.sha256`); shown as "Engine build" in the Results panel.
- **Used** by saved-run reuse (a record is offered only for the same build) and by Compare (two built-in runs of the same build are the same engine, so a difference in numbers is "unexpected"; before this, built-in runs had no build and could never be called the same).
- **Not covered:** the Node runtime and the compiled output (the hash is of the sources, baked in at build time, so a stale `dist` reports the sources it was built from); a file reached only through a type import or not at all by the engine (the SCRAM runtime, the process runner) does not change it.
- **After changing any of the listed files** run `npm run gen:engine-id` and commit `build-id.ts`. The mutation runner regenerates it for mutants in those files so they are judged by behaviour.

## Event-tree sequences (plan 13, stage S2, 2026-10-06)
The built-in engine also evaluates event trees. All heading events of a tree are events of ONE fault-tree model and are built into ONE decision diagram (`buildNodes`), so a basic event under several headings is one variable. A path condition is the AND of each failed heading's event and the NEGATION of each worked heading's event (`Bdd.not`, evaluated by `probability`, never by cut sets, so sequences have no cut sets); its probability is exact and the frequency is that times the initiating-event frequency. The sequence probabilities must add up to 1 (`PARTITION_TOLERANCE` 1e-9), else the run fails as `sequences-do-not-partition`. Numbers outside the range of a double are a failure (`numeric-range`): a path that can happen (decided on the diagram with `Bdd.satisfiable`, not by multiplying probabilities) whose probability or frequency underflows to 0, a ratio or a sum that overflows. The optional **approximation** ("success branches ignored") is each path's failure events alone, shown next to the exact value with its ratio, and its frequencies are not summed into the exact ones. Runs in a worker thread with the solver's time, memory and cancel; takes its turn in the same queue as runs and importance. Result record kind `sneed.event-tree-result` (`src/core/event-tree-result.ts`), written as `runs/<id>/event-tree-results.json` with `native/event-tree.json` and `native/model.json` as submitted; such a folder has no `results.json`, so the fault-tree run list and saved-run reuse never see it. API: `POST /api/event-tree/run {text, approximation?, request_id?}`.

