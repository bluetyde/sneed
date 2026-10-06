# Plan 10: A built-in second engine

**Status 2026-10-06: S0 to S4 built** (see [ENGINES.md](../ENGINES.md)); S5 done (Codex review of the engine: 8 findings fixed, see ENGINES.md). The user's decisions (2026-10-06): it lives inside this repository; the built-in engine is the default, with SCRAM an optional install (when SNEED is installed from SEED, the SCRAM install is optional) and the independent cross-check; MIT; go now. The headless runner's default stays SCRAM until SEED's adapter is updated to expect otherwise. Text below is the original plan.

Raised by the user on 2026-10-05: is there a better option than SCRAM, and should one be built? This note answers with a plan. Nothing here starts until the user approves it, and it changes nothing in V1.

## Why

SCRAM is a sound engine, and no clearly better open-source one is known (XFTA and SAPHIRE are free but their licences and fit are unchecked; RiskSpectrum and CAFTA are commercial). Its costs for this app are not mathematical:

- GPL-3.0, built from pinned source by the installer, and WSL2 on Windows ([RUNTIME.md](../RUNTIME.md)).
- Three defects the app works around ([spike notes](../spike/README.md)): wrong `atleast` results for some shapes, a silent product-order limit, a rare-event sum above 1 clamped with only a warning.

A second, independent engine gives two things: students with no install step, and a differential check on every model (two implementations that share no code disagreeing is a finding).

## Decision to keep

SCRAM stays. The independent enumeration oracle (`tests/oracle/`, test-only, exact, up to 16 events) stays. The new engine is a third, separate piece of code and must not import from either. It is an option, never a silent replacement, and a result always names the engine that produced it.

## Scope of V1 of the engine

- Static trees of the native model: AND, OR and K-of-N, repeated events, exact probability (probabilities are constants, events independent).
- Method `exact` by a binary decision diagram. Minimal cut sets from the same diagram. The two approximations (rare-event, MCUB) computed from the cut sets with the same rules the app already applies in `src/core/result.ts`.
- Runs in the Node server (and may later run in the browser). No child process, no WSL2, no GPL code.
- Not in scope: importance measures, uncertainty, time, dynamic gates, common-cause groups ([plan 07](07-extensions.md)).

## Design points

- **Resource limits that fail loudly.** A node limit, a cut-set count limit and a time limit. Hitting one gives status `truncated` or `failed` with a named reason, never a partial number presented as complete (same result rules as plan 02).
- **Variable order.** Fixed, documented heuristic (depth-first first appearance). Order changes diagram size, never the answer; a test checks that several orders agree.
- **Determinism.** Same model and settings give identical output, including cut-set order.
- **Voting.** Native K-of-N built directly in the diagram, so the SCRAM `atleast` workaround is not needed.
- **Result record.** Same record, `engine` identity `{name: "sneed-bdd", version, ...}`; no `runtime` install identity.
- **Engine choice.** A setting, default to be decided (see below). "Compare engines" runs both and reports agreement or the exact disagreement.

## Verification (nothing ships unless all pass)

1. Every numerical entry of `tests/oracles.json`, with the frozen tolerances.
2. Seeded random trees (the generator in `tests/oracle/models.ts`): probability equal to the enumeration oracle (exact rationals) and cut sets equal, many thousands of trees across sizes up to the oracle's limit.
3. Differential run against SCRAM on the same trees, with the known SCRAM defects expected and listed, any other difference failing the test.
4. Larger trees (beyond the oracle's limit) checked against SCRAM, and against the diagram with a different variable order.
5. Mutation tests of the engine, in the style of `tests/mutation/verifier_mutations.py` (a deliberately broken engine must fail a test).
6. Limits: each limit tested to produce the named non-success status.

## Milestones

| Step | Output | Gate |
|---|---|---|
| S0 | Decision on repository and default engine (below) | User |
| S1 | BDD construction and exact probability | Oracle entries and 2 pass |
| S2 | Minimal cut sets, approximations, K-of-N | 1 to 3 pass |
| S3 | Limits, cancellation, result record | 6 passes |
| S4 | Engine setting, compare-engines view | e2e with both engines |
| S5 | Mutation tests and a Codex review | Findings resolved |

## Decisions for the user

1. **Where it lives.** Inside the `sneed` repository as `src/engines/bdd/` (simplest, one test suite, MIT already), or its own repository if it should be reusable by the other suite apps. Recommendation: inside `sneed` first, split out only if another app needs it.
2. **Default engine** once S4 passes: the built-in one (no install) with SCRAM as the cross-check, or SCRAM as default with the built-in one optional. Recommendation: built-in default for students, SCRAM kept as the independent check and for larger models.
3. **Licence.** MIT, same as the rest of `sneed`. The engine is written from the published algorithms (Bryant's ordered decision diagrams, Rauzy's minimal solutions); no SCRAM or other GPL code is read into it.
4. **Whether to do it at all.** The cost is real (a solver is verified work, not a quick feature). If install friction is not hurting students, this can wait.
