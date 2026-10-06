# Plan 12: importance measures (plan 07, step 1)

Written 2026-10-06 before the code, as plan 07 requires. Built on the built-in engine only (SCRAM does not supply these for this model class in the pinned build, and nothing here changes the result record, which SEED reads).

## Assumptions (shown with every table)
Static coherent fault tree; basic events independent with constant probabilities; probabilities are those in the model. The measures are **exact** (computed from the same decision diagram as the exact probability), not from cut-set approximations. They describe this model, not a plant; a ranking is a teaching aid, not a design or licensing finding.

## Definitions
Let T be the top event, p_i the probability of basic event i, P = P(T). P(T | i fails) means the top probability with p_i set to 1; P(T | i works) with p_i set to 0.

| Measure | Definition | Reads as |
|---|---|---|
| Birnbaum | IB_i = P(T \| i fails) − P(T \| i works) = ∂P/∂p_i | how much the top probability moves per unit change of p_i |
| Risk achievement worth | RAW_i = P(T \| i fails) / P | how many times more likely the top event is if i is certain to fail |
| Risk reduction worth | RRW_i = P / P(T \| i works) | how many times less likely it would be if i could never fail; **infinite** (reported as null with the reason) when P(T \| i works) = 0, which means that with p_i at zero the top event cannot happen (i is in every cut set that has a non-zero probability) |
| Fussell-Vesely (exact form) | FV_i = (P − P(T \| i works)) / P | the fraction of the top probability that goes away if i never fails. This is the exact version; textbooks also give a cut-set version that differs slightly when probabilities are not small |

Undefined cases: if P = 0, RAW and FV are null (nothing to divide by), RRW is null; a model with P = 0 is flagged. Only events reachable from the top are listed. A repeated reference to one event is one event.

## Hand oracles (level 3)
A AND B, p_A = 0.1, p_B = 0.2: P = 0.02. IB_A = 0.2, IB_B = 0.1; RAW_A = 10, RAW_B = 5; RRW_A, RRW_B infinite (null); FV_A = FV_B = 1.
A OR B: P = 0.28. IB_A = 0.8, IB_B = 0.9; RAW_A = 1/0.28; RAW_B = 1/0.28; RRW_A = 0.28/0.2 = 1.4, RRW_B = 0.28/0.1 = 2.8; FV_A = 0.08/0.28, FV_B = 0.18/0.28.
Repeated event: (A AND B) OR (A AND C) is A AND (B OR C): IB_A = P(B OR C); IB_B = p_A (1 − p_C).

## Independent oracle (level 2)
The exhaustive enumeration oracle (`tests/oracle/enumerate.ts`, exact rationals) computes P(T | i fails) and P(T | i works) by changing the model's p_i to 1 and 0, with no shared code. Required on the frozen oracle models and 1000 random trees: every measure agrees to 1e-12 relative. Also the identity IB_i = ∂P/∂p_i is checked by a finite difference, and FV and RRW are checked to satisfy FV = 1 − 1/RRW.

## Numerical honesty
The Birnbaum difference is taken on the "false" side when the top event is almost certain (an OR of twenty events at 0.9 has Birnbaum 1e-19 per event, which a plain `P(T|i fails) - P(T|i works)` would round to 0). Fussell-Vesely is p_i x Birnbaum / P. A top probability or a conditional probability that underflowed to 0 although the event can structurally happen, or any non-finite measure, is a failure (`numeric-range`), never a table with a wrong zero. "Impossible" is decided structurally (every free event at probability 0.5), not by the size of a number.

## Limits and failure
At most 300 reachable events and a diagram-size budget (events x nodes); beyond that the answer is a refusal with the reason (`too-large`), never a partial table. Runs in the same worker thread as the solver with the same time and memory limits; cancel works. An invalid model is refused with the validator's errors.

## Interface
`POST /api/importance {text}` returns `{kind:'ok', model_hash, engine, top, events:[{id, name?, probability, birnbaum, raw, rrw, fv}], definitions, assumptions}` or `{kind:'refused'|'failed', ...}`. Nothing is written. The Results panel has a section "Importance" with a button; the table is tied to the model hash and disappears when the model changes. Sorted by Birnbaum, largest first, ties by id.

## Not in scope
Importance for approximation methods; measures for groups of events; uncertainty on the measures; any export of these into SEED records.
