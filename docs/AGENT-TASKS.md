# Agent task board

Delegation workflow: **Claude plans and verifies; Antigravity (agy, `antigravity-task` skill) implements delegated tasks in the isolated `agent-sandbox`; Codex (`codex-review` skill) reviews non-trivial diffs read-only.** Nothing merges until Claude has re-run the checks and the user agrees.

Decide whether to delegate before dispatching, and decide again for each task. The clear wins are large, mechanical tasks with a fixed contract and a strong oracle. Judgment, safety and numerics-precision tasks stay with the supervising agent.

Status: `ready` | `blocked` | `pending` | `done`. Triage written 2026-10-03; recheck before any dispatch.

## agy candidates

| # | Task | Status | Oracle | Notes |
|---|---|---|---|---|
| A1 | Native model JSON Schema, validator and fixtures (one bad fixture per error code) | done by Claude 2026-10-05, not delegated (see TODO item 6) | Every code has a failing bad fixture; targeted schema breaks are caught | Needs remaining voting decision, chosen stack and canonical serializer/hash vectors; plan 01 defines the header/top/arity/hash rules; brief must state the repeated-reference rule and that no expression is evaluated |
| A2 | Brute-force enumeration oracle (all basic-event states for trees up to ~16 events) plus random-tree property test | done by Claude 2026-10-05, not delegated (see TODO item 7) | Hand oracles in plan 05 reproduce exactly; a mutated evaluator fails | Independent of SCRAM; strong oracle; needs A1 |
| A3 | Open-PSA XML export of the native model and a reader for the documented subset | blocked | Round trip on fixtures; refusal of constructs outside the subset | Needs the P0 subset; XML hostile-input tests required in the brief |
| A4 | Results parser for the engine report | blocked | Saved real reports from P0 parse to the expected record; broken reports are refused | Needs P0 saved reports |
| A5 | Lesson checker (structure and value checks against oracle entries) | blocked | Each mistake fixture fires its check | Needs A1 and plan 04 text |

## Claude-only

| # | Task | Why |
|---|---|---|
| C1 | P0 spike: install, run, license, subset | Environment judgment, license reading, safety |
| C2 | Model and assumptions semantics (plan 01), including identity rules | Everything depends on it |
| C3 | Oracle derivations and tolerances | A wrong hand value corrupts every check |
| C4 | SEED adapter and harness fit | Cross-project contract |
| C5 | Lesson wording and teaching points | Judgment; instructor review |
| C6 | Extension semantics (event trees, importance, common-cause) | Definitions and units |
| C7 | Briefs, preflight and verification of every delegated diff | By the skill's rules |

## Execution dependencies

Freeze oracle fixtures and tolerances before C1 numerical runs. P0 exit reviews engine evidence and export mappings; schema review follows stack/schema decisions. A1 -> A2 -> headless P2 export/run/parse acceptance precedes full editor implementation. P3 suite work waits for accepted SEED E0 schemas and transport; PRA is the second real adapter after RAFT. Existing task ownership is unchanged.

## Codex review points

After P0 (spike evidence and the decision record), after the schema and validator (P1), after the run manager and results parser (P2, focus on process handling and hostile input), after the SEED adapter (P3).

## Done

Nothing yet (plan only).
