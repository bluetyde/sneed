# Engines

SNEED has two analysis engines. Both produce the same result record through the same checks (`assess` in `src/core/result.ts`), so the rest of the app (results, lessons, compare, the SEED runner) does not care which one answered. The record names the engine that produced it.

| | Built-in (`sneed-bdd`) | SCRAM |
|---|---|---|
| Where | inside the app, `src/engines/bdd/` | the installed runtime in WSL2 (`docs/RUNTIME.md`) |
| Install | none | `npm run runtime -- install` (built from pinned source) |
| Licence | MIT, same as SNEED, written from the published algorithms | GPL-3.0, never bundled |
| How | reads the native model directly; a reduced ordered binary decision diagram and Rauzy's minimal solutions | exports Open-PSA XML, runs the engine, parses its report |
| K-of-N | built into the diagram, exact for every shape | native `atleast` is wrong for some shapes, so the exporter expands it |
| Limits | 2000 events, 2,000,000 diagram nodes, 50,000 cut sets, whole-analysis time limit, cancel | product-order limit, 50,000 cut sets, report size cap, time limit, cancel |
| Default | **yes (editor and server)** | optional; also the independent cross-check |

The editor's **Engine** list chooses: **Built-in** (default), **SCRAM**, or **Both**. With Both the built-in answer is shown, SCRAM is run too, and the Results tab says whether they agree. A difference is shown as a difference (probability, or the cut sets only one engine found) and the numbers are called unverified until it is explained. With no SCRAM runtime installed, Both still answers and says there is no second opinion. A result made with another engine than the one selected is shown as out of date.

The headless runner (`docs/HEADLESS.md`) takes `--engine scram|builtin`. Its default stays **scram** for now because SEED's adapter was built against it; flipping the runner's default is a coordinated change.

## The built-in engine

- **Diagram.** Variables are the basic events reachable from the top, in the order a depth-first walk first meets them (any order gives the same answer; only the size changes). AND and OR are the usual memoised apply operations. K-of-N is built from them for monotone functions: at least `j` of `f[i..]` holds when at least `j` of `f[i+1..]` holds, or `f[i]` holds and at least `j-1` of `f[i+1..]` hold. No negation exists anywhere, because a coherent tree never needs it.
- **Probability.** `P(node) = p * P(failed branch) + (1 - p) * P(working branch)`, memoised, for independent events. Floating point; on the hand-checkable models the error is far below the `1e-12` tolerance of the oracles.
- **Minimal cut sets.** Rauzy's minimal solutions: the sets of the working branch, plus the failed branch's sets with the variable added, minus any set the working branch already has. (A set of the failed branch can never strictly contain a set of the working branch, because the function is monotone, so no subset test is needed; the mutation run found the subset test was dead code.)
- **Approximations.** Rare-event and min-cut-upper-bound values are computed from the cut sets with the rules in `result.ts`; a rare-event sum above 1 is shown labelled with the bound 1 as the probability, exactly as for SCRAM.
- **Limits fail loudly.** Node limit, cut-set cap, event cap, time limit and cancel each end the run as `failed` (reasons `too-many-nodes`, `too-many-cut-sets`, `too-many-events`, `timeout`) or `cancelled`, with no numbers. Never a partial number presented as complete.
- **Recursion depth** is bounded by the number of events (at most 2000), and gates are walked iteratively, so a chain of 1500 gates does not overflow the stack.

## Verification

Nothing in the engine is checked by itself alone:

1. Every numerical entry of `tests/oracles.json` (hand-derived, tolerance `1e-12`), including the approximation rows, through the whole analysis.
2. 2000 small and 300 larger seeded random trees (probabilities including 0 and 1, repeated references, K-of-N) against exhaustive enumeration with exact rational arithmetic (`tests/oracle/`, which shares no code with the engine): probability within `1e-12`, cut sets exactly equal.
3. The same trees under four different variable orders each: identical cut sets, probability within `1e-12`.
4. The same models through SCRAM (`tests/engine/bdd-vs-scram.test.ts`): hand oracles, both approximations, and 40 random trees: same probability to SCRAM's printed precision, same cut sets.
5. The shapes SCRAM's native K-of-N gets wrong, against the enumerator.
6. Limits, cancel, a time limit that has passed, a 1500-level chain, a hard 14-pair model (16384 cut sets) in about 2 seconds.
7. Mutation tests: `python tests/mutation/verifier_mutations.py engines` (23 deliberate breaks of the diagram, the solver, the analysis, the cross-check, the engine choice; all caught).

Unit tests: `tests/unit/bdd.test.ts`, `crosscheck.test.ts`, engine choice blocks in `server.test.ts`, `web-editor.test.ts`, `headless.test.ts`; e2e: `e2e/engines.spec.ts`, `failures.spec.ts`, `a11y.spec.ts`.

## Known limits

- Floating point, not exact rationals. Probabilities are compared to SCRAM at its printed precision (about six digits).
- A model with more than 2000 reachable events, or more than 50,000 minimal cut sets, is refused (for SCRAM too, at the same cut-set cap).
- The engine's identity has no binary hash (it is a version, `0.1.0`); a source hash can be added when it is packaged.
- No importance measures, uncertainty or time (plan 07).
