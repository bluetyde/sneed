# Plan 02: Engine and adapter

How the app runs SCRAM, and how it exposes itself to SEED. Milestones P0 (spike), P2 (analysis), P3 (SEED adapter).

SCRAM source: https://github.com/rakhimov/scram ; documentation: https://scram-pra.org/ (listed 2026-09-30, **not verified in this session**). Existing analysis engines are prior art; this app does not replace one.

## P0 spike: what to establish before any design depends on SCRAM

Before the first numerical run, save the independently derived fixtures, expected cut sets and fixed tolerances from [plan 05](05-verification.md). Include basic-event tops, duplicate references and the shared-event cases from [plan 01](01-model-and-semantics.md).

| Question | Evidence to record |
|---|---|
| Which release or commit, and how to get a build | Version string, source, build or install steps, platform |
| License and redistribution terms | License text, what bundling the binary requires |
| Windows story | Native build, WSL, or container; path handling for spaces and `\\wsl$` |
| Input | Minimal Open-PSA XML for the tiny model; the exact accepted subset |
| Invocation | Exact argument list; options for probability method, cut-set limits, output format |
| Output | Report fields for top probability, cut sets, probability method, warnings, version |
| Failure behaviour | Exit codes and messages for malformed input, unsupported construct, limits hit |
| Determinism | Same input/settings/build twice gives the same normalized numerical results and cut-set membership; preserve both raw reports and explain metadata differences |

Output of the spike: saved inputs, the exact command, the raw report, a one-page note, and a decision record. No design relies on a SCRAM behaviour that is not in the record.

## Export and import

- **Export** the native model to Open-PSA XML in the run directory. IDs in the XML are the model's IDs (mapped to XML-safe names with a recorded, reversible mapping if the format requires it).
- **Import** a documented subset. Anything outside it blocks analysis with `E_UNSUPPORTED` naming the construct and line; the original file is stored unchanged beside the model.
- Imported XML is parsed with external entities and DTD processing disabled and treated as data. Embedded text never becomes a command.

## Run manager

- One run directory per run: `runs/<id>/{inputs/, native/, results.json, log/}`; inputs copied and hashed.
- SCRAM is started with an explicit argument list (never a shell string), a timeout and resource limits, by the process that owns it; cancel stops that process tree only.
- A run is `completed` only when the exit code is zero, the report exists, parses, passes consistency checks, and completeness is established. The lifecycle contract below governs all other outcomes.
- Treat configured cutoffs as potentially omitting cut sets even without a warning. P0 must establish how each relevant option affects completeness; zero exit and absence of warnings alone are insufficient.
- Default: one run at a time per engine; runs are small.

## Lifecycle and completeness contract

`status` is one of `queued`, `running`, `completed`, `truncated`, `failed`, `cancelled`, `interrupted`. `queued` may become `running`, `cancelled`, `failed` (snapshot/export/launch failure), or `interrupted` (owner lost); `running` becomes exactly one terminal state. Terminal states are immutable. Restart recovery marks abandoned nonterminal jobs `interrupted` after checking ownership; it never adopts a report as success automatically. Validation refusal before job creation returns typed errors without creating a job.

Keep `completeness` separate: `unknown` before validation or for unusable output, `complete` only after all completion checks, and `truncated` for a valid but demonstrably limited report. Only `status=completed` with `completeness=complete` is a successful analysis eligible for collection/indexing. An explicitly chosen approximation can be complete for that method; it must still be labelled as approximate.

| Outcome | Status / completeness |
|---|---|
| Zero exit, valid consistent report, no effective omission or unresolved completeness question | `completed` / `complete` |
| Zero exit and valid report with a proven effective cutoff or engine limit | `truncated` / `truncated` |
| Nonzero exit, malformed/missing/inconsistent report, wrapper timeout, or completeness cannot be established | `failed` / `unknown` |
| Accepted user cancellation before terminal publication | `cancelled` / `unknown` |
| Host/owner lost before terminal publication | `interrupted` / `unknown` |

Serialize cancellation and terminal publication: cancellation accepted first wins, even if the engine subsequently exits zero; cancellation after terminal publication returns the existing state. Preserve raw artifacts for every outcome. Truncated output is available for labelled diagnostic inspection only, never indexed as a complete analysis. Known cutoffs require evidence of no omission to qualify as complete; otherwise refuse complete collection. Record timeout, limit and parse reasons separately from status.

## Results record

`results.json` is a local versioned record pending SEED E0; it will be mapped to the accepted SEED results index, not treated as an already compatible schema. Required content: quantity `top_event_probability` (dimensionless), `minimal_cut_sets` (each a list of event IDs with its probability), `method`, `assumptions`, `engine` (name, version, build), `warnings`, `input_hashes` (model, saved document and exported input), analysis settings, exporter/parser versions, `status`, `completeness`. Cut-set events must exist in the model; probabilities in [0, 1].

## Adapter verbs (P3)

| Verb | PRA mapping |
|---|---|
| `describe` | App and engine versions, native and Open-PSA formats, supported gate types, parameters (event probabilities, method), output quantities, oracle coverage |
| `open` | Open or focus the editor on a model revision; starts no analysis |
| `validate` | The validation table in [plan 01](01-model-and-semantics.md), as typed errors |
| `run` | Execute a snapshot; return job ID and run location |
| `status` / `cancel` | Lifecycle with the engine's native status; cancel only that job's process tree |
| `collect` | The results record above, with hashes; refuses incomplete or truncated output as a complete result |

Typed parameters for sweeps: each basic event's probability, within [0, 1]. A sweep never edits the model by string replacement; it creates a new revision per case through the model core.

## Status of headless acceptance (2026-10-05)

Implemented in `src/core/` and proven in `tests/engine/`: validated snapshot, Open-PSA export (collapse, wrapper top, voting rewrite), explicit-argument run with timeout and cancel that kill only the owned Linux processes, report parsing that treats the report as untrusted data, and a result record whose `completed`/`complete` status requires: exit 0, parseable report, pinned engine version and binary hash, requested method echoed, cut-set events and probabilities consistent with the model, cut sets minimal, a product-order limit proven ample (at least the structural bound on cut-set order, by default the reachable event count) or omission shown from the report itself, and, for rare-event and MCUB, a value that matches what the reported cut sets imply. A limit below the bound with no visible omission is `failed` / `unknown`, not `truncated`, because `truncated` requires proof. Not yet implemented: `queued` and `interrupted` states, restart recovery, run reuse, resource limits. See [../spike/README.md](../spike/README.md) for the engine defects and behaviours found.

## Headless acceptance before the full editor

Implement schema/validation and the independent oracle first, then prove saved native model -> validated snapshot -> XML -> SCRAM -> parsed local result without a browser or SEED. Accept single-event, AND, OR and shared-event cases against the frozen oracles; exercise invalid input, failed output and truncation. This is the first part of P2 and precedes the full P1 editor.

## Tests

- Direct SCRAM run vs the app's run on the same snapshot: identical top probability and cut sets (parity).
- Engine failure modes from the spike each map to a named error and never to `completed`.
- Truncation: a case that hits a limit is marked `truncated`.
- Cancel kills the owned tree; an unrelated process survives.
- Malicious XML (entity expansion, huge input) is refused or contained.
- Standalone launch and an editor session are unaffected when the adapter is not in use.

## Open

- Exact build, packaging and Windows route (answered by P0).
- Whether to call SCRAM through its CLI only or through a library interface if one exists.
- Resource limits per run (measured after P0).
