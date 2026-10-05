# SNEED (formerly PRA & Reliability Studio)

SNEED = Safety in Nuclear Engineering Educational Design. The folder and log keep the working name `pra-studio`.

Planning folder created 2026-09-30; in-depth plan written 2026-10-03. As of 2026-10-05 there is no application or editor. What exists: the P0 SCRAM spike evidence in `docs/spike/`, the native schema, validator, Open-PSA exporter, run manager and result checking (`schema/`, `src/core/`) with tests (`npm install`, then `npm test`; `npm run test:engine` also needs WSL and an installed SCRAM: `npm run runtime -- install` builds it from the recipe in `runtime/` (the app has no other engine; analysis without it fails with `E_SETUP_REQUIRED`)), and canonical hash vectors in `tests/canonical/`. SCRAM itself is built outside this folder (WSL) and is not part of it.

Start with [PLAN.md](PLAN.md), then [TODO.md](TODO.md). Design documents are in [docs/](docs/README.md): architecture, workflows, tooling, the delegation board and eight area plans. Suite decisions and cross-app contracts live in [the integration draft](../plans/suite/nuclear-suite-integration.md); the agentic harness it plugs into is in [the harness plan](../plans/experiment-studio/agentic-harness.md) and the SEED repo (`../experiment-studio`).

Folders: `docs/` for design notes and spike evidence; `schema/` for the JSON Schema and its fixtures; `src/core/` for the validator and canonical hashing (TypeScript, Node); `examples/` for future teaching cases (synthetic probabilities, labelled); `tests/` for the oracle set, canonical vectors, unit tests and the validator mutation check.

Development coordination: [project log](../messages/pra-studio.md) and [workspace rules](../messages/INSTRUCTIONS.md). Do not interpret an unchecked task or proposed contract as implemented support.
