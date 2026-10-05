# Plan 03: Editor

The visual fault-tree editor. Milestone P1. Follows the suite look (OpenMC Studio ribbon style, as NODAL adopted) unless P0 shows a reason not to.

## Prerequisite

The schema/validator and headless engine/result acceptance in [plan 02](02-engine-and-adapter.md#headless-acceptance-before-the-full-editor) precede full editor implementation. Allow selecting a basic event directly as the top event for lesson 1.

## Student workflow it must support

Open the two-pump lesson, draw basic events and AND/OR gates, enter probabilities, validate, run, inspect cut sets and the top probability, change an assumption, and compare saved runs.

## Parts

| Part | Behaviour |
|---|---|
| Palette | Basic event, AND gate, OR gate (voting gate if adopted) |
| Canvas | Drag, snap to grid, connect, move, delete, auto-layout of a tidy tree, zoom and pan; keyboard operation for all of it |
| Reference marker | A repeated reference to an existing event or gate is drawn distinctly and shows the shared ID; selecting it highlights every reference |
| Properties panel | ID (read-only after creation), name, probability, source (synthetic, sourced with citation, assumed), note |
| Problems list | Live results of the validation table; click selects the offender |
| Results panel | Top probability, method, assumptions, cut sets with orders; stale marker when the model changed since the run |
| Explain | Selecting a cut set highlights its events; a plain-language sentence ("The top event occurs if A and B both fail") |
| Compare | Two saved runs: model differences and result differences |
| Undo/redo | Whole-edit granularity; layout moves are separate from model edits |
| Save/load | Native JSON; unknown fields preserved; unsaved-work prompt |

## Rules

- Editing never runs the engine implicitly. Run is an explicit action; results are tied to the model hash and run settings that produced them and go stale on a semantic edit. Metadata-only edits follow the provenance and link-review rules in [plan 01](01-model-and-semantics.md#model-identity-and-provenance).
- Layout changes do not create a new model revision.
- Every probability field shows its allowed range and refuses out-of-range input with the reason.
- Independence is displayed as a model assumption, not hidden. There is no "make these dependent" control in V1.
- A model from an import shows which constructs were refused.
- Accessible: keyboard operation, visible focus, no information carried by colour alone, readable at 200% zoom, screen-reader names for nodes and the Problems list.

## Tests

- Browser workflow: draw, set probabilities, validate, save, reload, the same model hash.
- Cycle, missing reference and out-of-range probability each block Run with the named problem.
- Selecting a repeated reference highlights all references of that ID.
- Layout move leaves the model hash unchanged; a probability edit changes it and marks results stale.
- Keyboard-only run of the two-pump lesson.
- Unsaved-work prompt on close.

## Open

- Stack and drawing approach (SVG or canvas; library or custom). Decide after P0 with NODAL's renderer decision in view.
- Layout algorithm for tidy trees with repeated references.
- Print and export of the tree as an image or PDF for lab reports.
