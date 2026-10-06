# The editor as built

Written 2026-10-05 for [plan 03](plans/03-editor.md). It records what exists, how it is put together, how to run and test it, and what is still open. The plan stays the statement of intent.

## Run it

```
npm install
npm run runtime -- install      # once: builds the SCRAM runtime the app needs (see RUNTIME.md)
npm start                       # builds the web app and serves it on http://127.0.0.1:5205
```

Development: `npm run dev:server` (the API on 5205, also accepting the Vite origin) and `npm run dev:web` (Vite on 5206, proxying `/api`), then open http://127.0.0.1:5206. Saved models live in `~/.sneed/models` (`SNEED_PROJECT_DIR`), runs in `~/.sneed/runs` (`SNEED_RUNS_DIR`); ports come from `SNEED_PORT` and `SNEED_WEB_PORT`. Without an installed runtime the editor still opens and edits, and Run says exactly how to fix it.

## Shape

| Piece | Where | What it does |
|---|---|---|
| Server | `src/server/` | Plain Node HTTP, bound to loopback only. `POST /api/validate` (problems plus the model and document hashes), `PUT/GET /api/models/<name>` (atomic saves of the exact text), `POST /api/run` and `/api/run/cancel` (one run at a time, cancel and browser disconnect both stop the engine), `GET /api/health` (is the runtime installed). Host and Origin checks, a custom header required on writes, a size limit, typed errors that never carry a path or stack, a strict content security policy on the pages. |
| Editor core | `src/web/model/` | No DOM. `doc.ts` (immutable edits that keep unknown fields), `visual.ts` (the drawn tree, repeated-reference markers, tidy layout, keyboard neighbours), `editor.ts` (selection, undo and redo, validation scheduling, runs, staleness, files). |
| Interface | `src/web/ui/` | Vanilla TypeScript and SVG in the suite's ribbon look, system fonts only. The drawing, an outline list (the accessible twin of the drawing), Properties, Problems and Results panels, dialogs. |

The browser runs no core code. Validation, hashing and analysis all happen on the server, through the same functions the tests use, so the editor cannot disagree with the engine pipeline.

## Behaviour worth knowing

- A basic event or gate is **drawn once**. Every further use of the same id is a dashed **repeated reference**; selecting either highlights the other. A OR A is shown as one event and one marker, and analyses to 0.1, not 0.19.
- The editor **allows what the validator will name**. A cycle, a one-input AND, a K outside 2 <= K < N or a missing reference can be drawn; the Problems list names each in plain words, selects the offender on click, and blocks Run. A probability outside 0 to 1 is refused at the field with the reason and never reaches the model.
- **Layout is separate from the model.** Moving a node changes the file but not the model hash, so a result stays current. A probability, structure, assumption or method change makes the result **stale** (a banner and a pill say so); undoing it makes it current again.
- Results show the probability with the stated assumptions, the cut sets (choose one to see it on the drawing in plain words), and how the number was produced. A rare-event sum above 1 shows the real sum with a caveat and the bound 1 as the probability. A failed, cancelled or truncated run shows reasons in words and never an unlabelled number.
- Keyboard: Tab reaches the drawing as one stop (roving focus); arrows move between nodes, Enter edits, Delete removes, `+`, `-`, `0` zoom and fit; Ctrl+Z, Ctrl+Y, Ctrl+S, Ctrl+Enter, Escape (cancel a run, clear a highlight, clear the selection). Everything is also reachable by pointer: drag a node, drag from the dot under a gate to connect.

## Tests

| Command | What it proves |
|---|---|
| `npm test` | Unit: document operations, the visual tree and layout, the editor core with a fake API wrapped around the real validator (undo, staleness, late validation, files), the server (security checks, files, runs, busy, cancel, disconnect). |
| `npm run e2e` | Real Chrome against a real server and the real SCRAM: the lesson models (0.0595, 0.021025, 0.028, A OR A = 0.1), problems, stale results, layout moves, save and reload with the same model hash, unsaved-work guards, cancel, a missing runtime, a dead server, **keyboard-only runs** (no mouse), and an **axe-core audit** (WCAG 2.0 and 2.1 A and AA plus best practices) of every state, a 200% zoom check, and a content security policy with no violations. |
| `python tests/mutation/verifier_mutations.py web` | 33 deliberate breaks of the editor logic, the server's safety checks and the interface; each must make a test fail. |

## Not done, or not established

- **No human screen-reader pass.** The automated audit and the keyboard tests are real, but they find some problems, not all. A person using a screen reader should try the lessons before anything is called accessible.
- Print and image export of the tree, the Compare view, lessons and their checker (P3), and the Open-PSA import path are not built.
- A model with several thousand nodes was not tried; layout is a single pass and the drawing is rebuilt on every change.
- Browser coverage is Chrome only.
- The Codex P1 exit review in the TODO has not been run.

## Engines (plan 10, built 2026-10-06)

The title bar has an **Engine** list: Built-in (default, needs no install), SCRAM, or Both. Run needs only a valid model unless SCRAM alone is chosen and its runtime is missing. A result is out of date when the engine choice changed after it. With Both, the Results tab shows a card: *the two engines agree*, *the two engines differ* (with each difference in words) or *no second opinion* (SCRAM not installed). Details and verification: [ENGINES.md](ENGINES.md).

## Lessons (plan 04, built 2026-10-05)

- **Files.** `lessons/*.json` (schema in `src/core/lesson.ts`). Each lesson has steps, expected outcomes, "check this" detectors and a hand calculation. An outcome names an entry in `tests/oracles.json` and must equal it; the loader refuses anything else, and the server (`GET /api/lessons`) serves no lesson at all if one file or the oracle file is bad (503 `E_LESSONS_UNAVAILABLE`). The server reads the oracle file from the source tree, so lessons need the repository layout.
- **Checker.** Declarative checks on structure and numbers only; position on the drawing is never read. The editor shows each node by its display name when that name is unique, because the editor's ids are E1, E2 and a student names an event P1. A lesson is complete only when every step is done, no "check this" detector fires **and** a current, completed, complete engine result equals an expected outcome (names, not ids, in the cut sets). A stale, truncated or failed result is never credited.
- **Panel.** The Lesson tab lists the lessons; starting one replaces the model with an empty one (asking first if there is unsaved work). Progress is stated in words (Done, Next, Not yet), not by colour. The hand calculation stays hidden until the student has run the model once.
- **Review.** `docs/LESSON-REVIEW.md` (generated by `node scripts/lesson-review.mjs`) is the sheet for an instructor. **No instructor has reviewed the lessons.** The author's own read and a readability score (about grade 4 to 5 by Flesch-Kincaid) are not a review.
- **Tests.** `tests/unit/lesson.test.ts`, lesson blocks in `web-editor.test.ts` and `server.test.ts`, `e2e/lessons.spec.ts` (lesson 1 by keyboard alone; lessons 2 and 3 with the real engine), a lesson case in `e2e/a11y.spec.ts`, and `python tests/mutation/verifier_mutations.py lessons` (15 mutations, all caught).
- **Known gaps.** Events must be named as the steps say (the panel says so when a result does not match). No screen-reader pass. Lessons only teach the static tree: no figures, so no alt text yet.

## Compare (plan 03, built 2026-10-05)

- **Data.** (Codex review fixes, 2026-10-05: no link below the runs folder is followed, even one pointing at another run; the model file must be JSON; a record without status or a cut-set list is unreadable and is never shown as "zero cut sets"; each run's own status and completeness are always stated and a run that is not completed and complete is called diagnostic only; "same inputs" needs the method, the engine name, version and build and the model hash stated in both records; a slow answer to an older comparison cannot replace a newer one; a failure to list runs is shown as that.) Every run is already saved in its own folder (`native/model.json` byte for byte as submitted, `results.json`). `GET /api/runs` lists the newest 100 readable runs; `GET /api/runs/:id` returns one run's model text and record. Read-only: ids are plain folder names (path tricks are refused), a damaged run is left out of the list and answers 422 if asked for directly, and nothing in these routes writes.
- **Diff.** `src/core/compare.ts` (pure, hostile-data safe). Model: top event, events and gates added or removed, changed probabilities, names, gate types, vote thresholds and inputs (input order is not a difference; a repeated input is). Result: status, completeness, method, engine, the probability change (with a ratio only when the earlier value is not zero), cut sets only in one run or with a different probability, and assumptions that differ.
- **No judgement.** The view says "then", never better, worse or safer. When two runs analysed the same model with the same method and engine and the numbers still differ, it says so as unexpected and tells the reader to treat both as unverified.
- **Panel.** The Compare tab. Until a student picks a run, the choice follows the two newest runs as new ones arrive; a choice they made is kept while it stays on offer.
- **Tests.** `tests/unit/compare.test.ts`, run-route tests in `server.test.ts`, compare blocks in `web-editor.test.ts`, `e2e/compare.spec.ts` (including a keyboard-only run), an axe case, and `python tests/mutation/verifier_mutations.py compare` (14 mutations, all caught; the dirname check in `runs.ts` is defence in depth and has no mutation because the id pattern already refuses every path).
- **Screen reader.** `docs/SCREEN-READER-PASS.md` is the script for a human. No pass has been done.
- **Gotcha.** The mutation runner builds `dist/web` from each mutated source, so `dist/web` is left as the last mutant. Run `npx vite build` after any mutation run before using the app or a bare `playwright test`.

## Queued runs and saved-run reuse (built 2026-10-06)
- **Queue.** The server runs one analysis at a time. A second `POST /api/run` waits its turn (up to 8 waiting; the ninth is `409 E_BUSY`) instead of being refused. A client may name its request (`request_id`, 1 to 64 of `A-Za-z0-9_-`); `GET /api/run/status` lists who is running and who waits, and `POST /api/run/cancel` with a `request_id` cancels exactly that request (a waiting one is removed and answered `{kind:'dequeued'}`; without an id the running one is cancelled, as before). A waiting client that disconnects leaves the queue and never runs. The editor shows "Waiting for N other runs" while it waits.
- **Reuse.** Before running, the editor asks `POST /api/run/lookup` whether a complete saved result exists for exactly this run: same model (by `model_hash`), method, and engine build (built-in: name and version; SCRAM: version and the hash of the binary the installed runtime resolves to), `status` completed and `completeness` complete, searching the newest 1000 runs. If so it **offers** it ("Show the saved result" or "Run again") instead of running; nothing is run or written until the student chooses. "Both" is never offered (the cross-check is not saved). A shown saved result is labelled as one. The built-in engine's identity is its version constant only; there is no source hash yet, so a change to the solver without a version bump would still be offered.
- **Tests.** Server queue and lookup tests, editor tests, 3 e2e cases (`e2e/reuse.spec.ts`, plus an axe case), 33 mutations (`verifier_mutations.py queue`). The e2e `run()` helper chooses "Run again" when the offer appears, because the server keeps every run.

## Print and image export (built 2026-10-06)
- **Figure.** `src/web/model/figure.ts` turns the drawing into one standalone SVG document (pure text: no fonts, scripts, external files or colour; ellipse = basic event, rectangle = gate, dashed = a repeated use). Below the drawing it states the assumptions and, when there is one, the result: probability, method, engine, status, cut set count, the cross-check (agreement, disagreement or no second opinion) and the model hash. A run that is not complete/completed is headed **DIAGNOSTIC ONLY** with its reasons. A result that is out of date, or for a model edited since it was checked, is **not** shown: the figure says "NO CURRENT RESULT". The same input gives the same bytes; a date appears only if one is passed.
- **Export.** Ribbon group Export: **SVG** (a download, checked to parse as SVG first), **PNG** (the browser draws that SVG at 2x, at most 8000 px a side) and **Print**. Names and the model name are escaped; characters XML cannot hold are replaced. Print builds a sheet on `beforeprint` (so Ctrl+P prints the same): the figure plus a table of the minimal cut sets (first 60), and the editor itself is not printed.
- **Tests.** `tests/unit/figure.test.ts` (31 cases), editor cases, `e2e/export.spec.ts` (SVG parses in the browser, PNG is a real PNG with ink, stale result not drawn, print media shows only the sheet and a PDF is made, keyboard names), 35 mutations (`verifier_mutations.py export`). Codex review found two real defects (the cross-check was dropped from the figure; XML-invalid characters made an unparseable file) and both are fixed.
- **Not done:** a PDF button (use the browser's Print to PDF); standard gate symbols (gates are labelled rectangles); the figure has not been looked at by a human for layout on a very large tree.

## Importance measures (plan 12, built 2026-10-06)
- **What.** In the Results tab, "Compute importance" gives, for every basic event that can reach the top, four exact measures: **Birnbaum**, **risk achievement worth**, **risk reduction worth** (shown as ∞ when setting the event's probability to zero makes the top probability zero) and **Fussell-Vesely** (exact form). Definitions, assumptions, hand oracles and limits: [docs/plans/12-importance.md](plans/12-importance.md). The table is never automatic, is for the model on screen only (any edit hides it), is sorted by Birnbaum, and carries the definitions and the assumptions. Built-in engine only; SCRAM is not asked and the result record is unchanged.
- **How.** `POST /api/importance` runs in a worker thread with the solver's time and memory limits, takes its turn in the same queue as runs, and can be cancelled (button, or by request id). At most 300 events and a work budget (events x diagram nodes); beyond that a stated refusal, never a partial table.
- **Numerical honesty.** Birnbaum is computed on the "false" side when the top event is almost certain (an OR of 16 events near 0.9 has Birnbaum about 1e-16 per event, which a plain difference rounds to 0); Fussell-Vesely is p x Birnbaum / P; a probability that underflows although the event can matter, or any non-finite measure, is a `numeric-range` failure with a message, and "impossible" is decided structurally.
- **Tests.** Hand oracles, agreement with the exact-rational enumeration oracle on the frozen models and 1000 random trees, derivative and identity checks, edge cases and limits, server, editor and 4 e2e cases plus an axe case, 39 mutations (`verifier_mutations.py importance`). Codex found 4 real defects (cancellation in Birnbaum/FV, underflow reported as success, no cancel from the editor, a false structural explanation of infinity); all fixed.
- **Not done:** SCRAM parity (the pinned build has no such output for this model class), importance for approximation methods, groups of events, measures with uncertainty. Plan 07 said P4 waits for P3 verification; the human screen-reader pass and instructor review are still open.
