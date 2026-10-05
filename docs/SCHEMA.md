# Native model schema, version 1 (specification)

Status: **proposed**, written 2026-10-05 from [plan 01](plans/01-model-and-semantics.md), the user's decisions of the same date (native voting gate, TypeScript stack) and the identifier probes in [spike/README.md](spike/README.md). No JSON Schema file, validator or fixture exists yet; those are TODO item 6. Hash behaviour is already frozen in `../tests/canonical/` and has two passing implementations.

## Document

A UTF-8 JSON document. `events` and `gates` are **arrays of objects with an `id`**, not maps keyed by ID: a JSON parser silently keeps the last of two equal keys, so a map could never report `E_DUP_ID`. Array order is not semantic.

| Field | Type | Required | Rule |
|---|---|---|---|
| `schema` | `{id, version}` | yes | `id` is `"sneed.fault-tree"`; `version` is an integer, 1 here |
| `model` | `{id, name, created, updated}` | yes | Metadata only. Excluded from `model_hash`. `created`/`updated` are ISO 8601 strings |
| `assumptions` | object | yes | V1 values only: `probability_model: "constant"`, `independence: "declared-independent"`, `coherence: "coherent"`, `time: "none"`. Any other value is refused in V1 (`E_SCHEMA`) |
| `top` | string | yes | ID of an existing event or gate |
| `events` | array of event | yes | At least one |
| `gates` | array of gate | yes | May be empty (a basic-event top needs no gate) |
| `layout` | object | no | Positions and visual references; excluded from `model_hash` |
| any other field | any | no | Preserved on save, never interpreted (`W_UNKNOWN_FIELD`) |

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
