# Architecture

How PRA & Reliability Studio's parts fit together. It was written before the code and has been kept current only in part: [EDITOR.md](EDITOR.md), [ENGINES.md](ENGINES.md), [HEADLESS.md](HEADLESS.md) and [SCHEMA.md](SCHEMA.md) describe what is built. Goal and principles: [../PLAN.md](../PLAN.md). Per-area plans: [plans/](plans/).

## The big picture

```
 Browser editor                         SEED (optional client)
  canvas, properties, problems,          describe / open / validate / run /
  results, explain, compare, lessons     status / cancel / collect
         |                                         |
         +-------------------+---------------------+
                             |
                    Local server (model core)
                     model store, schema validation, structural checks,
                     Open-PSA import/export, run manager, results parser,
                     lesson checks
                             |
              isolated run directory per run
                             |
                     SCRAM (pinned build, subprocess)
```

1. **The model core owns meaning; SCRAM owns arithmetic.** The core decides what a valid tree is and what to refuse. SCRAM computes cut sets and probabilities from a valid, exported model.
2. **The editor and SEED use the same core.** A rule enforced for SEED (refusal, run isolation) is enforced for the editor too.

## Components

| Component | Responsibility | Status |
|---|---|---|
| Model core | Native document, schema, ID rules, repeated-reference rules, structural validation | planned (P1) |
| Open-PSA bridge | Export native model to Open-PSA XML; import a documented subset; report unsupported constructs and keep the original | planned (P0 spike, P1) |
| Run manager | Isolated run directory, subprocess control, owned process tree, timeouts, cancel | planned (P2) |
| Results parser | Cut sets, probabilities, warnings, engine version; incomplete output refused | planned (P2) |
| Editor | Canvas and panels over the core | planned (P1) |
| Lesson engine | Step content and automatic checks against oracle values | planned (P3) |
| SEED adapter | Seven verbs over the core | planned (P3) |
| Oracle set | Entries in the SEED oracle format, run by the core's tests | planned (P0 draft, P2) |

## The native model

A JSON document with a schema ID and version.

- **Header:** model ID, name, schema version, created/updated, assumptions block (probability model: `constant`; independence: `declared-independent`; coherence: `coherent`; analysis time: none in V1).
- **Basic events:** `id` (stable), `name`, `probability` (number in [0, 1]), `source` (synthetic, sourced with citation, or assumed), `note`, optional `link` (a component reference, see below).
- **Gates:** `id`, `type` (`and`, `or`; `atleast k of n` if adopted), ordered inputs referencing gate or event IDs.
- **Top event:** a basic-event or gate ID. AND/OR gates require two input references before deduplication; see [plan 01](plans/01-model-and-semantics.md).
- **Layout:** node positions, visual references (a visual node that repeats an existing event or gate); kept in a separate block so layout changes do not change the model hash.
- **Links (optional):** component ID and revision from another app (NODAL), with a review status. A link carries identity only.

Rules:
- A repeated visual node is a *reference* to one event ID. Two events with equal probabilities are not the same event; two references to one event are.
- Gate inputs are IDs, not names. A reference to a missing ID is an error; a cycle is an error.
- Probabilities are numbers in [0, 1]. No expression is stored or evaluated.
- Unknown fields are preserved on save and not interpreted.

Model identity, saved-document identity and run reuse are defined in [plan 01](plans/01-model-and-semantics.md#model-identity-and-provenance). A semantic edit invalidates numerical results; metadata edits retain numerical validity but update provenance and any link-review requirement.

## Interfaces

### 1. Model to engine (core to SCRAM)

The core exports Open-PSA XML plus an invocation (explicit argument list, probability method, limits) into the run directory. It records the exact files and command, engine version and hash of each input. See [plan 02](plans/02-engine-and-adapter.md).

### 2. Engine to results (SCRAM to core)

The core parses the engine's report: top-event probability, minimal cut sets (each a set of event IDs with its own probability), the probability method used, engine warnings, and the engine's own version string. A report that is missing, partial or from a non-zero exit is not parsed as a result.

### 3. Adapter verbs (SEED to core)

Defined by the SEED harness plan; PRA's mapping is in [plan 06](plans/06-suite-integration.md). Errors are typed `{code, field, message, unit?, range?, source}`; text derived from model content is escaped and labelled.

### 4. Oracle entries (core tests and SEED registry)

Each entry: ID, inputs, expected top-event probability or cut sets or expected refusal code, tolerance fixed before running, source of the answer, coverage. See [plan 05](plans/05-verification.md).

## Run flow

1. Validate the saved model (structural, then numeric). Any error stops here with typed errors.
2. Snapshot the model into `runs/<id>/inputs/` with hashes.
3. Export Open-PSA XML; build the explicit command; start SCRAM with a timeout; own the process tree.
4. On exit: check exit code and report presence; parse; verify cut-set consistency (each cut set's events exist in the model; probabilities in [0, 1]).
5. Write the local versioned `results.json` and keep the raw report untouched in `native/`. Index only completed/complete results; SEED mapping waits for its accepted E0 schema.
6. The editor shows the result with the assumptions; SEED reads the same record.

States: queued, running, completed, truncated, failed, cancelled, interrupted. Completeness is a separate field. The authoritative transition and outcome table is in [plan 02](plans/02-engine-and-adapter.md#lifecycle-and-completeness-contract); only completed/complete results are indexed. A trip does not occur in this app.

## Conventions

- **Probabilities:** dimensionless numbers in [0, 1]; displayed with significant figures stated; never rounded before comparison with an oracle.
- **No hidden approximation:** every result states the probability method (exact or an approximation) and any cut-set limits.
- **IDs:** stable, never reused, case-sensitive; names are for display.
- **Determinism:** the analysis here is deterministic; a rerun with the same inputs and engine build gives the same result. Uncertainty analysis (later) records its seed.
- **Time:** none in V1. Constant probabilities are not rates; do not label them as per-hour.
- **Line endings:** LF everywhere (see `AGENTS.md`).
- **Security:** no shell strings; SCRAM runs with an explicit argument list; run roots enforced; imported XML is parsed with entity expansion off and treated as data; text in models never becomes a command.

## Repository layout (planned)

```
pra-studio/
  README.md  PLAN.md  TODO.md
  docs/            ARCHITECTURE.md, WORKFLOWS.md, TOOLING.md, AGENT-TASKS.md, plans/
  schema/          model.schema.json, vectors/ (good and bad fixtures)
  oracles/         entries in the SEED oracle format, results/
  src/core/        model, validation, Open-PSA bridge, run manager, results parser
  src/server/      local server
  src/web/         editor, lessons
  src/adapter/     SEED adapter
  examples/        lessons and teaching cases (synthetic probabilities, labelled)
  tests/           unit, oracle, e2e
```

## How the milestones depend on each other

```
 P0 engine evidence -> subset/schema/validator + independent oracle
                     -> headless P2 acceptance -> full P1 editor
                     -> remaining P2 checks -> P3 lessons + SEED -> P4
 SEED E0 accepted transport/result/oracle contracts ------^ (P3 suite only)
```

- P0 comes first because the engine's real behaviour fixes the subset, the error mapping and the Windows story.
- Execution order: P0 evidence -> schema/validator and independent oracle -> headless P2 engine/result acceptance -> full P1 editor -> remaining P2 checks -> P3. Milestone numbers label deliverables, not a strict chronological order. Editor prototypes may follow the schema, but full editor implementation waits for the headless acceptance in plan 02.
- P3's SEED part needs SEED's adapter and oracle-entry schemas (SEED E0).
