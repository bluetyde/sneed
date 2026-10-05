# Workflows

Step-by-step procedures. Everything is **planned**; no code exists. Follow a section when its feature lands.

## 0. Setup (canonical, after the P0 spike)

1. Install the pinned engine build by the steps recorded in the P0 note (the route on Windows is decided there).
2. Install the app's dependencies (Node and/or Python as chosen).
3. Run the oracle set and the unit tests; both must pass before any change.
4. Work in your own clone (the workspace folder is not a git repo yet; when it is, agents use separate clones).

## 1. Run the engine spike (P0)

1. Claim `CLAIM: pra-spike` in `messages/pra-studio.md`.
2. Save the tiny fixtures, independent derivations, expected cut sets and fixed tolerances from plan 05 before any numerical run.
3. Fetch and build/install the chosen SCRAM release; record source, version, license, environment, steps and failures.
4. Run the tiny models from [plan 05](plans/05-verification.md) directly; save inputs, exact commands and raw reports.
5. Probe malformed input, unsupported constructs, effective cutoffs and failure behaviour; test basic-event tops and repeated-reference export normalization. Repeat runs and compare normalized results while retaining raw report differences.
6. Write the one-page note and the decision record (build route, license, subset, error mapping). Commit it with the saved evidence.

## 2. Change the model or schema

1. Post the proposed change in the log before editing the schema (SEED and lessons depend on it).
2. Edit the schema and version; write the migration.
3. Add a good and a bad fixture for each new rule; every error code needs a bad fixture.
4. Run the validator tests and the oracle set.
5. Update [ARCHITECTURE](ARCHITECTURE.md) and the owning plan.

## 3. Add an oracle

1. Derive the expected value by hand or from a closed form, without running the engine. Check it a second way (a short script, inclusion-exclusion, or enumeration of basic-event states).
2. Fix the tolerance and record it before any run.
3. State what the entry covers and its tag (good, bad-input, known-limit).
4. Run through the app and directly; both must agree.
5. A changed expected value needs a source and a second derivation.

## 4. Add a lesson

1. Write the goal, the starting model, the expected values (as oracle entries first) and the common mistakes.
2. Use synthetic, labelled probabilities and no plant-risk wording.
3. Add the step checks and a fixture for each mistake.
4. Run the lesson in the browser with keyboard only.
5. Have an instructor read it before release.

## 5. Change the SEED adapter

1. Read SEED's current adapter schemas (E0). A schema change there is posted in SEED's log first.
2. Implement the verb and test against SEED's fake adapter, then the real app.
3. Re-run the parity set (SEED vs standalone).
4. Confirm standalone launch is unchanged.

## 6. Release

Follow [plan 08](plans/08-release.md).

## 7. Multi-agent rules for this project

Follows [`messages/INSTRUCTIONS.md`](../../messages/INSTRUCTIONS.md). Specific to this project:

- **Log:** `messages/pra-studio.md`. Read it at the start of every session and append at the end.
- **Claims** by area, matching the plans: `CLAIM: pra-spike`, `CLAIM: pra-model`, `CLAIM: pra-engine`, `CLAIM: pra-editor`, `CLAIM: pra-lessons`, `CLAIM: pra-oracles`, `CLAIM: pra-suite`, `CLAIM: pra-release`.
- **Schema changes affect SEED and the lessons.** Post the change first; do not change it under an open claim.
- **Separate clones per agent** once this is a git repo; no worktrees.
- **The engine is shared state on this machine.** Install it once per environment, say so in the log, and never modify another agent's installation.
- **Keep TODO.md current:** check off finished items with the date and the evidence; add discovered work under the right milestone.
