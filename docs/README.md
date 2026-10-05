# Design notes

Start with [../PLAN.md](../PLAN.md). Then:

- [ARCHITECTURE.md](ARCHITECTURE.md): components, the native model, interfaces, run flow, conventions, layout, dependencies
- [WORKFLOWS.md](WORKFLOWS.md): setup, spike, model changes, oracles, lessons, SEED adapter, release, multi-agent rules
- [TOOLING.md](TOOLING.md): tools and the unchecked survey list
- [AGENT-TASKS.md](AGENT-TASKS.md): delegation board
- [EDITOR.md](EDITOR.md): the editor as built, how to run and test it
- [SCHEMA.md](SCHEMA.md), [OPEN-PSA-SUBSET.md](OPEN-PSA-SUBSET.md), [RUNTIME.md](RUNTIME.md): native model schema, the proven Open-PSA subset, the SCRAM runtime recipe and installer
- [spike/README.md](spike/README.md): P0 engine evidence and the defects found
- [plans/](plans/): 01 model and semantics, 02 engine and adapter, 03 editor, 04 lessons, 05 verification, 06 suite integration, 07 extensions, 08 release

Shared suite contracts live in the workspace draft `plans/suite/nuclear-suite-integration.md`; do not duplicate them here, restate only what this app must implement. Add normative schemas under `schema/` only after the P0 spike.
