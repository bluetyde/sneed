# Plan 13: Event trees (plan 07, step 2): semantics, written before any code

**Status 2026-10-06: DECIDED (the owner took the recommendations on all seven questions of section 10, see "Decisions taken" below); S0 done, **S5 built 2026-10-07** (the three lessons and the instructor sheet: see docs/EDITOR.md; the instructor read is the owner's), **S4 built 2026-10-07** (drawing, SVG/PNG, print, Compare: see docs/EDITOR.md), **S3 built 2026-10-06** (the editor: see docs/EDITOR.md; drawing, print and Compare are S4, the lessons S5), **S2 built 2026-10-06** (engine: negation, joint evaluation over one model, sequence and end-state frequencies, partition and numeric-range checks, the labelled approximation, record, `POST /api/event-tree/run`; see docs/ENGINES.md; no UI yet), **S1 built 2026-10-06** (schema, validator, path enumeration, hash, storage and API; no engine, no UI: see docs/SCHEMA.md); S2 onward waits for the human P3 reviews or the owner's explicit go-ahead.** Plan 07 says an extension needs written assumptions, reference cases and validation before it ships; this is that document. Section 10 lists what the owner must decide. Every number in sections 6 and 7 was checked with exact fractions (Python `Fraction`) on 2026-10-06; the enumeration oracle in `tests/oracle/` will be extended to produce them again independently of the engine.

## 1. What this is, and what it is not

An **event tree** answers a different question from a fault tree. A fault tree gives the probability that one undesired event (the top event) occurs. An event tree starts from an **initiating event** that happens at some **frequency** (per year, say), follows the response of a sequence of safety functions (the **headings**), each of which works or fails, and ends in a named **end state**. The result is a **frequency of each sequence and of each end state**, not a probability.

In this app it is a teaching construct for a first course: one initiating event, a short ordered list of headings, binary branches (works / fails), and fault trees already in the app supplying the failure probability of each heading. It is **not** a licensing or plant model: no time-dependent behaviour, no operator recovery, no common-cause groups, no uncertainty ([plan 07](07-extensions.md), steps 3 to 6).

The app never labels an output "core damage frequency". Every end state is a name the author gives, with a description of the condition, and the teaching examples use named synthetic states such as "loss of cooling (example)" ([PLAN.md](../../PLAN.md), "say which number it is").

## 2. Definitions

- **Initiating event (IE).** A name, a description, and a **frequency** `lambda` with a **unit** (`per-year` first; the list of units is fixed by the app, section 10 question 1). Both are required: no frequency, or no unit, means no result (E_NO_FREQUENCY, E_NO_UNIT). The frequency is a constant.
- **Heading.** An ordered safety function. Its **failure** is an event of the fault-tree model: a **gate or a basic event** of one referenced model (section 4). Heading failure means that event occurs. Its **success** means that event does not occur. So a heading is binary and its two branches are exact complements.
- **Sequence.** A path from the IE through the headings, one branch per heading asked, in heading order. A heading **not asked** on a path (a *bypass*, section 3.4) has no branch on it.
- **End state.** A named condition: name, description, and the flag `synthetic` (true for teaching examples, shown wherever the state is shown). **Every sequence maps to exactly one end state** (E_NO_END_STATE if one does not). An end state may collect several sequences.
- **Sequence frequency** `f(s) = lambda x P(path condition of s)`, where the path condition is the AND of: for each heading asked on the path, its failure event (branch "fails") or the complement of it (branch "works"). `P` is the exact probability of that Boolean condition, computed **jointly** (section 3.2), in the units of `lambda`.
- **End-state frequency** = the sum of `f(s)` over the sequences mapped to it. All are in the same unit, so the sum is meaningful.

## 3. The semantic decisions

### 3.1 Branch probabilities are conditional, and the path condition is what counts
Textbooks write `f(s) = lambda x p1 x p2 x ...` with each `p` the branch probability *given the earlier branches*. That is correct, and it is the same thing as the joint probability of the path condition. The app defines `f(s)` by the joint probability, because only that definition stays right when headings share events.

### 3.2 Shared events: the central difficulty
Heading failure events come from **one fault-tree model**, so two headings may rest on the **same basic event** (a shared support system, a common valve). Then the headings are **not independent**, and multiplying their failure probabilities is wrong. Section 6.2 shows, with ordinary numbers, the product coming out a third too low for "both fail" (the exact value is 49% higher than the product). The definition therefore is: `P` of the path condition over the **full set of basic events of the model, once**, so a basic event that appears under several headings is one event ([plan 01](01-model-and-semantics.md): one event used twice is one failure).

A branch "works" is the **complement** of a fault-tree event. A complement is not coherent (it is a NOT), which is [plan 07](07-extensions.md) step 5's subject, so this plan states exactly how far it goes: the path condition is a Boolean function of the basic events built from AND, OR, K-of-N **and NOT applied to heading events only**. It is evaluated **exactly** (a decision diagram, as the built-in engine already does for the top event, plus a negation operation), never by cut sets. Because it is not coherent, **minimal cut sets of a sequence are not defined and are not reported** for the exact method.

### 3.3 One method in V1, and one labelled approximation as a lesson
- **Exact (the definition above).** Always computed.
- **"Success branches ignored" (optional, labelled approximation).** The traditional hand method: set every "works" factor to 1 and multiply only failure events. It is shown only on request, side by side with the exact value, as **a different kind of result** ("approximation: success branches ignored"), because the gap between the two is the teaching point (section 6.3). It is never the default and never summed into end states silently. Whether to build it in V1: question 3.

### 3.3a Partition check
For a complete tree (every sequence listed, bypasses included) the path conditions partition the space, so **the sequence probabilities sum to exactly 1** (and the frequencies to `lambda`). The engine checks this and a violation beyond rounding is a failure of the result (reason `sequences-do-not-partition`), not a warning. This is both a user-facing consistency check and the strongest test oracle.

### 3.4 Bypass (heading not asked)
A heading may be marked `asked_only_if: {heading, branch}` (it is asked only after the stated earlier heading took the stated branch; otherwise it has no branch on that path). A not-asked heading contributes **no factor** (1), and the path condition simply lacks it. Rules: the condition names an **earlier** heading only (no cycle, E_BYPASS_ORDER); several conditions are not supported in V1 (use two trees). Example in section 6.3.

### 3.5 Time and units
Heading failure probabilities are those of the fault tree: constant, **per demand** as the model states (V1 assumption `time: none`, [plan 01](01-model-and-semantics.md)). The IE frequency carries the only time unit. The result says so: "frequency per year, with heading probabilities per demand". No mission time, no repair, no change of probabilities during a sequence. A fault-tree basic event whose meaning is a rate (per hour) is **not** converted: the author must have stated probabilities (as in V1).

### 3.6 Independence of the initiating event
The IE is assumed **independent of every basic event** in the fault-tree model (a loss of a support system that both starts the transient and degrades a heading is the common-cause/dependent-IE problem, plan 07 step 3). The author cannot be checked, so the assumption is printed with every result and in the lesson text.

### 3.7 Reporting
Per sequence: path, end state, frequency, share of the IE frequency. Per end state: frequency and the sequences it collects. Total: `lambda` and the partition check. All numbers carry the assumptions block (section 5) and, when the optional approximation is shown, both values and their ratio. Numbers below the floating-point range are a failure (`numeric-range`), as for importance measures, never a printed zero ([plan 12](12-importance.md)).

## 4. The document

A new document type, **not** a change to the fault-tree model (which stays "one top event per model", plan 01):

```
schema   { id: "sneed.event-tree", version: 1 }
tree     { id, name, created, updated }
fault_tree_model { name, model_hash }     # the ONE fault-tree model the headings refer to (by saved name and semantic hash)
initiating_event { name, description, frequency, unit }
headings [ { id, name, event: <gate or basic event id in that model>, asked_only_if?: { heading, branch } } ]   # in order
end_states [ { id, name, description, synthetic } ]
sequences  [ { path: [ {heading, branch: "works"|"fails"} ... ], end_state } ]    # one per path; the app can generate the complete list
assumptions { frequency_unit, probability_basis: "per-demand", independence: "declared-independent", ie_independent_of_events: true, success_branches: "exact" }
```
- **Staleness.** The result records the `model_hash` of the fault-tree model it used. If the saved model's hash differs from the document's, the result is stale and refused as current (the same rule as results in the editor today). The document pins the hash it was last checked against.
- **Why one model.** Shared events must be *the same event*. Referring to several separate models would make two basic events with the same name unrelated, silently. Teaching models with several top-level gates are fine (a model may have gates nothing refers to: they are unattached trees, which the editor already draws).
- **Result record.** A separate record kind (`sneed.event-tree-result`), never the fault-tree result record, which SEED reads. It states its assumptions block and the same honesty fields (status, completeness, reasons), the engine identity ([ENGINES.md](../ENGINES.md)) and both hashes.

## 5. Assumptions block (printed with every result)
Static coherent fault trees, independent basic events with constant probabilities per demand, one initiating event with a constant frequency independent of every basic event, binary headings whose success is the complement of the failure event, exact joint evaluation, no recovery, no time dependence, end states as named by the author (synthetic where marked). "A frequency here is a model result under these assumptions, not a plant figure."

## 6. Reference cases (hand-derived, exact)

### 6.1 Independent headings (the textbook case)
`lambda = 0.1 / year`. Heading A "Injection" fails with probability 0.01 (a constant: a basic event). Heading B "Cooling" fails with 0.1. Four sequences:
| A | B | probability | frequency (/year) |
|---|---|---|---|
| works | works | 0.891 | 0.0891 |
| works | fails | 0.099 | 0.0099 |
| fails | works | 0.009 | 0.0009 |
| fails | fails | 0.001 | 0.0001 |
Total 0.1 = lambda. End states: works/works "Safe (example)" 0.0891; the two mixed paths "Degraded (example)" 0.0108; fails/fails "Loss of cooling (example)" 0.0001.

### 6.2 Shared event (why the joint definition)
One model with basic events S (0.1), a (0.2), b (0.3). Heading A fails if gate `X = S OR a` occurs, heading B if `Y = S OR b` occurs. `lambda = 0.5 / year`.
`P(A) = 0.28`, `P(B) = 0.37`; the joint probabilities (enumerated over S, a, b):
| A | B | probability | frequency (/year) |
|---|---|---|---|
| fails | fails | 0.154 | 0.077 |
| fails | works | 0.126 | 0.063 |
| works | fails | 0.216 | 0.108 |
| works | works | 0.504 | 0.252 |
Sum 1 and 0.5. **The naive product** `P(A) P(B) = 0.1036` would give 0.0518 for "both fail": 33% too low (the exact joint is 1.49 times the product). S makes the failures travel together. This case is the lesson.

### 6.3 Success branches ignored (the labelled approximation)
Same model. "Success ignored" for the sequence "A fails, B works" counts only the failure event of A: `lambda x P(A) = 0.14 / year` against the exact 0.063. The ratio 2.2 is what the lesson shows; the sum of the four approximate sequence frequencies is not `lambda`, and the app says so.

### 6.4 Bypass
Same model, B asked only if A works. Sequences: A works, B works: 0.504 (0.252/yr); A works, B fails: 0.216 (0.108/yr); A fails (B not asked): 0.28 (0.14/yr). Sum 1 and 0.5.

### 6.5 Further oracles to write with the code
A heading that is a basic event directly; a K-of-N gate under a heading; a model where one heading's gate is under another heading's gate (nested events); three headings with two shared events; random trees (the enumeration oracle, exact rationals, 1000 cases): every sequence frequency against enumeration and **the partition sum equals 1**.

## 7. Refusals and failures (each with its line or path, like the importer)
`E_NO_FREQUENCY`, `E_NO_UNIT` (and an unknown unit), `E_FREQUENCY_RANGE` (not finite, negative; zero is allowed and gives all zeros with a note), `E_NO_MODEL` / `E_MODEL_NOT_FOUND`, `E_STALE_MODEL` (hash differs), `E_UNKNOWN_EVENT` (a heading names something that is not an event or gate of the model; it need not be reachable from the model's top, each heading is its own root), `E_DUP_HEADING`, `E_BYPASS_ORDER`, `E_PATH_INCOMPLETE` (a sequence misses a heading that was asked on its path, or lists one that was not), `E_SEQUENCE_DUP`, `E_SEQUENCES_MISSING` (the listed sequences do not cover every path: the partition would be wrong), `E_NO_END_STATE`, `E_END_STATE_UNKNOWN`. Run failures: `too-many-events` / `too-many-nodes` / `timeout` / `too-much-memory` as for the solver, `numeric-range`, `sequences-do-not-partition`.

## 8. Engine and editor, in outline
- **Engine (built-in only; SCRAM is not asked** because the Open-PSA subset has no NOT and the importer/exporter promise nothing about it). The existing diagram code gets a **negation** operation and the joint evaluation of a path condition; the complement-side evaluation of plan 12 is reused for numerical honesty. Own limits (headings at most 12, so at most 4096 paths; events as for the solver) and the cancel/time/memory isolation of the importance worker.
- **Editor.** A new document and tab: the heading list and the sequence table as a **table first** (keyboard- and screen-reader-friendly, like the outline), with the drawing of the branching tree as the second view. End states are edited in a list. The result panel shows sequences, end states, the partition check and the assumptions. Compare and print/export reuse the existing machinery in a later stage.
- **Lessons.** (a) independent headings by hand (6.1); (b) the shared-event lesson (6.2): predict, then see the product come out a third too low; (c) bypass (6.4). Each follows the lesson rules ([plan 04](04-lessons.md)) and needs an instructor read like the existing four.

## 9. Stages
- **S0** (this document): the owner answers section 10; the oracle list is final.
- **S1** Document schema, validator with the section 7 codes, saved as files beside models; tests including hostile and random documents. No engine.
- **S2** Negation and joint path-condition evaluation, the sequence engine, the result record and the partition check; independent oracle extension (`tests/oracle`), hand cases 6.1 to 6.4, 1000 random trees; mutation checks; Codex review.
- **S3** Editor: table view, results, assumptions, stale handling; axe, keyboard and e2e tests.
- **S4** Tree drawing; print/export; Compare for event-tree results.
- **S5** The three lessons and the instructor sheet. Human reviews are the owner's.

## 10. Decisions needed from the owner
1. **Frequency units.** Start with `per-year` only (simplest, matches a course), or also `per-hour`/`per-reactor-year`? A unit is only a label; the app never converts.
2. **Heading ceiling.** 12 headings (4096 paths) in V1 enough? (A teaching tree rarely has more than 6.)
3. **The "success branches ignored" approximation** (section 3.3): build it in V1 as a labelled side-by-side, or leave it for the lesson text only? Recommendation: build it; it is cheap and it is the lesson.
4. **One initiating event per document** (V1) or several sharing the heading list? Recommendation: one.
5. **Separate document type** (section 4) or a field inside the fault-tree model JSON? Recommendation: separate, because the fault-tree model has one top event and SEED reads its record.
6. **Naming of example end states.** Keep the rule that every example end state is "(example)" and `synthetic: true`, and the tool never offers the words "core damage" as a default.
7. **Should the plan wait for the human P3 reviews** (screen-reader pass, instructor read), as plan 07 says? Recommendation: S0 and S1 may go ahead (no engine, no UI claim); S2 onward after the reviews, or with your explicit go-ahead.

## Decisions taken (2026-10-06, the owner: "go with your recommendations on all seven")
1. Units: `per-year` only (a label; never converted). 2. At most 12 headings (4096 paths). 3. The labelled "success branches ignored" approximation WILL be built (in S2). 4. One initiating event per document. 5. A separate document type (`sneed.event-tree`), saved in an `event-trees/` folder beside the models so names cannot collide with a model called `x.et`. 6. Example end states are named "(example)" and `synthetic: true`; "core damage" is never a default. 7. S0 and S1 go ahead now (no engine, no UI claim); S2 onward waits for the human screen-reader and instructor reviews, or for the owner's explicit go-ahead.

Rules settled while writing S1: a heading whose `asked_only_if` names a heading that was itself not asked on the path is not asked either; the number of sequences is at most 4096 (the validator refuses more); unknown extra fields are allowed and preserved (a warning at the top level), as for fault-tree models; the assumptions block must carry exactly the V1 values, because a different assumption set is a different kind of result.

## 11. Out of scope here, written down so it is not forgotten
The **T-H success-criterion link** ([TODO P4](../../TODO.md): a NODAL/RAFT result supplying pass/fail for a branch) needs this plan's semantics first and the SEED contracts; its own plan comes after S2. Dependent initiating events, recovery actions, multi-state headings, time-dependent branching and uncertainty on frequencies are plan 07 steps 3 to 6.
