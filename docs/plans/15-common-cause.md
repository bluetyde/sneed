# Plan 15: Common-cause failure groups (plan 07, step 3): semantics, written before any code

**Status 2026-10-25: DECIDED (the owner approved all five recommendations in section 8). Stage C0 is done: oracles CC1 to CC6 are frozen in `tests/oracles-common-cause.json`. Stage C1 is done (2026-10-25): schema, validator, error codes, fixtures and hash vectors. Stage C2 is done (2026-10-25): the built-in fault-tree analysis expands groups and matches the six frozen oracles and an exact evaluation of the group definition on random trees. Stage C3 is done (2026-10-25) except the run against the real SCRAM, which needs WSL (see section 7): the Open-PSA export writes the expansion, the SCRAM path and the headless runner take groups. Stage C4 is done (2026-10-25): the editor makes, draws and edits groups, the result panel reads the answer against the independent one, Compare and the printable figure know groups, and lesson 5 is graded against the frozen oracles. Event trees and importance measures take groups too (2026-10-25, after C4; `E_CCF_NOT_ANALYSED` is gone: nothing ignores a group any more). **Open: the real-SCRAM run (needs WSL), the instructor read of lesson 5, a human screen-reader pass of the group screens, and the fixes for the Codex review (done 2026-10-25 over C1 to C4: 8 findings, 7 distinct, listed in TODO.md, none fixed yet).** This plan follows [plan 07](07-extensions.md), which says each extension needs a stated model, its assumptions, its data source and independent reference cases before it ships. The owner chose to start before P3 is verified (question Q4), which plan 07 does not otherwise allow.

## 1. What this is, and what it is not

Two components of one kind can fail together for one shared reason, such as the same maintenance error or the same manufacturing flaw. The V1 tree cannot say this. Its basic events are independent, and a repeated event (one event used in two places) is a different thing. A **common-cause group** is a visible object in the tree that says which events can fail together, and how often.

This is a teaching model with one parametric method. It is not a plant model. The parameter values in examples and lessons are invented and labelled as invented. The app does not claim a data source until the basic-event data library exists (TODO, P4).

## 2. The model: beta-factor, in the first version only

The group has `n` members (2 to 8). Each member is a basic event of the tree. Each member has one **total failure probability** `Q`. The group has one parameter `beta` with 0 <= beta <= 1. It is the fraction of each member's failures that is a common-cause failure.

Each member `i` is replaced, at analysis time, by this logic:

- Member `i` fails if its **independent part** `I_i` occurs. `P(I_i) = (1 - beta) x Q`.
- Member `i` also fails if the **group event** `C` occurs. `P(C) = beta x Q`. `C` is one event shared by all members of the group.

So member `i` = `I_i` OR `C`. The `I_i` and `C` are independent of each other. Their probabilities **add up** to `Q` for each member, so `Q` is the number the student sees and sets. **Written down after stage C4 (2026-10-25): the probability that member `i` fails is not exactly `Q`.** Both ways of failing can happen, so it is `1 - (1 - (1 - beta) Q)(1 - beta Q) = Q - beta (1 - beta) Q^2`: 0.0991 for `Q` = 0.1 and `beta` = 0.1. This is the usual way PRA codes expand the beta-factor model (it treats the two ways as independent events and accepts a small difference, the rare-event approximation). The frozen oracles and every engine use this definition. A model that needs `P(member) = Q` exactly would need the two ways to exclude each other, which the first version does not do.

Three limits follow, and the app states all of them:

1. Every failure of the group is either one member alone or all members together. The model has **no partial common-cause events** (for example two of three). Alpha-factor and MGL models have them and stay out of the first version (question Q1).
2. All members share one `Q`. The app refuses a group whose members have different probabilities (`E_CCF_UNEQUAL_Q`).
3. `beta` is an input. It is not computed from data.

## 3. Where the group lives

- A new optional top-level array `common_cause_groups` in the native model: `[{id, name, method: "beta-factor", members: [event ids], beta}]`.
- The **assumptions block** changes for a model that has groups. V1 requires `independence: "declared-independent"`. A model with groups carries `independence: "beta-factor-groups"`. A model without groups is unchanged, so every V1 model, hash and oracle stays valid. A result made under the new assumption is a different kind of result and says so ([plan 07](07-extensions.md), "Rules for every extension").
- The model hash covers the groups (members, method, beta). It is the same hash rule as for gates.
- An event can be a member of at most one group (`E_CCF_OVERLAP`). A member must be a basic event that exists (`E_CCF_UNKNOWN_MEMBER`). A group needs at least 2 members (`E_CCF_TOO_SMALL`) and at most 8 (`E_CCF_TOO_LARGE`). `beta` outside 0 to 1 is `E_CCF_BETA_RANGE`.
- Unknown fields on a group are kept and give `W_UNKNOWN_FIELD`, as for every other object.

## 4. How the engines see it: expansion

The app **expands** each group into ordinary events and gates before any engine runs. This is the same approach the exporter already uses for voting gates. It means:

- The built-in solver and SCRAM need no change.
- The expansion is the one place where the model is defined, so it is the first thing to review.
- A group member `E` becomes an OR gate with two inputs: a new basic event `E.independent` and the shared event `C`. The group event is named `<group id>.CCF` and appears in cut sets under that name.
- Cut sets show the group event as "common cause of <group name>". A one-element cut set made of `C` is the main teaching point.
- A repeated reference to a member (the member used in two gates) stays one member. Both uses see the same OR gate.

The expansion is deterministic, so the same model gives the same run. It adds `n + 1` basic events and `n` gates per group. The existing limits on event count apply to the expanded model, and a refusal names the group.

## 5. Reference cases (oracles), worked by hand before any code

**Frozen 2026-10-25** in `tests/oracles-common-cause.json`, a file of its own. It is kept apart from `tests/oracles.json` because many suites run every entry of that file through the engines, and the engines have no group support yet. `tests/unit/oracle-common-cause.test.ts` recomputes each value in exact rational arithmetic from the group definition (not from the closed forms) and checks the zero check, the closed forms and the cut-set names. Two deliberate breaks (a frozen value off by 1e-6, and a wrong rule in the evaluator) make it fail. The engines are checked against the same file at stage C2. For the cases with `beta` = 0 or 1 the cut sets are not frozen.

All values use `Q = 0.1` and `beta = 0.1`. So `P(I) = 0.09` and `P(C) = 0.01`. These are the values to freeze in `tests/oracles.json` first. They must also agree with the brute-force enumeration oracle on the expanded model.

| Case | Logic | Hand result | How |
|---|---|---|---|
| CC1 | A AND B, group {A, B} | **0.018019** | `P = P(C) + (1 - P(C)) x P(I)^2 = 0.01 + 0.99 x 0.0081`. Cut sets: {C}, {I_A, I_B}. The independent value is 0.01. |
| CC2 | A OR B, group {A, B} | **0.180181** | `P = 1 - (1 - 0.09)^2 x (1 - 0.01) = 1 - 0.8281 x 0.99`. Cut sets: {I_A}, {I_B}, {C}. The independent value is 0.19. The group makes the OR value lower. |
| CC3 | 2-out-of-3 of A, B, C3, group of all three | **0.03261358** | `P(at least 2 of 3 I) = 3 x 0.0081 x 0.91 + 0.000729 = 0.022842`. Then `P = 1 - 0.99 x (1 - 0.022842)`. The independent value is 0.028. |
| CC4 | CC1 with `beta = 0` | **0.01** | Zero check: must equal A AND B with independent events, exactly. Required by plan 07. |
| CC5 | CC2 with `beta = 0` | **0.19** | The same zero check for an OR. |
| CC6 | CC1 with `beta = 1` | **0.1** | All failure is common: the AND of two members fails as often as one member. |
| CC7 | A AND B, group {A, B}, and a third event D (not in the group) in OR with the AND | to be fixed in section 5a | Checks that a group does not touch other events. |

Two more checks are required:

- **Closed forms.** CC1 and CC2 have the closed forms above. The test computes them again in exact rational arithmetic, not with the solver's floating point.
- **Direct versus expanded.** An independent evaluator (the enumeration oracle) works on the group definition itself, not on the expansion. It computes the probability by summing over `C` and the `I_i`. The expansion and this evaluator must agree on random trees with groups (the same seeded random-tree approach as plan 05).

### 5a. To fix before code

CC7 needs a chosen tree and a hand value. I will not freeze a number for it until the owner has approved the model.

## 6. What the student sees

- A group is drawn as a box around its members with the group name and `beta`. Selecting a group shows its members. The Properties panel edits `beta` and the member list.
- The result panel says "common-cause groups used: beta-factor", lists each group with its `beta`, and shows the independent value next to the group value, as a different kind of result. A result with groups never looks like a V1 result.
- A lesson follows after the engine passes (one lesson, CC1 and CC2 side by side: the AND gets worse and the OR gets better). The lesson rules in [plan 04](04-lessons.md) apply.

## 7. Staged build (each stage ends with a Codex review)

1. **Stage C0 (done).** This plan, approved. The oracles CC1 to CC6 frozen with their derivations.
2. **Stage C1 (done 2026-10-25).** Schema, validator, error codes, one bad fixture per code, hash vectors. Added beyond the list: `E_CCF_ASSUMPTION` (the assumptions block and the groups must agree), `E_CCF_NOT_ANALYSED` (a stop at every analysis entry and at the exporter until stage C2), group ids checked like other ids, and the Properties panel no longer says "independent" for a model with groups. The hash has a group part only when the list is not empty. See [docs/SCHEMA.md](../SCHEMA.md).
3. **Stage C2 (done 2026-10-25).** Expansion (`src/core/ccf.ts`), the built-in engine (`src/engines/bdd/analyze.ts`), and the enumeration oracle on the group definition (`tests/oracle/groups.ts`). Checked by `tests/unit/ccf-engine.test.ts`: the six frozen cases, 80 random trees with groups (probability exact to 1e-12 and cut sets equal), the zero check through the engine, and the unit tests of the expansion. Mutations: `python tests/mutation/verifier_mutations.py ccf`. Decisions taken: only the built-in fault-tree analysis handles groups, so `E_CCF_NOT_ANALYSED` stays for the other four paths; the result record has an optional `common_cause` block; the record's `model_hash` is the original model's and `exported_input_hash` is the expansion's. Open for C3: with the engine choice "both", the SCRAM leg refuses a model with groups and the cross-check says "SCRAM refused the model", which is true but not specific.
4. **Stage C3 (done 2026-10-25, real-SCRAM run still open).** Export to Open-PSA (the expansion is written out) and the headless verbs. Import of groups stays out: the Open-PSA subset grows only with a documented change ([OPEN-PSA-SUBSET.md](../OPEN-PSA-SUBSET.md), rule 8). SCRAM refuses a dot in a name, so the group event and the independent parts are written as `G__CCF` and `A__independent` (a number is added if the name is taken), the table is `export_mapping.renamed`, and `assess` translates the engine's cut sets back (`renameEvents`), so both engines report `G.CCF` and `A.independent`. `analyze()` expands the model, hashes the original, and records the groups. The runner: `describe` lists the capability `common-cause-beta-factor`, the meaning text names the groups, `run` and `validate` work (`tests/unit/ccf-headless.test.ts`). Checked without SCRAM: the exported XML evaluated by `tests/oracle/xmleval.ts` has the frozen probabilities and the exact probability of the group definition on 60 random trees; a fabricated SCRAM report is read back in the model's names, and is refused without the translation (`tests/unit/ccf-export.test.ts`). **Not run: `tests/engine/ccf.test.ts` (the real SCRAM on the six cases and 15 random trees). It needs WSL and the installed runtime, so it has to be run on the Windows machine (`npm run test:engine`).**
6. **After C4: event trees and importance measures (done 2026-10-25).** Both run on the expansion. Event trees: the tree names the original model (its hash and its event and gate ids), the engine gets the expansion, a heading can be a group member (it is an OR gate in the expansion), and the record gets an optional `common_cause` block and a caveat that the independent-events assumption does not hold for the group's members. Importance: the table is for the expanded events (`A.independent`, `G.CCF`) with names ("A on its own", "common cause of group G") and a note in the assumptions; the `model_hash` is the original's. The stop code `E_CCF_NOT_ANALYSED` is removed. Checked against exact enumeration of the plain tree (`tests/oracle/groups.ts`, `groupsToPlain`, written separately from `src/core/ccf.ts`): hand numbers for two headings that are the two pumps of a group, 60 random trees for event trees, 40 for importance, the API route, and mutations. **Found while doing this:** the probability that a member fails is `Q - beta (1 - beta) Q^2`, not `Q` (section 2 now says so; lesson 5's last hand-calculation line was corrected). The event-tree editor shows which headings depend on a group and lists the headings that fail together (done 2026-10-25, see [EDITOR.md](../EDITOR.md)). Not done: the event-tree lessons say nothing of groups, and comparing two saved event-tree analyses does not list the models' groups.
5. **Stage C4 (done 2026-10-25).** Editor, result panel, one lesson. Built: the document operations (`src/web/model/doc.ts`: `addGroup`, `addToGroup`, `removeFromGroup`, `removeGroup`, `setBeta`, `setGroupName`; the members share one probability; a group left with one member is removed, and the assumptions follow the groups, so the editor never makes `E_CCF_ASSUMPTION`), the editor commands and group selection, the drawing (a dashed box with name and beta behind the members and a tag on each member node), the Properties panel (a block in an event's properties, a form for a group, a list in the model properties), the outline, hints for the new codes, the results panel ("Common-cause groups used", the independent value read against the answer), the comparison (groups added, removed, changed), the printable figure, and lesson 5 (`lessons/05-common-cause.json`; the server reads `tests/oracles-common-cause.json` beside `tests/oracles.json`; `lesson.ts` gained the checks `group` and `no-group`). The result record's `common_cause` block gained `independent_value`: the built-in engine solves the same events a second time without the groups, the SCRAM path leaves it `null`. Decisions: a group is created from an event's properties (no ribbon button, no dragging into a box); group names matter to the lesson (the student names it G, as the other lessons ask for event names). Checked by `tests/unit/ccf-editor.test.ts`, `tests/unit/lesson.test.ts`, `e2e/common-cause.spec.ts` (4 tests in a real browser with an axe audit of two states) and mutations of the logic code (58 run: 56 caught at first; the 2 survivors showed two tests that could not fail and one real gap, a beta out of range named no group so a click on the problem could not select it; all three are fixed and caught now). **The drawing, properties panel, outline and results panel are covered by the browser tests only, not by mutations.** In the wider browser suite 82 of 90 pass here; the 8 that fail also fail on the stage C3 commit and need the real SCRAM or its runtime.

## 8. Questions for the owner (all five approved as recommended, 2026-10-25)

- **Q1. Which model?** Recommended: beta-factor only. It has one parameter, a hand-checkable closed form and the clear zero check. Alpha-factor and MGL need more data and give partial events. They can follow as a later step.
- **Q2. One `Q` per group (`E_CCF_UNEQUAL_Q`), or let members differ?** Recommended: one `Q`. The beta-factor model is defined that way.
- **Q3. Group size.** Recommended: 2 to 8 members.
- **Q4. Start now or wait for P3?** Plan 07 says to wait. This plan can be read and approved now without any code.
- **Q5. Data.** Recommended: `beta` is always an input, labelled invented, until the data library exists.
