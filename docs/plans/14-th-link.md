# Plan 14: Thermal-hydraulic link for event trees (design note, nothing built)

Status: design note written 2026-10-07 at the owner's request. It starts nothing. It follows the open TODO item "T-H link (success criteria)" and the closing note of [plan 13](13-event-trees.md) section 11. Nothing here changes the event-tree document, the engine, the headless runner or any other repository.

## What was read

- SNEED: [plan 06](06-suite-integration.md) (component links, RAFT export), [plan 07](07-extensions.md) (open question on event trees and NODAL or RAFT), [plan 09](09-virtual-reactor-link.md), [plan 13](13-event-trees.md), the event-tree schema (`initiating_event` has `name`, `description`, `frequency`, `unit` only), `TODO.md` item "T-H link".
- NODAL, read-only: `docs/EVENTS.md` (draft) and `docs/runtime-protocol.md` section 4. Its engine commands in v0.1.0 are `bc.override`, `bc.release`, `trip.set` and `trip.reset`. NODAL is owned by another session; this note is a request for a conversation, not a change to it.
- A third-party survey (2026-10-07) found that another project (meltdown, no licence, ideas only) treats an initiating event as a minimal plant-state change with the physics left to respond. Only that idea is used here. No code or text was taken, and no number from it is usable as frequency data.

## The rule that decides everything

Only a **success criterion** crosses from a thermal-hydraulic run to an event tree: "in this run, with this plant model and these changes, the stated condition held or did not hold." Never a probability, never failure logic, never a frequency. This is already the rule in plan 06 and the TODO; this note makes it concrete. The tree keeps owning every number.

## Two separate things the link could carry

### A. A plant-side meaning of an initiating event (the "mutation list")

A reviewed list of changes to a plant model that stand for the initiating event, for example "pump P1 off from t = 0". It says what to run, not how likely it is.

What it needs:
1. **Identity.** Each change names a component by ID and revision (plan 06's link rules, including the stale rule: a changed or deleted target makes the list stale and needs a human review).
2. **A change NODAL can apply.** Today NODAL's commands cannot express most of what an initiator means. A pump stop is possible only if the model already has a trip that drives the pump, set with `trip.set`. A boundary pressure change is possible with `bc.override`. A controller to manual, or a lowered burst pressure, is not a command. So the first version of the list can only use what the plant model was already built to respond to. Anything else is a request to the NODAL owner, not something SNEED asks for by writing a field.
3. **Review.** A person writes and approves the list; no derivation from a coolant diagram (plan 09 rule).
4. **No frequency.** The initiating-event frequency stays on the tree.

### B. A branch success criterion

A definition, attached to one heading of a tree, of what a thermal-hydraulic run must show for that branch to count as "works": a named output quantity, a limit, a window of time, and the plant model and mutation list it applies to. Example form only: "core-inlet flow above X for the whole window."

What it needs:
1. A criterion definition that a person reviewed (quantity, comparison, limit, unit, window).
2. A record of **which run produced the answer**: the plant model hash, the engine and its build, the mutation list revision, the criterion revision.
3. A **stale rule**: if any of those change, the old answer is shown as stale and does not count until rerun (the same idea as the existing "NO CURRENT RESULT" rule for saved analyses).
4. A **refusal** when a heading has no criterion, or when the run failed, was truncated or was cut short by a trip: the answer is "not determined", never a guess.
5. A rule that a pass/fail answer is a **fact about one run**, not a branch probability. A heading's failure probability still comes from its fault tree.

## Questions for the owner (the design is blocked on these)

1. Do you want A and B together, or B alone first? B can start with a hand-entered criterion and a hand-entered result (no NODAL call), which tests the record and stale rules without any integration.
2. Which heading would be the first example? A real choice needs a NODAL model that has a pump, a trip driving it, and a meaningful output. None is chosen here.
3. Who writes the mutation list: the tree author or the plant-model author? That decides whose review it needs.
4. Does the NODAL owner agree to carry the work of any new command? This note makes no request on their behalf.

## Rules carried over from earlier decisions

- A scripted change that cannot apply is **reported and kept as a failed result**, never dropped and never silently retried in SNEED. Retrying belongs to the runner that owns the clock (NODAL or RAFT). SNEED's runner makes one attempt.
- Crossing the app boundary goes through a SEED transfer recipe with a human approval (plan 06, tier A3). SNEED does not call NODAL directly.
- Every example criterion in a lesson is labelled "(example)" and synthetic, as for end states in plan 13.
- The initiating-event category, the success limit and any plant mapping are decisions for an analyst. The tool never offers defaults, and never offers the words "core damage" as one.

## Smallest first step (when you decide)

Stage T0, no integration: a document type for a success criterion with its record (inputs, hashes, revisions) and a validator with typed errors, a stale rule tested, and a refusal tested. The result would be entered by hand. Cost: about as much as plan 13 stage S1 (a few days with tests and a mutation pass). It touches nothing in NODAL, RAFT or SEED, and shows whether the record is the right shape before anyone writes an adapter.

Not decided here: units beyond what a criterion names, time-dependent branching, recovery actions, anything about frequencies from simulation (all plan 07).

## Oracle sketch (to write before any code, as the TODO requires)

Hand cases to fix first: criterion met; criterion violated; run failed (not determined); plant model changed since (stale); mutation list changed since (stale); heading with no criterion (refused). Each states the expected record and the exact words shown.

## Stage T0 as built (2026-10-07; the owner: "B alone first, start T0")

Part B only (a branch success criterion); part A (the plant-side mutation list) is not started. Built: the two document types, a validator with typed errors, the criterion hash, the stale rule, the refusals and the judgement, all pure and with the answer entered by hand. Specified in [docs/SCHEMA.md](../SCHEMA.md); code in `src/core/th-criterion.ts`; hand oracles in `tests/th-criterion-oracles.json` (the cases listed above, plus boundaries, several reasons at once and the rule that stale outranks not-determined).

Decisions taken while building, for the owner to overrule:
1. **A criterion pins the event tree by its whole hash.** Any change of meaning in the tree (even the initiating frequency) makes the criterion stale. Safe, and sometimes more cautious than needed; a narrower pin (the heading's event and the fault-tree model) can come later.
2. **The window observed must equal the window asked.** A longer window would mix in values the criterion does not ask about.
3. **A truncated run, or one ended by a trip, is "not determined" even if the numbers it reached already satisfy or violate the condition.** Conservative on purpose.
4. **"Stale" outranks "not determined".** A stale answer is to be run again, so nothing else about it is shown as a result.
5. **The answer carries `min` and `max` over the window, not a time series.** Enough for the four comparisons and the two `holds` forms. A time series would let the tool check the numbers itself; that waits for a real NODAL result.
6. **The window includes both end points** (the value at `to` counts), and the answer's `engine` carries name, version and an immutable build: a changed engine or build makes the answer stale (found by the Codex review).
7. **Nothing is wired in.** No folder, route or screen reads these documents; the mutation list (part A) is `null` and the schema leaves room for its hash.

Not built: the folder and routes for saving criteria, any screen, the sequence-level use (how a heading's "works" or "fails" in a tree is set from an answer: the tree still holds the probability), an adapter, anything in NODAL, RAFT or SEED.

