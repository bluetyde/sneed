# Plan 05: Verification

How we know the numbers are right. Runs through every milestone; P2 is the main gate. The entries here are also PRA's oracle set for the SEED agentic harness (RAFT is the first adapter; PRA is second). Keep local versioned entries until SEED E0 fixes its oracle-entry format (see the SEED repo's `docs/plans/06-oracles-and-verification.md`). Method follows Virtual Reactor's validation plan: define the metrics and decision process before looking at results.

## Levels

| Level | Question | Method | When |
|---|---|---|---|
| 1. Contract | Does the model and result schema hold? | Good and bad fixtures; validator | P0, every change |
| 2. Engine parity | Does the app's run equal a direct SCRAM run? | Same snapshot through the app and directly; compare top probability and cut sets | P2, every engine or adapter change |
| 3. Oracle | Is the answer right? | Hand derivations and closed forms, checked a second way | P2 onward |
| 4. Refusal | Does it refuse what it must? | Bad-input cases with the expected error code | P1 onward |
| 5. Limit | Does it say when it is outside its scope? | Unsupported construct and truncation cases | P2 onward |
| 6. Suite | Does SEED's run equal the standalone run? | Workspace vs standalone on the same immutable input | P3 |

**Independence:** parity catches wrapper drift only; a mistake shared by SCRAM and its direct use would pass it. The hand oracles (level 3) are what catch shared mistakes, and each is derived without running the engine.

## Oracle entries (draft; tolerances fixed before the first run)

Synthetic probabilities. Independence stated. Values were recomputed by a second method on 2026-10-03 (a short script and inclusion-exclusion).

| ID | Model | Expected | Method note |
|---|---|---|---|
| pra-and | A=0.1, B=0.2; A AND B | 0.02 | product |
| pra-or | A OR B | 0.28 | 1 − 0.9 × 0.8 |
| pra-aa | A AND A | 0.1, cut set {A} | repeated identity, not 0.01 |
| pra-oa | A OR A | 0.1, cut set {A} | repeated identity, not 0.19 |
| pra-shared | (A AND B) OR (A AND C), C=0.3 | 0.044; cut sets {A,B}, {A,C} | A × (1 − 0.8 × 0.7) |
| pra-pump1 | P (0.1) | 0.1 | lesson 1 |
| pra-pump2-and | P1 AND P2 (0.1 each) | 0.01 | lesson 2 |
| pra-pump2-or | P1 OR P2 | 0.19 | lesson 2 |
| pra-pump3-shared | S OR (P1 AND P2), S=0.05 | 0.0595; cut sets {S}, {P1,P2} | 0.05 + 0.01 − 0.0005 |
| pra-pump3-separate | (P1 OR S1) AND (P2 OR S2), S1, S2 = 0.05 | 0.021025 | (1 − 0.95 × 0.9)² |
| pra-vote-exact | 2-of-3, p=0.1 | 0.028 | 3p² − 2p³; AND/OR expansion suffices |
| pra-vote-rare | same, rare-event method | 0.03 | 3p² |
| pra-vote-mcub | same, min-cut upper bound | 0.029701 | 1 − (1 − p²)³ |
| pra-bad-prob | probability 1.2 | refusal `E_PROB_RANGE` | bad-input |
| pra-cycle | gate referencing itself via another gate | refusal `E_CYCLE` | bad-input |
| pra-missing | gate input ID not defined | refusal `E_MISSING_REF` | bad-input |
| pra-unsupported | an Open-PSA construct outside the subset | refusal `E_UNSUPPORTED` naming it; input preserved | known-limit |
| pra-trunc | a model that hits a cut-set limit | `status=truncated`, `completeness=truncated`; complete collection refused | known-limit |

The method-specific rows (rare-event, min-cut upper bound) depend on SCRAM exposing those methods (P0). Before the first numerical run, save each fixture and independent derivation with absolute tolerance `1e-12`, relative tolerance `0`, for every numerical row above, including the approximation-specific rows. Compare cut-set membership exactly after sorting event IDs within sets and sorting the sets; compare refusal codes and lifecycle/completeness exactly. Voting cases can use the AND/OR expansion `(A AND B) OR (A AND C) OR (B AND C)` without deciding native voting support.

If output precision cannot meet the frozen tolerance, retain the failed evidence. First seek a supported higher-precision output; any tolerance change requires a separate versioned decision justified by documented precision and independent error bounds, followed by new runs. Never loosen a threshold just because an observed answer misses it.

Determinism compares normalized numerical fields, method, assumptions, completeness and cut-set membership under identical inputs/settings/build. Retain both raw reports and hashes; timestamps, elapsed time, paths and ordering may differ only where P0 documents them as non-semantic. Unknown differences fail investigation rather than being discarded. Raw byte equality is not required.

Add a test-only independent state-enumeration oracle (up to 16 distinct basic-event IDs) and seeded random coherent-tree comparisons after the schema. It evaluates each identity once per state, includes probabilities zero and one, and checks minimal cut sets independently as well as probability. It is never a production fallback solver.

## Gates

- A failing level 1 to 4 entry blocks the build and any SEED study that uses the app.
- A failing level 5 or 6 entry blocks the affected feature and is recorded, not hidden.
- An engine version bump re-runs the set and records which verdicts moved.

## Tests of the verifier

For each level, a deliberately wrong run must fail the check: a perturbed probability, a swapped gate type, a dropped repeated-event identity (A AND A treated as two events), a missing refusal, a changed tolerance. A gate that cannot fail is useless.

## Honesty rules

- Never adjust an expected value to match the engine. A changed expected value needs a source and a second derivation.
- Say what the oracle set does not cover (common-cause, time dependence, event trees, uncertainty).
- A lesson's number must come from this table, not from running the engine and copying the output.

## Open

- P0 must establish whether the pinned engine can emit sufficient precision for the frozen criteria.
- SEED E0 must fix the versioned oracle-entry schema before suite registration.
