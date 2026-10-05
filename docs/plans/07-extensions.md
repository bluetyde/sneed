# Plan 07: Extensions

What comes after the static-tree gate. Milestone P4. **Nothing here starts until P3 is verified.** Each extension needs its own written assumptions, reference cases and validation before it ships; none is a configuration option on the V1 tree.

## Order

| Step | Extension | Why this order |
|---|---|---|
| 1 | Importance measures on static trees | Same model, new outputs; hand-checkable |
| 2 | Event trees with explicit frequencies | The step from "probability" to "sequence"; needs time and rate definitions |
| 3 | Common-cause failure groups (explicit model) | Needs a stated parametric model and data source |
| 4 | Uncertainty (distributions and sampling) | Needs seeds, sampling design and honest reporting |
| 5 | Non-coherent logic (NOT gates) | Changes what cut sets mean |
| 6 | Time-dependent and repairable components | Large semantic change; may be out of scope for teaching |

## Step 1: importance measures

Birnbaum importance of an event is the change in top probability per unit change in its probability. Hand checks: A AND B with B = 0.2 gives Birnbaum(A) = 0.2; A OR B gives 1 − 0.2 = 0.8. Additional measures (for example Fussell-Vesely, risk achievement and reduction worth) are defined exactly in the plan before implementation and each gets an oracle. Which measures SCRAM provides is checked in P0; if the engine supplies them, parity with the engine is level 2 and the hand cases are level 3.

## Step 2: event trees

An event tree needs an **initiating event with a rate and a time unit**, a sequence logic, branch probabilities (often from fault trees) and an **end-state definition**. Only then does a sequence frequency exist. Before any code: write the semantics, the exact meaning of branch probability vs conditional probability, the handling of shared events across branches, and the oracle set (a two-branch tree with hand frequencies). The app never labels an output "core damage frequency" without these definitions and a stated end state; a teaching example uses a named synthetic end state such as "loss of cooling (example)".

## Step 3: common-cause failure

State the model (for example a parametric group model), what data it needs and its assumptions. An example group is explicit in the tree (a visible group object), not a hidden adjustment of probabilities. Oracles: a two-component group with the model's closed form, and a check that setting the common-cause parameter to zero reproduces the independent result.

## Step 4: uncertainty

Distributions on basic-event probabilities with an explicit sampling design, seed and count; results report the output distribution and say it is an uncertainty on the inputs, not a prediction. The same seed repeats the sample. A deterministic comparison case (constant distributions) must reproduce the point estimate exactly. Sampling noise is reported separately from the input uncertainty.

## Steps 5 and 6

Specify the semantics, reference cases and engine support before deciding whether they belong in a teaching tool.

## Rules for every extension

- Assumptions appear in the model header and in every result; a result produced under a different assumption set is labelled as a different kind of result.
- Independent reference cases exist before the feature ships; hand-derived where possible.
- The Open-PSA subset grows only with a documented subset change and new fixtures.
- Lessons that use the extension follow the lesson rules ([plan 04](04-lessons.md)).
- SEED's oracle coverage in `describe` is extended only when the entries pass.

## Open

- Whether step 6 belongs in this app at all.
- Which importance measures are worth teaching in a first course.
- Whether event trees should link to NODAL or RAFT scenarios, and under what review.
