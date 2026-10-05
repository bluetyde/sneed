# PRA & Reliability Studio: TODO

Running list. Check items off, add new ones at the bottom of their section, and note the date when something finishes. Close a task with **evidence** (a command and its result, or a recorded decision); a plan edit alone means "documented", not "verified". Contract status: proposed, accepted, documented, implemented, verified.
Design lives in [PLAN.md](PLAN.md). Details per area in [docs/plans/](docs/plans/); structure in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); delegation in [docs/AGENT-TASKS.md](docs/AGENT-TASKS.md). Suite context: `../plans/suite/nuclear-suite-integration.md`, `../plans/experiment-studio/agentic-harness.md`, and SEED's plans.

Flags: **[agy]** = delegation candidate for Antigravity (large, mechanical, contract fixed, strong oracle; run antigravity-task step 0 again before dispatching). Unflagged items are Claude's. **[codex]** = a Codex review checkpoint; every milestone ends with one. **[seed]** = also needed by SEED's harness work.

Planning only. No code, engine or repo exists yet. Nothing below is implemented.

## Next (planned 2026-10-03)

1. [x] Save independent fixtures, derivations, expected cut sets and fixed tolerances from [plan 05](docs/plans/05-verification.md) before any numerical engine run. (Evidence: `tests/oracles.json`)
2. [~] **P0 spike (run 2026-10-05, evidence in `docs/spike/`; awaiting Codex review and open gaps listed there)** ([plan 02](docs/plans/02-engine-and-adapter.md)): pin a SCRAM build, record source, version and license, get it running (Windows route decided here), run the tiny models directly, save inputs, commands and raw reports, probe failure behaviour. Evidence: `docs/spike/` with the one-page note and decision record.
3. [~] (2026-10-05: canonical serializer pinned and hash vectors frozen with two implementations, `tests/canonical/`; basic-event top and duplicate-input export proven by the spike. Still open: native voting gate (the user's decision), schema field list and one error fixture per code) Settle the remaining model decisions in [plan 01](docs/plans/01-model-and-semantics.md): native voting gate or import-only; finalize schema fields/error fixtures and canonical serializer/hash vectors. Top-event, arity, assumptions and hash scope are documented in plan 01.
4. [~] Open-PSA subset and export mappings documented 2026-10-05 in [docs/OPEN-PSA-SUBSET.md](docs/OPEN-PSA-SUBSET.md) (from spike evidence). The **[codex]** P0 exit review is waived by the user (not enough code yet); record that if a later review is wanted.
5. [x] 2026-10-05: stack decided (TypeScript web app and Node server, matching NODAL/SEED); native schema specification written as [docs/SCHEMA.md](docs/SCHEMA.md) (proposed; field list, ID pattern, error table). JSON Schema file, validator and fixtures are item 6.
6. [~] Native model JSON Schema, validator and fixtures. **Written 2026-10-05 by Claude directly, not delegated to agy** (no git repo yet, and the contract was still moving): `schema/model.schema.json`, `src/core/validate.ts`, 38 fixtures in `schema/vectors/` (30 bad, 8 good) with expected issue sets written from docs/SCHEMA.md before the first run, every error code fired by at least one bad fixture except `E_UNSUPPORTED` (importer-level; `it.todo`). Evidence: `npx vitest run` 82 passed, 1 todo; `npx tsc --noEmit` clean; `python tests/mutation/verifier_mutations.py` 21 of 21 deliberate breaks caught. Open: importer fixture for `E_UNSUPPORTED`; the **[codex]** schema review (waived while little code exists, as for P0; revisit before the editor).
7. [~] Independent brute-force enumeration oracle and seeded random-tree tests: **written 2026-10-05 by Claude directly, not delegated** (`tests/oracle/`, `tests/unit/oracle.test.ts`). Exact BigInt-rational arithmetic; state enumeration over up to 16 reachable events; cut sets by exhaustive minimality; second evaluator and inclusion-exclusion as independent cross-checks; all 13 frozen hand oracles reproduced exactly (decimal equality, not just tolerance). Evidence: see the 2026-10-05 log entry. Open: comparison against SCRAM itself is TODO item 8 (not done); no test of a deliberately non-coherent model (the schema cannot express one).
8. [~] Headless native model -> SCRAM -> local result acceptance (plan 02, first part of P2): **built and passing 2026-10-05, by Claude directly.** `src/core/{export,engine,analyze,report,result,bounds}.ts`; unit tests (`npm test`) and engine tests (`npm run test:engine`, needs WSL and the pinned SCRAM). Evidence: 13 frozen hand oracles and 68 random trees agree with the enumeration oracle through the real engine; refusals create no run directory; truncation is detected from the report, not trusted; cancel/timeout kill only the owned process (tested in WSL). Found along the way: SCRAM's `atleast` is wrong for some shapes (see docs/spike/README.md); the exporter avoids it. **Not done:** the P2 run manager's queueing/`queued`/`interrupted` states and restart recovery, resource limits, reuse of an identical earlier run, the oracle registry/SEED mapping (P3), and `E_UNSUPPORTED` import. Open decision for the user: a rare-event sum above 1 is currently a failure (the engine clamps it to 1); a teaching app might prefer to show the unclamped sum, labelled.
9. [ ] Build the full P1 editor, finish P2 acceptance, then P3 lessons and suite integration against accepted SEED E0 contracts.

## Now

- [x] 2026-09-30: Planning skeleton and first plan (Codex).
- [x] 2026-10-03: In-depth plan, ARCHITECTURE, WORKFLOWS, TOOLING, AGENT-TASKS and plans 01 to 08 written (documentation only). Oracle values recomputed by a second method.
- [x] 2026-10-03: Readiness gaps corrected in plans 01/02/05 and related task order (documented only).
- [ ] Resolve engine route/subset in P0; stack/voting before their implementation; distribution/repo decisions before release. These are not prerequisites to preparing P0 fixtures.

## Contracts (core before editor; SEED mapping before P3)

Rules below are **documented** in plans 01/02 where specified; wire schemas and engine mappings remain proposed until P0/E0 evidence. None are implemented. Checkboxes require implementation/fixture evidence, not merely prose.

- [ ] Identity rules: event ID, repeated references, duplicate inputs on one gate ([plan 01](docs/plans/01-model-and-semantics.md)). Evidence: A AND A and A OR A fixtures.
- [ ] Validation table with stable error codes and one bad fixture each.
- [ ] Assumptions block carried by every model and every result.
- [ ] Result meaning: top-event probability only, never frequency; method named in every result.
- [ ] Run states, completeness, truncation and cancellation race rules; completed means parsed, consistent and complete ([plan 02](docs/plans/02-engine-and-adapter.md)).
- [ ] Local versioned results record; explicit mapping to the accepted SEED E0 results-index schema before P3 [seed].
- [ ] Local oracle entries with frozen criteria; map to the accepted SEED E0 oracle schema before P3 [seed].
- [ ] Component link: identity only, review status, stale rule ([plan 06](docs/plans/06-suite-integration.md)).
- [ ] Unknown fields preserved on save; no expression evaluated.

## P0: engine spike ([plan 02](docs/plans/02-engine-and-adapter.md))

- [ ] Version, source, license and redistribution terms recorded.
- [ ] Windows route verified, including paths with spaces and WSL paths.
- [ ] Documented supported Open-PSA subset and the mapping of the engine's failure modes to error codes.
- [ ] Determinism check: identical normalized results/cut sets for the same input/settings/build; preserve both raw reports and document allowed metadata differences.
- [ ] **[codex]** P0 exit review.

## P1: editor ([plan 03](docs/plans/03-editor.md))

- [x] 2026-10-05 Basic events, AND/OR gates and native voting gate, connect, move, delete, undo/redo. Evidence: 33 unit tests of the document operations, 36 of the editor core; e2e specs build the lesson models in real Chrome (0.0595, 0.021025, 0.028). See [docs/EDITOR.md](docs/EDITOR.md).
- [x] 2026-10-05 Repeated-reference marker; selecting one highlights all references (e2e: A OR A is one event plus one marker and analyses to 0.1).
- [x] 2026-10-05 Properties panel, Problems list with selectable offenders, save/load, unsaved-work prompt (e2e: save, reload, open with the same model hash; leaving with unsaved work is guarded).
- [~] 2026-10-05 Validation: cycles, missing references, one-input gates and bad K are named in the Problems list and block Run; an out-of-range probability is refused at the field with the reason. **Open:** unsupported-import refusal needs the Open-PSA importer (P2).
- [x] 2026-10-05 Layout separate from the model hash; a layout move changes no revision (e2e: drag a node, hash unchanged, result still current).
- [~] 2026-10-05 Accessibility pass: automated. axe-core (WCAG 2.0/2.1 A and AA plus best practices) finds no violation in any editor state, including contrast; it found and we fixed missing landmarks, no h1 and one contrast failure. Every control has an accessible name; nodes announce what they are; colour is never the only signal; 200% zoom (a 700 px window) does not scroll sideways. **Open: no human screen-reader pass.**
- [x] 2026-10-05 Browser e2e: draw, save, reload, same hash; keyboard-only run. `npm run e2e`: 35 tests in real Chrome with the real engine, including 5 keyboard-only tests that never use the mouse and 5 failure-path tests.
- [ ] **[codex]** P1 exit review.

## P2: analysis ([plan 02](docs/plans/02-engine-and-adapter.md), [05](docs/plans/05-verification.md))

- [ ] Open-PSA export and documented-subset import; hostile XML contained.
- [ ] Run manager: isolated run directory, explicit argument list, timeout, owned process tree, cancel.
- [ ] **[agy]** Results parser; saved real reports parse, broken reports refused. Needs P0 reports.
- [ ] Oracle set passes: parity with direct SCRAM and every hand oracle ([plan 05](docs/plans/05-verification.md)).
- [ ] Failure, cancellation, truncation and crash never shown as success.
- [ ] Tests of the verifier: perturbed probability, swapped gate, dropped repeated identity, missing refusal each fail the check.
- [ ] **[codex]** P2 exit review (process handling, hostile input).

## P3: lessons and suite ([plan 04](docs/plans/04-lessons.md), [06](docs/plans/06-suite-integration.md))

- [ ] Lessons 1 to 3 (single pump; redundant pumps; shared power supply, including the one-event vs two-events contrast 0.0595 vs 0.021025); optional voting lesson.
- [ ] **[agy]** Lesson checker with a fixture per common mistake.
- [ ] Compare-runs view.
- [ ] SEED adapter: seven verbs, typed errors, oracle coverage in `describe` [seed].
- [ ] Standalone vs workspace equivalence on the same immutable input; PRA through MCP and direct agree on every oracle (harness test 9) [seed].
- [ ] Stale component-link handling; no automatic derivation from a coolant diagram.
- [ ] Instructor read-through of the lessons.
- [ ] **[codex]** P3 exit review.

## P4: extensions ([plan 07](docs/plans/07-extensions.md))

- [ ] Importance measures with hand oracles.
- [ ] Event trees: write the semantics (initiating-event rate and time unit, sequences, end-state definition, shared events across branches) and the oracle set **before** code.
- [ ] Common-cause groups: stated model, data source and zero-parameter reduction check.
- [ ] Uncertainty: seeds, sampling design, noise reported separately from input uncertainty.
- [ ] Decide whether non-coherent logic and time dependence belong in a teaching tool.
- [ ] **T-H link (success criteria):** let a thermal-hydraulic result from NODAL (RELAP5-format decks) or RAFT supply a pass/fail success criterion for an event-tree branch (for example "one pump keeps the core covered"), never a failure probability or failure logic. Write the semantics and oracle first: criterion definition, what run produced it, stale rule when the T-H model changes, and the refusal when no criterion is present. Depends on event trees above and SEED E0 contracts ([plan 06](docs/plans/06-suite-integration.md)). Also answers the plan principle "never infer failure logic from a coolant diagram": only the criterion crosses, with its provenance.
- [ ] **Basic-event data library:** a labelled set of probabilities with citations (for example from NUREG/CR-6928 or its updates) so lessons stop using invented numbers. Read the report and its terms first; synthetic numbers stay clearly labelled until then ([TOOLING 3a](docs/TOOLING.md)).
- [ ] **Cross-check engine:** run XFTA (or a second solver) on the oracle set as differential testing. Check its license and Windows route first.

## Release ([plan 08](docs/plans/08-release.md))

- [x] **SCRAM runtime recipe** for SEED's installer, 2026-10-05: `runtime/scram.recipe.json` + hash-pinned conda lock (48 packages) + native smoke cases, validated by schema and loader (shells, undefined placeholders, paths outside the prefix and unverified checkouts are refused). Contract mapping, evidence and limits in [docs/RUNTIME.md](docs/RUNTIME.md). Evidence: real from-scratch install (ready in about 51 s with a warm conda cache, 7 of 7 smoke checks), the whole engine suite 52 of 52 against it, real second install plus rollback, real cancel mid-compile with no process left, real hard-kill recovery, 110 mutation checks caught.
- [x] Standalone mode uses the same recipe, no second installer: `npm run runtime -- install | status | verify | recover | rollback | engine` (a transaction runner with a heartbeat lock, crash recovery and rollback). SEED may replace the runner and keep the recipe.
- [ ] **Hand the recipe to SEED**: SEED's runtime manifest and transaction store are not implemented yet (its inventory lists them as next work). When they exist, map `docs/RUNTIME.md` onto them; this repo does not edit SEED. SEED must still add an offline cache, upgrade deferral while jobs run, and old-version cleanup (each kept version is about 1.2 GB).
- [ ] Cold-cache install time and the no-network behaviour were not measured; a macOS/native Linux variant needs its own lock; the GPL position for a cached or shipped binary is unreviewed.

- [x] 2026-10-05 License: MIT, like the other apps in the suite (user); `LICENSE` and `THIRD_PARTY_NOTICES.md` are in the repo. SCRAM stays a separate process built on the user's machine, so its GPL does not attach to this code. Distribution model: still open (public release only when the user says so).
- [ ] Pre-release checklist; make the repo public only when the user says so.
  - Before the repo is made public: scrub the Windows user name and absolute local paths from `docs/spike/runs/*/run.json` and from sample paths in `tests/`, and re-read `runtime/evidence/`. They are not secrets, and the repo is private now, so this is only a publication task (checked 2026-10-05: no credentials, tokens or personal email are committed).
- [ ] Create the repo (private first); add a SEED catalog entry once it exists.

## Known engine defects (SCRAM 0.16.2): worked around, not fixed

- [ ] **`atleast` (voting) gate returns wrong cut sets for some shapes, silently.** Reproducer: `TOP = atleast 2 of [C, A, G0, B]` with `G0 = A OR C`, P(A)=0.1, P(B)=0.2, P(C)=0.3. Correct: cut sets {A} and {C}, probability 0.37. SCRAM prints {C} and {B}, 0.44, exit 0, no warning, in BDD, ZBDD and MOCUS alike. Found 2026-10-05 by the independent enumeration oracle (random tree seed 110); evidence in [docs/spike/README.md](docs/spike/README.md).
  - **Status: we did NOT fix SCRAM.** Our exporter works around it: `atleast` is written only when every input is a distinct basic event (178 such trees tested, all correct); every other voting gate is rewritten as an OR of ANDs, and an expansion past 2000 terms is refused (`E_EXPORT_LIMIT`). The defect is still in the engine, so anyone running SCRAM directly on a model with this shape gets a wrong answer.
  - **Not reported upstream** (user decision 2026-10-05: not now). The upstream project's last push was 2023, so a fix is unlikely.
  - Pinned by a test (`tests/engine/headless.test.ts`, "SCRAM 0.16.2 mishandles atleast ..."): if SCRAM is upgraded and the bug disappears, that test fails and the export rule should be reviewed. The runtime smoke checks include this shape, so a build that loses the workaround fails before activation.
  - Revisit when: upgrading SCRAM, or if the cause is wanted. Possible later work: find the root cause in SCRAM's preprocessor, report it upstream with the reproducer, or patch our own build (a patched build would change the recipe revision and the license bookkeeping).
- [x] Other engine behaviour handled in our code, not defects to fix: the default product-order limit of 20 silently drops cut sets (we pass a limit of at least the event count), `--cut-off` has an unexplained effect (never used), and a rare-event sum above 1 is clamped to 1 with only a warning (decided 2026-10-05 to show it labelled instead of failing; implemented: `top_event_probability` keeps the bound 1, `approximation_value` has the real sum, caveat `approximation-exceeds-1`).

## Ideas / later

- Print and image export of trees for lab reports.
- An instructor guide with answers and discussion questions.
- A hosted demo (needs a decision about running the engine for other people's models).
- Lessons that use NODAL component links for naming only.

## Decisions waiting (the user's)

- [x] 2026-10-05 Stack: match NODAL/SEED, TypeScript web app and Node server (user).
- [x] 2026-10-05 Native voting gate in V1 (user); rules in plan 01 (2 <= k < N, no duplicate inputs).
- [x] 2026-10-05 Engine route: WSL2 via argument list (user).
- [x] 2026-10-05 SCRAM licensing and install: the PRA app never bundles SCRAM; SEED's dedicated installer fetches and builds the pinned source (user). The app publishes a SCRAM runtime recipe; SEED executes it ([SEED plan 11](../experiment-studio/docs/plans/11-runtime-and-shared-acceptance.md) model: staged, hash-checked, isolated versioned location, native smoke check, atomic activation). Distribution license of the app itself and the repo name remain open.
- [x] 2026-10-05 Repo: private `bluetyde/sneed` (user said go ahead; name chosen as the obvious one and found free).
- [x] 2026-10-05 Use the installed runtime by default instead of the development build (user); implemented: `analyze()` resolves the installed runtime and fails with a typed `E_SETUP_REQUIRED` if none is installed. Run `npm run runtime -- install` once before using or testing the engine.
- [x] 2026-10-05 Rare-event sum above 1: show it labelled, do not fail (user); implemented, see Known engine defects.
- [x] 2026-10-05 Upstream report of the SCRAM `atleast` defect: no, not now (user); tracked under Known engine defects.
- [x] 2026-10-05 Distribution license of the app itself: MIT (user).

## Done

- [x] 2026-09-30: Planning skeleton, first plan and suite integration links (Codex).

