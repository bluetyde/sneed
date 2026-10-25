# Native model schema, version 1 (specification)

Status: **proposed**, written 2026-10-05 from [plan 01](plans/01-model-and-semantics.md), the user's decisions of the same date (native voting gate, TypeScript stack) and the identifier probes in [spike/README.md](spike/README.md). No JSON Schema file, validator or fixture exists yet; those are TODO item 6. Hash behaviour is already frozen in `../tests/canonical/` and has two passing implementations.

## Document

A UTF-8 JSON document. `events` and `gates` are **arrays of objects with an `id`**, not maps keyed by ID: a JSON parser silently keeps the last of two equal keys, so a map could never report `E_DUP_ID`. Array order is not semantic.

| Field | Type | Required | Rule |
|---|---|---|---|
| `schema` | `{id, version}` | yes | `id` is `"sneed.fault-tree"`; `version` is an integer, 1 here |
| `model` | `{id, name, created, updated}` | yes | Metadata only. Excluded from `model_hash`. `created`/`updated` are ISO 8601 strings |
| `assumptions` | object | yes | `probability_model: "constant"`, `independence: "declared-independent"` or, for a model with common-cause groups, `"beta-factor-groups"` (`E_CCF_ASSUMPTION` when the value and the groups disagree), `coherence: "coherent"`, `time: "none"`. Any other value is refused (`E_SCHEMA`) |
| `top` | string | yes | ID of an existing event or gate |
| `events` | array of event | yes | At least one |
| `gates` | array of gate | yes | May be empty (a basic-event top needs no gate) |
| `common_cause_groups` | array of group | no | Beta-factor groups ([plan 15](plans/15-common-cause.md)). Part of `model_hash` only when the list is not empty, so a model without groups keeps its hash |
| `layout` | object | no | Positions and visual references; excluded from `model_hash` |
| any other field | any | no | Preserved on save, never interpreted (`W_UNKNOWN_FIELD`) |

### Common-cause group (plan 15, stage C1, 2026-10-25)

| Field | Type | Required | Rule |
|---|---|---|---|
| `id` | string | yes | Identifier pattern. Not the id of an event, a gate or another group (`E_DUP_ID`) |
| `name` | string | no | Display text, 1 to 200 characters. Excluded from `model_hash` |
| `method` | string | yes | `"beta-factor"` only (`E_SCHEMA` for any other value) |
| `members` | array of string | yes | 2 to 8 basic events (`E_CCF_TOO_SMALL`, `E_CCF_TOO_LARGE`). Each exists and is an event (`E_CCF_UNKNOWN_MEMBER`), in one group only and once (`E_CCF_OVERLAP`), with one probability for all members (`E_CCF_UNEQUAL_Q`). Order is not semantic |
| `beta` | number | yes | In [0, 1]. A string, a boolean or a number outside the range is `E_CCF_BETA_RANGE`. A missing `beta` is `E_SCHEMA` |

`model_hash` adds `common_cause_groups`, an object keyed by group id of `{method, members (sorted), beta}`. The group `name` and unknown fields are left out. **Analysis (stages C2 and C3, 2026-10-25):** the built-in fault-tree analysis and the SCRAM path (through the Open-PSA export, which writes the expansion: [OPEN-PSA-SUBSET.md](OPEN-PSA-SUBSET.md), rule 8) handle groups. Each expands every group (see [plan 15](plans/15-common-cause.md), section 4), and the result record carries `common_cause {method, groups, note}`. Event trees and importance measures refuse a model with groups with `E_CCF_NOT_ANALYSED` and compute nothing, so a group is never silently ignored.

### Event

| Field | Type | Required | Rule |
|---|---|---|---|
| `id` | string | yes | Matches the identifier pattern below |
| `name` | string | no | Display text, 1 to 200 characters, may repeat |
| `probability` | number | yes | JSON number in [0, 1]. Strings, booleans and null are `E_PROB_RANGE`. Probabilities of 0 and 1 are allowed |
| `source` | object | no | `{kind, citation?}`; `kind` is `synthetic`, `sourced` or `assumed`; `sourced` requires a non-empty `citation` |
| `note` | string | no | Up to 2000 characters |
| `link` | object | no | `{app, component_id, revision, review}`; `review` is `reviewed` or `needs-review`. Identity only; never supplies a probability or failure mode |

### Gate

| Field | Type | Required | Rule |
|---|---|---|---|
| `id` | string | yes | Same pattern; one namespace shared with events |
| `name` | string | no | As for events |
| `type` | string | yes | `and`, `or` or `atleast` |
| `inputs` | array of string | yes | Ordered references to event or gate IDs. `and`/`or`: at least 2 entries counted before deduplication, duplicates legal. `atleast`: duplicates refused |
| `threshold` | integer | `atleast` only | 2 <= k < number of inputs; forbidden on `and`/`or` |

### Layout

`layout.nodes`: array of `{id, x, y}` positions for events and gates. `layout.references`: array of `{node, target, x, y}`, one per extra visual node that repeats the event or gate `target`. A layout entry pointing at a missing ID is `W_LAYOUT_STALE`, never an error: layout cannot change a result.

## Identifier pattern

`^[A-Za-z_]([A-Za-z0-9_-]{0,62}[A-Za-z0-9_])?$`, so 1 to 64 ASCII characters. Case-sensitive: `A` and `a` are two IDs (SCRAM treats them as two). This is the **intersection with what SCRAM accepted**, found by probing 2026-10-05: a leading digit, a leading or trailing dash, a dot and a space were all refused by SCRAM; underscore, an inner dash and a 201-character name were accepted. A native ID is therefore always a valid Open-PSA name, and export needs no renaming. The earlier plan 01 text allowing dots and leading digits was wrong and is replaced.

## Errors and warnings

Each code gets one failing fixture (item 6). "Level" says where it is raised.

| Code | Level | Raised when |
|---|---|---|
| `E_SCHEMA` | schema | Missing required field, wrong JSON type, bad enum value, unsupported schema version, unsupported assumption value, `threshold` on a non-voting gate |
| `E_ID_FORMAT` | schema | An event or gate `id` fails the pattern |
| `E_DUP_ID` | validator | Two events, two gates, or an event and a gate share an ID (checked before hashing) |
| `E_PROB_RANGE` | schema | Probability outside [0, 1] or not a JSON number |
| `E_NO_TOP` | validator | `top` missing or not an existing event or gate ID |
| `E_MISSING_REF` | validator | A gate input names an ID that does not exist |
| `E_CYCLE` | validator | Gate references form a cycle; the message names the path |
| `E_GATE_ARITY` | validator | `and`/`or` with fewer than two input references before deduplication |
| `E_VOTE_RANGE` | validator | `atleast` threshold missing, non-integer, below 2, or not below the input count |
| `E_VOTE_DUP` | validator | `atleast` gate with a duplicate input |
| `E_CCF_ASSUMPTION` | validator | Groups present and `independence` is not `beta-factor-groups`, or the reverse |
| `E_CCF_UNKNOWN_MEMBER` | validator | A group member is not an event of the model (a gate, or no id) |
| `E_CCF_OVERLAP` | validator | An event is in two groups, or twice in one |
| `E_CCF_TOO_SMALL` / `E_CCF_TOO_LARGE` | validator | A group has fewer than 2 or more than 8 members |
| `E_CCF_BETA_RANGE` | schema | `beta` is not a number in [0, 1] |
| `E_CCF_UNEQUAL_Q` | validator | The members of one group have different probabilities |
| `E_CCF_NOT_ANALYSED` | analysis | The model has groups and this analysis does not handle them yet (event trees, importance measures); no result is made. The fault-tree analyses (built-in and SCRAM) handle groups |
| `E_UNSUPPORTED` | import | An imported construct outside the subset in [OPEN-PSA-SUBSET.md](OPEN-PSA-SUBSET.md); names the construct and line; original file kept byte for byte |
| `E_EXPORT_LIMIT` | analysis | A voting gate would expand to more than 2000 terms when written for the engine; refused before any run, no run directory is created ([OPEN-PSA-SUBSET.md](OPEN-PSA-SUBSET.md)) |
| `W_UNREACHABLE` | validator | A gate or event not reachable from the top; kept, not analysed |
| `W_UNKNOWN_FIELD` | schema | Unknown field; preserved |
| `W_LAYOUT_STALE` | validator | A layout entry points at a missing ID |

Validate every stored gate, reachable or not. Messages show IDs, not only names. All checks run before any export or run. `E_SCHEMA`, `E_ID_FORMAT` and `E_PROB_RANGE` are expressible in JSON Schema; the rest need validator code, and the validator must report every error it finds, not stop at the first.

## What is not decided

- Size limits (events, gates, input length). SCRAM's practical limits were not measured.
- Whether `model.created`/`updated` are checked against each other.
- The exact JSON Schema draft; item 6 chooses one the Node validator supports.

## Event tree document (plan 13, stage S1, 2026-10-06)
`schema/event-tree.schema.json` (structure) and `src/core/event-tree.ts` (rules) define `sneed.event-tree` version 1: `tree`, `fault_tree_model {name, model_hash}`, `initiating_event {name, description, frequency, unit: "per-year"}`, `headings [{id, name, event, asked_only_if?}]` (at most 12, in order), `end_states [{id, name, description, synthetic}]`, `sequences [{path: [{heading, branch}], end_state}]` (at most 4096) and an `assumptions` block that must carry exactly the V1 values. Saved in `<project>/event-trees/<name>.json`, beside and never mixed with the fault-tree models. Codes: `E_SCHEMA`, `E_NO_FREQUENCY`, `E_NO_UNIT`, `E_FREQUENCY_RANGE`, `E_NO_MODEL`, `E_MODEL_NOT_FOUND`, `E_STALE_MODEL`, `E_UNKNOWN_EVENT`, `E_ID_FORMAT`, `E_DUP_HEADING`, `E_DUP_ID`, `E_TOO_MANY_HEADINGS`, `E_BYPASS_ORDER`, `E_PATH_INCOMPLETE`, `E_SEQUENCE_DUP`, `E_SEQUENCES_MISSING`, `E_NO_END_STATE`, `E_END_STATE_UNKNOWN`; warnings `W_UNUSED_END_STATE`, `W_ZERO_FREQUENCY`, `W_UNKNOWN_FIELD`. The path rules (a complete, once-each list; a heading whose condition names a heading not asked is not asked) are in the plan. A document with a bad structure gets its structural errors only; the rules run on a structurally sound one. `eventTreeHash` hashes what the document means (model reference, frequency, headings in order, which path ends where, assumptions), not names, descriptions, times or the order of the sequence list, and reads only the fields this version knows.
API: `GET /api/event-trees`, `GET|PUT /api/event-trees/:name` (text kept exactly, work in progress allowed), `POST /api/event-tree/validate` (checks the saved fault-tree model: not found, stale, unknown event). Analysis is stage S2 (below) and the editor is stage S3 (docs/EDITOR.md).

## Event tree result record (plan 13, stage S2)
`sneed.event-tree-result` version 1: `status` (`completed` | `failed` | `cancelled`), `completeness`, `reasons`, `quantity: sequence_frequency`, `unit: per-year`, `method: exact-joint`, the document's `assumptions`, `engine` (name, version, source-hash build), `input_hashes` (`tree_hash`, `model_hash`, `document_hash`), `initiating_event`, `headings`, `sequences` (key, path, end state, `probability`, `frequency`, `share`, and when asked `approximation {probability, frequency, ratio_to_exact}`), `end_states` (frequency, probability, the sequences), `total` (`frequency`, `probability_sum`, `partition_error`), `approximation` (method, note, `frequency_sum`) or null, `warnings`, `caveats`. A failed or cancelled record has no sequences and a reason; nothing partial is ever an answer. It is a different kind of record from the fault-tree result record, which is unchanged.


## Thermal-hydraulic criterion and answer (plan 14, stage T0, 2026-10-07)
`schema/th-criterion.schema.json` and `schema/th-answer.schema.json` (structure), `src/core/th-criterion.ts` (rules). Nothing reads or writes them in the app yet: this stage is the record and the rules, tested, with the answer entered by hand.

- **`sneed.th-criterion` v1** is about one heading of one event tree: `applies_to {event_tree {name, tree_hash}, heading}`, `plant {model_name, model_hash, mutation_list_hash}` (the hash is `null` when no list of plant changes is used, which is the only case of this stage), and `condition {quantity, comparison (above | at-least | below | at-most), limit, unit, window {from, to, unit: "s"}, holds (throughout | at-some-time)}`. The window includes both end points, so a value at `to` counts. `criterion.synthetic` marks an example. Errors: `E_SCHEMA`, `E_WINDOW_ORDER`, and, when the saved event tree is given, `E_NO_TREE`, `E_STALE_TREE` (its hash differs), `E_UNKNOWN_HEADING`. A number that JSON text writes as infinity (`1e999`) is refused as `E_SCHEMA`.
- **`sneed.th-answer` v1** says what one run showed: `criterion_hash`, `plant {model_hash, mutation_list_hash}`, `engine {name, version, build}` (the build is the immutable identity, so a rebuilt solver of the same version is a different engine), `run.status` (completed | failed | truncated | terminated-by-trip), and `observed {quantity, unit, window, min, max}` or `null`. `entered_by` is `"hand"` in this stage. Errors: `E_SCHEMA`, `E_NO_OBSERVED` (a completed run must say what it saw), `E_OBSERVED_ORDER` (min above max), `E_WINDOW_ORDER`. Whether the condition holds is never typed: `judge()` works it out.
- **`criterionHash`** is SHA-256 of the canonical text of what the criterion means (tree and heading, plant and changes, the condition). The name, description, example label and time stamps are not part of it.
- **`judge(criterion, answer, current)`** gives `held`, `did-not-hold`, `stale` or `not-determined`, with reasons and fixed words that always say it is a fact about one run and not a probability. Order: an invalid input is not determined; a stale answer (the tree, the plant, the change list, the criterion or the engine and build changed since, or the answer was made from other than the criterion names) is not read; a run that failed, was truncated or was ended by a trip, or observed another quantity, unit or window than asked, is not guessed at (so is a criterion whose heading the tree no longer has: the caller passes the headings of the tree as it is now); only then is the condition tested (`throughout` uses the worst value in the direction of the limit, `at-some-time` the best; `above` and `below` refuse equality, `at-least` and `at-most` accept it).
- **`criterionForHeading(criteria, treeName, headingId)`** returns the one criterion for a heading, or `E_TH_NO_CRITERION`, or `E_TH_AMBIGUOUS` when two exist; documents that are not valid are not counted and the refusal says how many.
- Hand oracles: `tests/th-criterion-oracles.json`; tests: `tests/unit/th-criterion.test.ts`; mutants: `python tests/mutation/verifier_mutations.py thlink`.

## Plant-model mutation record (plan 14, stage T1, 2026-10-07)
`schema/th-mutation.schema.json` and `src/core/th-mutation.ts` define `sneed.th-mutation` version 1: a reviewed statement that a second plant model is the first one with the listed edits. SNEED applies and runs nothing and reads no plant model: it checks the record and the hashes. Nothing in the app reads or writes the record yet.

- Fields: `base_model {name, hash}`, `mutated_model {name, hash}`, `edits` (1 to 50 of `{component, field, from, to}`, each value a number, text up to 200 characters or true/false), `applies` (`from-start` only: no steady state before the event, no coast-down), and the usual `mutation {id, name, description, synthetic, created, updated}`.
- Errors: `E_SCHEMA`, `E_EDIT_NOOP` (an edit sets a value to what it already is; `0` and `-0` are the same, `0` and `"0"` are not), `E_EDIT_DUP` (the same field of the same component twice), `E_MODELS_IDENTICAL`, `E_SAME_MODEL_NAME`; and, when the saved plant models are given, `E_MODEL_NOT_FOUND`, `E_STALE_BASE`, `E_STALE_MUTATED`. Whether the edits really make the second model from the first is a human review: the tool does not read the models.
- `mutationHash` covers the two models, the edits (in any order) and when they apply; not the name, description, example label or time stamps.
- A criterion uses it through its existing fields: `plant.model_hash` and `plant.model_name` are the **mutated** model, `plant.mutation_list_hash` is `mutationHash`. `checkCriterionMutation` returns `E_LINK_INVALID`, `E_LINK_HASH` or `E_LINK_MODEL` when they do not belong together.
- `currentMutationHash(record, models)` is what to pass to `judge()` as `mutationListHash`: the record's hash while it is valid and both models are as recorded, otherwise the constant `MUTATION_NOT_CURRENT`, which equals no hash, so a criterion or answer that relied on the record is `stale` ("mutations-changed"). An edited record has another hash and has the same effect.
- **`judgeWithMutation(criterion, answer, current, record, models)`** is the entry to use whenever a criterion names a record or one is supplied (plain `judge()` cannot tell that a criterion pins a record of the mutated plant but runs the base plant, and would say `held`). It works out the record's current hash, returns stale answers as stale, and otherwise refuses (`not-determined`, reason `mutation-link-invalid`) a criterion and record that do not belong together.
- Tests `tests/unit/th-mutation.test.ts`; mutants `python tests/mutation/verifier_mutations.py thmutation`.

## Success-criterion folder and routes (plan 14, 2026-10-07)
Criteria (`sneed.th-criterion`) are saved as text, exactly as written, in a `th-criteria/` folder beside the models and the `event-trees/` folder, so a criterion, an event tree and a model can share a name without touching each other. Names follow the model-name rule. Unfinished work in progress is saved as it is (valid JSON is required, as for models).

- `GET /api/th-criteria` lists them; `GET /api/th-criteria/:name` returns `{name, text}` (404 "no saved success criterion called ..." when absent); `PUT /api/th-criteria/:name` saves the text. Writes need the `X-SNEED-Request` header.
- `POST /api/th-criterion/validate {text}` returns `{valid, errors, treeChecked: true, criterion_hash, document_hash}`. The criterion is checked against the saved event tree it names: `E_NO_TREE` (none, one that is not a valid tree, or a name that is not a name), `E_STALE_TREE` (the tree's meaning hash differs), `E_UNKNOWN_HEADING`. `criterion_hash` is the hash of what the criterion means, and is `null` unless it is valid. The event tree's own fault-tree model is not looked at here.
- Not built: routes for answers and mutation records, any screen, a judgement route.
- Tests `tests/unit/server-th-criteria.test.ts`; mutants `python tests/mutation/verifier_mutations.py throutes`.

## Answer-record folder and routes (plan 14, 2026-10-08)
Answers (`sneed.th-answer`) are saved as text, exactly as written, in a `th-answers/` folder beside `th-criteria/`; same name rules, size limit, write header and link refusal as the other folders.

- `GET /api/th-answers`; `GET /api/th-answers/:name` (404 "no saved answer called ..."); `PUT /api/th-answers/:name`.
- `POST /api/th-answer/validate {text}` returns `{valid, errors, criterion, criteria_searched, criteria_not_valid, criteria_unreadable, criteria_search_complete, document_hash}`. The record is checked alone (`E_SCHEMA`, `E_NO_OBSERVED`, `E_OBSERVED_ORDER`, `E_WINDOW_ORDER`). When it is valid the saved criteria are searched, newest first and at most 200, for one that is itself valid and whose `criterionHash` equals the answer's `criterion_hash`: `criterion` is `{name}` of the newest match or `null`. `null` with `criteria_search_complete: true` means no saved criterion has that meaning (it was edited, or never saved); with `false` the search could not cover everything: more than 200 criteria, more than 32 MiB to read, or a criterion that could not be read (`criteria_unreadable`, for example over 2 MiB); then "none found" is not a claim that none exists, and a match that is named may not be the newest. A criterion that is not valid is counted in `criteria_not_valid` and skipped; that is not a gap.
- Not built: mutation-record routes, a judgement route, any screen. A criterion that is found is not judged here.
- Tests `tests/unit/server-th-answers.test.ts`; mutants `python tests/mutation/verifier_mutations.py thanswers`.

## Mutation-record folder and routes, and the judgement route (plan 14, 2026-10-08)
**Records** (`sneed.th-mutation`) are saved as written in a `th-mutations/` folder; same name rules, size limit, write header and link refusal as the other folders. `GET /api/th-mutations`, `GET|PUT /api/th-mutations/:name` (404 "no saved mutation record called ..."). `POST /api/th-mutation/validate {text, plant_models?}` returns `{valid, errors, modelsChecked, mutation_hash, document_hash}`. SNEED holds no plant models: `plant_models` is an object of model name to the 64-digit hash that model has NOW, given by the caller (at most 50). Without it only the record itself is checked; with it a missing model, a changed base (`E_STALE_BASE`) or a changed mutated model (`E_STALE_MUTATED`) are also reported.

**Judgement**: `POST /api/th-judge` with
`{criterion, answer, mutation?, plant_models, engine: {name, version, build}}`, where the first three are names of saved documents. It reads the saved files, takes the event tree from the criterion's tree name (its hash and headings as saved now) and judges with `judgeWithMutation`. It writes and runs nothing, and the reply is `{status, reasons, text, judged_with}`:
- `status` is `held`, `did-not-hold`, `stale` or `not-determined`; `text` always says it is a fact about one run, not a probability; `judged_with` echoes the saved names, the tree and its hash, the plant model hashes used and the engine, so the answer says what it was judged with.
- **What the caller states is taken as stated**: SNEED cannot see the plant models or the engine. `plant_models` must give the current hash of every plant model the judgement depends on (the model the criterion runs, and both models of the record when one is given), else 400 `E_PLANT_UNKNOWN`: an unknown hash is never read as unchanged. The engine needs a name, version and build.
- A tree that is gone or no longer a valid tree reads as changed (stale, `tree-changed`). A saved document that is not valid gives `not-determined` with `criterion-invalid`, `answer-invalid`.
- A record that is named but is not a valid record (a saved `null`, text that is not JSON, work in progress) is never dropped: the judgement is `not-determined` with `mutation-record-invalid`.
- A criterion that pins a record but is judged without it, or with another, is stale; one that pins a record but runs the base plant is `not-determined` (`mutation-link-invalid`).
- Tests `tests/unit/server-th-judge.test.ts`; mutants `python tests/mutation/verifier_mutations.py thjudge`.
- Not built: any screen; the check that a record's edits really produce its mutated model.
