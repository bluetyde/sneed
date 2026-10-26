# Oracles: what SNEED's results are checked against

An **oracle** is an expected value that does not come from the code it checks. This page lists every kind SNEED has, where each number comes from, how tight it is and which test holds it. If a result is right, it is right against one of these. Where there is none, or only a weak one, that is said at the end.

**Read this first:** SNEED has two small oracles taken from a published source (two worked examples of NUREG-0492, the Fault Tree Handbook, one of which has a printed arithmetic slip that is pinned and explained). Every other expected value was worked out by us, by hand or by a second program we wrote, and the one independent third-party program, SCRAM, is itself known to be wrong for some voting gates. The probabilities in the examples and lessons are invented. These checks show that the code computes what the documents say it computes; they do not show that the model describes any real plant.

## The rules every oracle follows

- **The expected value never comes from the code under test.** It is a number worked out by hand and written in the oracle's own file, an exact calculation by a different method, or a different program.
- **Tolerances are fixed before any run** and are never loosened after seeing a result. The frozen entries use an absolute tolerance of 1e-12. A lesson may grade with at most 1e-9 (`MAX_TOLERANCE` in `src/core/lesson.ts`), which is far too narrow to accept a wrong answer.
- **Expected values were written before the first run.** The hand oracles, the validator fixtures and the hand cases for the thermal-hydraulic judgement were all written from the documents first; a test that disagreed meant the code or the document was wrong, not that the value moved.
- **An oracle is tested by breaking the code once.** `tests/mutation/verifier_mutations.py` changes the code on purpose (more than a thousand deliberate breaks, by area) and requires the tests to fail. A break that leaves the tests green is a gap and is fixed. This tests the oracles' power to detect errors, not that their numbers are true.
- **Say what it does not prove.** An oracle for the arithmetic of a rule does not prove the rule.

## The kinds, from strongest to weakest evidence

| Kind | Where the number comes from | What it can catch |
|---|---|---|
| **Literature** | numbers, structures and cut sets printed in a published source | a formula or a reading of the model that is wrong in the same way as the code. **SNEED has two examples, both from one handbook.** |
| **Independent program** | the same quantity from software written by someone else (SCRAM) | a bug in our solver or exporter, and a bug in theirs |
| **Independent implementation** | the same quantity from a different method that we wrote (exact brute force over every failure state) | a bug in the diagram solver, the exporter, the expansion of groups, the event-tree evaluation |
| **Closed form** | a formula worked out by hand and written in the oracle's own file | a bug in the code that implements the same model |
| **Refusal** | a case with one fault that must be refused with a named code | a check that does not fire |
| **Identity** | the model hash computed by three implementations in three languages | a hash that changes when the meaning does not, or the reverse |
| **Rule cases** | the expected status of a judgement, decided from the rule | a judgement that reads a stale or mismatched answer as held |

## The catalogue

### Literature

`tests/oracles-literature.json` holds two worked examples of **NUREG-0492, the Fault Tree Handbook** (U.S. Nuclear Regulatory Commission, January 1981), read on 2026-10-26 from the NRC's own copy (<https://www.nrc.gov/docs/ML1007/ML100780465.pdf>, 7.92 MB; the catalogue page is <https://www.nrc.gov/regulations-legislation/nureg-series-publications/publications-prepared-by-nrc-staff/sr0492>) through its text layer and the page images. The NRC says its website is a U.S. Government work and not subject to copyright, and that a NUREG can contain third-party material with its own permission; only numbers, Boolean structure and page references are used here, and the PDF is not kept in the repository.

| Oracle | What the handbook prints | Held by |
|---|---|---|
| **The pressure tank example**, Chapter VIII, pages VIII-12 to VIII-14 (Figure VIII-14, Table VIII-1) | The reduced tree (E1 = T OR E2; E2 = E3 OR K2; E3 = S AND E4; E4 = S1 OR E5; E5 = K1 OR R); the six failure probabilities; the five minimal cut sets T, K2, S.S1, S.K1, S.R; the five cut set probabilities (5e-6, 3e-5, 3e-9, 1e-8, 3e-9, each the exact product of the table values); the importances 14 percent, 86 percent and under 0.1 percent | `tests/unit/oracle-literature.test.ts` (solver, enumerator, exact products, shares to the whole percent); `tests/engine/oracle-literature.test.ts` (the real SCRAM) |
| **The three motor example**, overrun of Motor 2, Chapter IX, pages IX-7 and IX-8 | The Boolean equations of the reduced tree and its seven minimal cut sets; the events K1, S1 and KT2 appear in more than one branch, and the handbook names K3.K1.K2 as a set that is not minimal. The handbook gives no probabilities for this example, so ours are invented and only the cut sets are literature. | the same two files |

**A disagreement we found, pinned and explained.** On page VIII-14 the handbook prints P(E1) = 3.4e-5 as the sum of the cut set probabilities, but the five probabilities it prints on the same page add up to 3.5016e-5, and the importances it prints (14 percent and 86 percent) are the shares of 3.5e-5; shares of 3.4e-5 would be 15 and 88. So the printed top value is an arithmetic slip in the source. The value we hold is the sum of the printed cut set probabilities; the test pins the gap (about 2.9 percent) so that it is noticed if either side changes. Our exact probability (3.5016e-5 to five digits) agrees with that sum to better than 1e-5 of itself, which supports the handbook's own remark that the rare-event approximation applies.

Parameter data (for example NUREG/CR-6928) is a different thing: it would feed a data library (TODO, P4), not serve as an oracle.

### Independent program

| Oracle | Method | Tolerance | Held by |
|---|---|---|---|
| SCRAM 0.16.2 against the built-in solver: 40 random trees (repeated references, K-of-N, probabilities including 0 and 1) | same probability and same cut sets from a separate program | the larger of 1e-12 and 5e-5 of the value (SCRAM prints a limited number of digits) | `tests/engine/bdd-vs-scram.test.ts` (needs WSL and SCRAM) |
| The frozen fault-tree oracles and 68 random trees through the exporter and the real SCRAM | exact probability and every cut set against the brute-force oracle below | 1e-12 absolute; cut sets equal | `tests/engine/headless.test.ts` |
| The common-cause cases through the real SCRAM | the expansion exported with names SCRAM accepts, cut sets translated back | the oracle tolerance | `tests/engine/ccf.test.ts` |

SCRAM is wrong for some `atleast` shapes and says nothing (reported upstream, issue 294). Our exporter avoids that shape, so these checks do not exercise it; the defect is pinned by its own test in `tests/engine/headless.test.ts`.

### Independent implementations (written by us, by a different method)

| Oracle | Method | Held by |
|---|---|---|
| `tests/oracle/enumerate.ts` | Exact arithmetic (BigInt rationals). The probability is the sum over every failure state of the reachable basic events; the cut sets are the minimal failing sets found by testing every subset. At most 16 reachable events. It shares no code with the solver or the exporter except the validator, which only refuses invalid models. | `tests/unit/oracle.test.ts` (300 small and 25 larger random trees, each also checked by a second evaluator and by inclusion-exclusion); `tests/unit/bdd.test.ts` (2000 small random trees and 300 larger ones of 11 to 14 events, probability to 1e-12 and cut sets equal); `tests/unit/importance.test.ts` (1000 random trees) |
| `tests/oracle/event-tree.ts` | The same idea for event trees: every sequence and end state by exact enumeration over the events of one fault-tree model, shared events counted once | `tests/unit/event-tree-engine.test.ts` (1000 random models and trees, relative 1e-12), `tests/unit/event-tree-oracles.test.ts` |
| `tests/oracle/groups.ts` | An exact evaluation of the common-cause group definition itself (summing over the group event and the independent parts), not of its expansion | `tests/unit/ccf-engine.test.ts` (80 random trees with groups, probability 1e-12 and cut sets equal), `tests/unit/ccf-event-tree-importance.test.ts` (60 random event trees with groups) |
| `tests/oracle/xmleval.ts` | Evaluates the exported Open-PSA XML independently of SCRAM, so the exporter is checked without the engine | `tests/unit/export.test.ts`, `tests/unit/ccf-export.test.ts` |
| Variable order | The answer must not depend on the order of the events: 300 trees, each solved under four orders, agree to 1e-12 with identical cut sets. This is a consistency check, not a value from outside. | `tests/unit/bdd.test.ts` |

### Closed forms

- **`tests/oracles.json`**: 18 entries. 13 are numerical: the probability and the minimal cut sets of small trees, each with its derivation written in the entry (for example `0.1 * 0.2`): AND, OR, a repeated event (A AND A, A OR A), a shared event, one to three pumps with shared and separate supplies (0.0595 against 0.021025), a 2-of-3 gate in the exact, rare-event and min-cut-upper-bound methods. Tolerance 1e-12 absolute. Held by `tests/unit/oracle.test.ts` and, through the real engine, `tests/engine/headless.test.ts`. The other 5 are four refusals and one truncation case (see below).
- **`tests/oracles-common-cause.json`**: 7 entries for beta-factor groups (an AND, an OR and a 2-of-3 of members; the AND and OR with beta 0, which must equal the independent value; the AND with beta 1; the AND in OR with an event outside the group, CC7). Every value is recomputed from the group definition in exact rational arithmetic, not from the closed forms; tolerance 1e-12. Held by `tests/unit/oracle-common-cause.test.ts` and `tests/unit/ccf-engine.test.ts`. CC7 uses a tree I chose (the owner has not approved it).
- **`tests/event-tree-oracles.json`**: 3 entries (independent headings, a shared event, a bypass), re-derived in a test by exact rational enumeration; tolerance 1e-12. They also grade the three event-tree lessons.
- **Importance measures**: four hand cases with the numbers in the test (A AND B, A OR B, a repeated event, a 2-of-3 gate), plus agreement with the enumerator and with a finite difference of the exact probability (`tests/unit/importance.test.ts`).
- **Lessons**: the five fault-tree lessons (lesson 5, on common-cause groups, is graded against the group cases) and the three event-tree lessons are graded against the oracle entries above; a lesson whose numbers are missing from or differ from its oracle is refused at loading (`src/core/lesson.ts`, `src/server/event-tree-lessons.ts`).
- **SEED entries, `oracles/seed/entries/`**: 14 entries in SEED's format (11 numerical and 3 refusals), generated from `tests/oracles.json` by `scripts/gen-seed-oracles.ts`; tolerance 1e-12 absolute, 0 relative. The entries that need run settings SEED's format cannot hold (the rare-event and bound methods, the unsupported construct, the truncation case) stay in `tests/oracles.json`. Held by `tests/unit/seed-oracles.test.ts`.

### Refusals

- `tests/oracles.json`: bad probability (`E_PROB_RANGE`), a cycle (`E_CYCLE`), a missing reference (`E_MISSING_REF`), an unsupported construct (`E_UNSUPPORTED`); the truncation case records the observed behaviour of the engine's size limit and has no frozen value.
- `schema/vectors/`: 49 bad and 15 good model fixtures, each bad one with the one error code it must give; the expected issue sets (`schema/vectors/expected.json`) were written from `docs/SCHEMA.md` before the first run. Held by `tests/unit/validate.test.ts`.
- The canonical-hash refusals (duplicate ids, a name used for an event and a gate or a group) are in the identity vectors below; the importer's refused constructs, the event-tree validator and the criterion and mutation-record validators have their own tests (`tests/unit/import.test.ts`, `tests/unit/event-tree.test.ts`, `tests/unit/th-criterion.test.ts`, `tests/unit/th-mutation.test.ts`).

### Identity

`tests/canonical/vectors.json`: 17 number cases written from the RFC 8785 rules, 27 model cases (what changes the hash and what must not, including ids such as `__proto__`), 15 id cases and 5 refusals. Reproduced by Python (`tests/canonical/canon.py`), by Node (`tests/canonical/check_vectors.cjs`) and by the TypeScript code (`tests/unit/canonical.test.ts`).

### Rule cases

`tests/th-criterion-oracles.json`: 43 cases for the judgement of one thermal-hydraulic answer against a criterion (held, did not hold, stale, not determined, with the reasons) and 8 for finding the criterion of a heading; plus the record and route tests. The expected statuses were decided from the rule in `docs/plans/14-th-link.md`. They check the logic of the judgement, not any thermal-hydraulic result: the answers are entered by hand.

## What the oracles do not prove

- **No real system.** Nothing here is compared with plant data. The two published examples are teaching examples from a 1981 handbook, a relay circuit and a motor circuit with independent events: they say nothing about voting gates, common-cause groups or event trees, the handbook's quantitative chapters and its other examples have not been mined, and its numbers are not plant data. The probabilities and frequencies everywhere else are inputs, invented and labelled.
- **Our own derivations.** The hand closed forms and the brute-force oracles were written by the same people (and the same AI) who wrote the solver. They use a different method, so a bug in the method shows, but a shared misreading of what a model means would pass every one of them. The one independent program, SCRAM, has a known defect and is compared at a looser tolerance.
- **The model class.** Static, coherent trees, independent basic events of constant probability, one initiating event with a constant frequency: these assumptions are stated, not tested against anything.
- **Beta-factor.** The oracles check our implementation of the stated definition (a member fails if its independent part or the group event occurs, so its probability is Q - beta(1-beta)Q^2, not Q). They do not show that the model fits real failures; beta is an invented input.
- **Large trees.** The brute-force oracle stops at 16 events. A tree near the engine's limit of 2000 events has no brute-force check; there the evidence is the agreement on small trees and the independence of the answer from the variable order.
- **Event-tree frequencies and importance tables** are exact for the stated assumptions and checked against enumeration and hand cases, not against a published table.
- **Lessons.** The expected answers are the oracles above; no instructor has read the lessons yet (`docs/LESSON-REVIEW.md`).
- **No second solver.** The cross-check against a second solver such as XFTA is not done (TODO, P4).
- **The mutation checks** show the tests would notice a break. They are not a source of truth. (For the literature file they change the entries on purpose, for example a table value, a gate or a cut set, and the test must fail.)

## Adding one

1. Pick the kind. Prefer a published value or an independent program to a closed form of your own.
2. Write the expected value in a file that imports nothing from `src/core` or `src/engines`; put the source or the derivation in the entry.
3. Fix the tolerance, with its reasoning, before running the code.
4. Write the test; then break the code on purpose (add a mutant to `tests/mutation/verifier_mutations.py` and run its mode) and see the test fail.
5. For a SEED entry, add it to `scripts/gen-seed-oracles.ts`, run `npm run gen:seed-oracles`, and check that the existing entries are byte-identical (`git status oracles/seed`).
6. Update this page: the kind, the count, the tolerance, the test, and what the new oracle does not prove.
