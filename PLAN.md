# SNEED (formerly PRA & Reliability Studio): Plan

SNEED = Safety in Nuclear Engineering Educational Design. The folder and log keep the running name `pra-studio` (like `virtual-reactor` for RAFT). Status: plan only, no code, no engine installed. Written 2026-09-30, rewritten in depth 2026-10-03.

Detailed documents:
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): components, the native model, interfaces, run flow, conventions, layout, dependencies
- [docs/WORKFLOWS.md](docs/WORKFLOWS.md): setup, spike, change the model, add an oracle, add a lesson, SEED adapter, release, multi-agent rules
- [docs/TOOLING.md](docs/TOOLING.md): SCRAM and other tools, what is verified and what is not
- [docs/AGENT-TASKS.md](docs/AGENT-TASKS.md): delegation board
- [docs/plans/](docs/plans/): one plan per area: [01 model and semantics](docs/plans/01-model-and-semantics.md), [02 engine and adapter](docs/plans/02-engine-and-adapter.md),
  [03 editor](docs/plans/03-editor.md), [04 lessons](docs/plans/04-lessons.md), [05 verification](docs/plans/05-verification.md),
  [06 suite integration](docs/plans/06-suite-integration.md), [07 extensions](docs/plans/07-extensions.md), [08 release](docs/plans/08-release.md), [09 virtual-reactor link (idea)](docs/plans/09-virtual-reactor-link.md)
- Suite context (workspace): `plans/suite/nuclear-suite-integration.md`, `plans/experiment-studio/agentic-harness.md`, and the SEED repo's plans (`experiment-studio/`).

## Goal

Help students explain how component failures combine, using visual fault trees, a documented engine (SCRAM) and guided lessons. A student draws a tree, enters probabilities, runs it, reads the minimal cut sets and the top-event probability, changes an assumption and compares the runs.

It is a teaching tool. It is **not** a licensing-grade PRA tool, and it never turns a top-event probability into a core damage frequency. It is also one of the suite apps: it works alone, and SEED can open it, run it and read its results. Its adapter is the second real adapter of the agentic harness (Virtual Reactor is first, by availability), so its oracles matter beyond this app.

## Design principles

- **The engine is not ours.** Use SCRAM for analysis; do not write a replacement solver. The contribution is the editor, the lessons, the refusals and the suite integration.
- **Identity is separate from drawing.** An event is one thing; a repeated visual node is another reference to the same event. Independence is never inferred from where something sits on the canvas.
- **State every assumption.** Constant probabilities, independent basic events, coherent logic: each is a visible setting in the model and in every result.
- **Refuse, don't approximate silently.** An unsupported construct blocks analysis with a named reason and keeps the original input. No silent dropping, no guessed probabilities.
- **Never infer failure logic from a coolant diagram.** A component link supplies a name and identity, not failure semantics or probabilities.
- **Say which number it is.** Top-event probability is not frequency. A frequency needs initiating-event rates, sequence logic, time units and an end-state definition (extension plan 07).
- **Independent oracles.** Every number a lesson shows is checkable by hand or by an independent method.
- **Native model first.** The app's own document is authoritative; Open-PSA is an import/export format for a documented subset.
- **Standalone.** Nothing here requires SEED. Materials may travel in a project envelope but a simple fault tree does not need them.

## Why it's worth building

Written 2026-10-03 from the repo's plans. **Statements about other tools are unverified until [docs/TOOLING.md](docs/TOOLING.md) section 3 is done; do not repeat them outside the repo before then.**

| Existing kind of tool | Good at | Missing for teaching |
|---|---|---|
| Analysis engines (SCRAM and similar) | Correct, fast cut-set and probability analysis | Command line and XML; no drawing, no lessons, no explanation of why a cut set matters |
| Commercial PRA suites | Full-scope plant models | Expensive, licensed, complex; not for a first course |
| Generic diagram tools | Drawing | No logic semantics, no analysis |
| Textbook exercises | Concepts | No feedback loop; hand arithmetic only |

The gap: an open, visual, guided front end where the drawing is the model, the engine is checked against hand answers, and the result points back to the events that cause it.

## Core technique: draw, validate, run, explain

1. **Draw** basic events and AND/OR gates (V1), giving each event an ID, a probability and the assumptions it relies on.
2. **Validate** structurally and numerically before any run: cycles, missing references, probabilities outside [0, 1], unsupported constructs, repeated-event identity.
3. **Run** the saved model through SCRAM in an isolated run directory.
4. **Explain**: minimal cut sets and the top-event probability, with every cut set and event selectable back on the canvas, and a plain-language reading.

It fails when a student treats the numbers as plant risk. The app therefore keeps its assumptions in view and its lessons use synthetic probabilities, labelled as such.

## Architecture

```
 Browser editor (canvas, panels, lessons)
        |  native model JSON, validate, run requests
 Local server (model core, validation, run manager, results)
        |  Open-PSA XML in, XML report out; isolated run dir
      SCRAM (pinned build, direct subprocess)

 SEED (optional) --- adapter verbs: describe open validate run status cancel collect ---> same core
```

Details in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Views

- **Canvas:** palette (basic event, AND, OR; voting gate if adopted), drag, connect, undo/redo.
- **Properties:** event ID, name, probability, source, independence note; gate type; repeated-reference marker.
- **Problems:** live structural and numeric issues, each selectable.
- **Results:** top-event probability, minimal cut sets with orders, approximation used, assumptions, run provenance.
- **Explain:** click a cut set, highlight its events on the tree; plain-language sentence.
- **Compare:** two saved runs side by side with what differs in the model.
- **Lessons:** guided steps with checks.

## Tech choices (tentative)

- Browser app and a small local server, following the NODAL and Virtual Reactor pattern (TypeScript web app, local process for the engine). Final stack chosen after the P0 spike.
- SCRAM invoked as a subprocess with explicit arguments; no shell strings; input and output files in an isolated run directory.
- JSON Schema for the native model with good and bad fixtures (Virtual Reactor's `schema/` pattern).
- Open-PSA Model Exchange Format for import/export of a documented subset.
- WSL/Linux for the engine on Windows if no Windows build is practical (decided in P0).

## First test cases

Synthetic probabilities only; independence stated. Full table in [plan 05](docs/plans/05-verification.md).

- A=0.1, B=0.2: AND = 0.02; OR = 0.28.
- A AND A and A OR A both equal 0.1 (repeated event, not two samples).
- (A AND B) OR (A AND C) with C=0.3: 0.044.
- Two pumps with a shared power supply S=0.05: S OR (P1 AND P2) = 0.0595.

## Milestones

| Milestone | Deliverable | Exit evidence |
|---|---|---|
| P0: engine spike | Pin a SCRAM build; record license and redistribution terms; run a tiny model directly; document the supported Open-PSA subset | Saved input, exact invocation, engine version and expected report; Windows/WSL path verified |
| P1: editor | Basic events and AND/OR gates, undo/redo, save/load, validation, repeated-event references | Browser workflow survives reload; cycles, missing references and out-of-range probabilities refused |
| P2: analysis | SCRAM adapter, isolated run directory, cut sets, probabilities, warnings | Hand oracles and direct engine results agree; failure and cancellation never shown as success |
| P3: lessons and suite | Three guided lessons, compare runs, SEED open/run/collect | Standalone and workspace runs agree on the same immutable input; harness acceptance test 9 (PRA through SEED and direct agree) passes |
| P4: extensions | Event trees first; then explicit common-cause and uncertainty models | Each construct has independent reference cases and visible assumptions |

Execution order is P0 evidence, schema/validator plus independent oracle, headless P2 acceptance, then the full P1 editor and remaining P2 checks. See [plan 02](docs/plans/02-engine-and-adapter.md#headless-acceptance-before-the-full-editor). P3 suite work waits for accepted SEED E0 contracts; standalone work does not. Stack, voting, repository naming and distribution choices do not block P0.

## Open questions

- Exact SCRAM build and how to get it on Windows (native, WSL, or container); license and redistribution terms.
- Open-PSA subset to support, and the policy for constructs outside it.
- Probability method defaults and how to teach the difference between exact and approximate results.
- ~~Voting gate~~ decided 2026-10-05: native in V1.
- Desktop vs browser packaging; distribution license.
- ~~Stack~~ decided 2026-10-05: TypeScript web app and Node server, matching NODAL/SEED.
