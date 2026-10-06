# Publishing run files and this repository (publication scrub)

Written 2026-10-06. Nothing a person would not want to publish should be in a run file: no absolute folder of the machine it ran on and no account name.

## What the app writes now
`analyze()` (the SCRAM path) writes `inputs/settings.json`, `log/stdout.txt` and `log/stderr.txt` through `scrubText` (`src/core/scrub.ts`):
- the run folder, in every spelling (`C:\...`, `C:/...`, `/mnt/c/...`, `%20` for spaces, JSON-escaped backslashes), becomes `<run>`, so the recorded argument list reads `<run>/inputs/model.xml`; the engine itself still gets the real paths;
- any other home folder (`C:\Users\<name>`, `/mnt/c/Users/<name>`, `/Users/<name>`, `/home/<name>`) becomes `<user>`, and the name of the account running the process is removed wherever it appears as a whole word.
SCRAM's own error messages name the input file by full path (the XML parse error does); in the saved log that path is `File: <run>/inputs/model.xml`.

The built-in engine writes no paths. The headless runner's published files (`model.json`, `results.json`, `manifest.json`) contain none. **`<out>/active-run.json` does** (the run's working folder, which cancel needs): it is operational state, not part of a result. Publish `<out>/<run-id>/` and not `active-run.json`, or scrub it with the tool below.

## Scrubbing a folder that already exists
```
npx tsx scripts/scrub.ts <folder>                       report what would change (exit 1 if anything would)
npx tsx scripts/scrub.ts <folder> --write               rewrite the files in place
npx tsx scripts/scrub.ts <folder> --repo <project>      also turn the project folder into <repo>
npx tsx scripts/scrub.ts <folder> --run <run folder>    also turn a run folder into <run> (repeatable)
```
It never follows a link, skips binary files and files over 16 MB (and says so), keeps line endings, and replaces a file only after the new text is complete. It reports anything the detector still finds after scrubbing. Give it native paths (`C:\...`), not Git Bash's `/c/...`.

## What was scrubbed in the repository (2026-10-06)
- `docs/spike/runs/*/run.json` (57 files): the project folder is `<repo>`, including the URL-encoded form in engine messages. `docs/spike/run_oracles.py` now writes them that way.
- `docs/spike/README.md` and two test fixtures (`toWslPath` examples) named the account and its folder; they now use an example name.
- **A guard test** (`tests/unit/scrub.test.ts`, "the repository itself is fit to publish") fails if any tracked text file names a home folder or the account running the tests. Example names (`alice`, `bob`, `student`, `user`, `x`) are allowed.

## What is deliberately left, and what is not done
- Generic engine paths inside WSL (`/root/sneed-runtime/...`, `/root/pra-scram/...`) stay in `settings.json` and the spike evidence: they carry no account name and they say which build ran. Say so if you want them replaced by `<engine>`.
- The GitHub handle appears in `LICENSE` (copyright holder) and the suite docs.
- **Done 2026-10-06: a fresh repository.** `bluetyde/sneed-pra` was made from the scrubbed tree as a single commit with no earlier history (a `git archive` of this repository's `main`, committed in an empty repository, and checked by a scan of every commit and every file). The working repository `bluetyde/sneed` is unchanged and keeps its full history, which still names the account and folders: keep it private. Later work is moved to the public repository by copying the tree again (a squashed commit or a patch), not by pushing this history.
- **Git history of this working repository is not rewritten.** Earlier commits still contain the account name and folders (59 spike run files and others). Publishing this repository as it stands publishes that history. Options: publish a fresh repository from a squashed or orphan branch of the scrubbed tree, or rewrite history with `git filter-repo` (destructive, needs your decision). Pushing to a new public repository without doing one of these is the only way the old paths leave the building.
- Existing `runs/` folders on this machine (ignored by git) still hold unscrubbed `settings.json` files; run the tool on them before sharing any.
- The scrub finds home-folder paths and account names. It cannot know about other private text (a model name, a note, a citation) a person typed into a model.
