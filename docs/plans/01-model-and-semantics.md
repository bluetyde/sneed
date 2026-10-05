# Plan 01: Model and semantics

What a fault tree means in this app, what the native document holds, and what V1 refuses. Milestones P0 (contracts), P1 (editor). Architecture overview: [../ARCHITECTURE.md](../ARCHITECTURE.md).

## V1 scope

| In V1 | Not in V1 (see [plan 07](07-extensions.md)) |
|---|---|
| Static, coherent fault trees (AND, OR) | NOT gates and non-coherent logic |
| Repeated basic events by identity | Common-cause failure groups |
| Constant probabilities in [0, 1] | Time-dependent probabilities, repairs, mission time |
| Declared independence of distinct basic events | Dependent events, uncertainty distributions |
| One top event per model | Event trees, sequences, frequencies, end states |
| Open-PSA import/export of a documented subset | Full Open-PSA |

**Decided 2026-10-05 (user): the K-of-N (voting) gate is native in V1**, with integer `threshold` k on a gate of type `atleast`. It exports to Open-PSA `<atleast min="k">`; the spike showed 2-of-3 gives 0.028 and the same three cut sets as the AND/OR expansion. Valid range is 2 <= k < N inputs (SCRAM refuses k=1, k=N and k>N; k=1 is an OR and k=N an AND, so the editor offers those gates instead). Duplicate inputs on a voting gate are refused, not normalized (SCRAM refuses them and a repeated reference has no obvious meaning there). Gate and result tests include the AND/OR expansion as a cross-check.

## Identity rules

- **Event identity is an ID**, stable and never reused, matching the pattern in [../SCHEMA.md](../SCHEMA.md). Names are display text and may repeat.
- **A visual node is a reference.** The same event drawn twice is two references to one ID. Two events that happen to share a probability are two events.
- Independence is a declared property of distinct basic events, stated in the model header. It is never inferred from drawing position, grouping or similar probabilities.
- A gate's inputs are ordered references to events or gates. Duplicate inputs on one gate (A AND A) are legal and mean the same event: the result is A, not A squared.

## Top event, arity and export normalization

The top event references either a basic event or a gate. A single-event model is valid without a synthetic gate in the native document. AND/OR gates require at least two input references, counted before deduplication: `[A, A]` is legal, `[A]` is not. Event and gate IDs share one namespace. Validate all stored gates, including unreachable ones.

The export bridge may deduplicate identical AND/OR input references and replace a resulting singleton gate with its child in the exported representation only. It must retain the native document and record the mapping back to native IDs. It must never create independent copies of a repeated event. P0 evidence ([../spike/README.md](../spike/README.md), 2026-10-05): SCRAM 0.16.2 accepts a basic event written directly as the gate formula (pra-pump1, and pra-aa/pra-oa after deduplication) with the expected result, and it refuses duplicate arguments on one gate (`DuplicateArgumentError`), so deduplication in the exporter is required. A one-input `and`/`or` gate was not tried; the exporter replaces singletons with the child, which was. Voting semantics remain a separate decision; these normalization rules apply only to AND/OR.

## Validation (before any run)

| Check | Result |
|---|---|
| Cycle in gate references | error `E_CYCLE` naming the path |
| Reference to a missing ID | error `E_MISSING_REF` with the referring gate |
| Probability outside [0, 1] or not a number | error `E_PROB_RANGE` with the event |
| Top event absent, or not a reference to an existing basic event or gate | error `E_NO_TOP` |
| AND/OR gate with fewer than two input references before deduplication | error `E_GATE_ARITY` |
| Voting gate with threshold outside 2 <= k < N, or non-integer threshold | error `E_VOTE_RANGE` |
| Voting gate with a duplicate input reference | error `E_VOTE_DUP` |
| Duplicate ID | error `E_DUP_ID` |
| Unsupported imported construct | error `E_UNSUPPORTED` naming the construct; original input preserved; analysis blocked |
| Basic event unreachable from the top | warning `W_UNREACHABLE` (kept, not analysed) |
| Unknown field | preserved, warning `W_UNKNOWN_FIELD` |

Error codes are stable and each has a bad fixture. Messages show IDs, not only names.

## What results mean

- **Top-event probability** is the probability that the top event occurs, under the model's stated assumptions. It is not a frequency and not a core damage frequency.
- **Minimal cut sets** are the smallest sets of basic events whose joint occurrence causes the top event. Order is the set's size.
- A cut set's own probability is the product of its events' probabilities under independence.
- **Method:** the exact value and the rare-event and min-cut-upper-bound approximations can differ. A result always names its method. The app teaches the difference with the 2-of-3 case (exact 0.028, rare-event 0.03, min-cut upper bound 0.029701 at p = 0.1). The set of methods SCRAM exposes is confirmed in P0.

## Assumptions block

Every model carries it and every result repeats it: probability model `constant`; independence `declared-independent`; coherence `coherent`; time `none`. A result produced under a different assumption set (later extensions) is a different kind of result and is labelled so.

## Document rules

- JSON with schema ID and version; layout in a separate block so a layout change does not change the model hash.
- Unknown fields are preserved on save. No expression is ever evaluated.
- A schema change needs a migration and fixtures for every old version.
- Component links (from NODAL) carry component ID and revision and a review status; a deleted or changed target marks the link stale and requires review. A link never supplies a probability or failure mode.

## Model identity and provenance

Use two distinct hashes:

- `model_hash`: SHA-256 of a canonical semantic projection: schema ID/version, the complete assumptions block, top reference, all basic-event IDs/probabilities, and all gate IDs/types/input references (plus voting threshold only if adopted). Include unreachable definitions so edits to stored logic still change the model revision. Sort definitions by ID and AND/OR inputs by ID, retaining duplicates. This is structural identity, not Boolean-equivalence detection.
- `document_hash`: SHA-256 of the exact saved UTF-8 document bytes copied into a run. This records layout, names, timestamps, notes, sources, component links and unknown fields as well as semantics. It can change without changing `model_hash`.

Canonical encoding is compact UTF-8 JSON with recursively sorted object keys and no Unicode normalization; IDs are case-sensitive. Numeric encoding must be identical across runtimes (`0.1` and `1e-1` match; negative zero becomes zero; non-finite numbers are refused). Before schema implementation, select and pin a canonical serializer and freeze cross-runtime byte/hash vectors; ordinary runtime JSON serialization alone is not an interoperability contract.

**Pinned (proposed 2026-10-05, stack-independent):** RFC 8785 (JCS) restricted to objects, arrays, strings, booleans and finite numbers, with IDs limited to `^[A-Za-z_]([A-Za-z0-9_-]{0,62}[A-Za-z0-9_])?$` (ASCII, so code-point and UTF-16 key order agree, and every ID is a name SCRAM accepts; see [../SCHEMA.md](../SCHEMA.md)). Numbers use ECMAScript `Number::toString` (so `1e-7` and `0.000001` print as in the RFC). The projection is in `tests/canonical/canon.py`; frozen vectors are `tests/canonical/vectors.json` (17 number, 14 model, 15 ID and 3 duplicate-ID refusal cases; number outputs hand-written from the RFC). Two independent implementations, Python (`test_canonical.py`) and Node (`check_vectors.cjs`), reproduce every vector. Still open: the final stack may add a third implementation, which must reproduce the same file.

Names, timestamps, layout, model display identity, sources/notes, component-link review state and unknown fields are excluded from `model_hash`. Unknown fields are preserved but never affect calculation; a future semantic field requires a schema-version change. Metadata edits retain numerical validity but update document provenance; stale component links separately block suite transfer until reviewed. Always display the original run snapshot's labels and provenance, not silently substituted current labels.

A run also records explicit analysis settings (method and all limits), engine build identity and exporter/parser versions. Reuse requires these to match as well as `model_hash`; document changes must not be presented as the same saved snapshot. Layout-only saves may change `document_hash`, never the model revision.

## Tests

- Good and bad fixtures for every code above.
- A basic-event top is valid; missing top fails. AND/OR arities zero and one fail; `[A, A]` passes and exports without changing identity. A AND A and A OR A each give probability 0.1.
- Undo/redo, save and reload reproduce the same model hash.
- Layout/name/timestamp/unknown-field edits: model hash unchanged, saved document hash changed. Probability, assumptions, top, gate type or reference changes: model hash changed. Input reordering and equivalent numeric spellings: same canonical hash. Engine/settings changes invalidate reuse. Freeze canonical byte/hash vectors before implementation.
- An imported model with an unsupported construct is refused and the file is preserved byte for byte.

## Open

- Open-PSA subset boundary (confirmed after the P0 spike).
- Whether to show a visual "repeated event" marker as a transfer symbol (as in common fault-tree notation) or a dashed outline.
