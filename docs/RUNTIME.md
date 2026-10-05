# SCRAM runtime: recipe, installer and how the app finds the engine

Written 2026-10-05. Everything stated as measured was measured on one Windows 11 machine with WSL2 Ubuntu 24.04 (16 cores, warm conda package cache). SEED's runtime manifest and transaction store are not implemented yet (SEED's `docs/runtime-inventory.md` lists them as its next work), so this is the **app's side of the contract**: a recipe SEED can consume, a standalone runner that proves the recipe, and the manifest the app reads. Nothing here edits the SEED repository.

## What exists

| Piece | File | Role |
|---|---|---|
| Recipe | `runtime/scram.recipe.json` | Declarative: artifact id and version, platform, license and source obligations, trust statement, sizes, prerequisites, ordered steps (argument lists), outputs. Validated by `schema/runtime-recipe.schema.json` and `src/runtime/recipe.ts`. |
| Toolchain lock | `runtime/scram-toolchain.linux-64.lock` | 48 conda-forge packages as an explicit conda spec, every one with a sha256. The recipe pins the lock's own sha256. |
| Smoke checks | `runtime/scram-smoke.json` | Seven native cases with hand-derived expected values, including the voting shape SCRAM gets wrong. Gate activation of a new build. |
| Runner | `src/runtime/install.ts`, `smoke.ts` | Standalone transaction: preflight, staging, building, verifying, smoke, activating, with failure, cancel, crash recovery, rollback. |
| CLI | `scripts/runtime.ts` | `npm run runtime -- install | status | verify | recover | rollback | engine` |
| Engine lookup | `resolveEngine()` | Gives the analysis layer the active binary, its recorded sha256 and runtime identity. |
| Evidence | `runtime/evidence/2026-10-05-first-install/` | The install record and installed manifest from the first real install. |

## Mapping to SEED plan 11 (runtime artifact contract)

| Plan 11 asks for | Where it is |
|---|---|
| Artifact id / version / recipe revision | `artifact.{id,version,recipe_revision}` |
| OS / architecture | `platform` (linux x86_64 under WSL2 only) |
| Supported app / adapter versions | `compatibility` (native schema 1, exporter `sneed-export-1`, parser `sneed-report-1`, engine version regex) |
| Trusted source and content hash | `trust`: source URL and commit (a git object id, verified after checkout), conda-forge channel, lock sha256 |
| Sizes (download, expanded) | `sizes`: 202 387 794 bytes download, about 1.2 GB expanded (measured 1 201 043 744), 3 GB free required |
| Prerequisite capabilities | `prerequisites` with how to fix each; WSL itself is a user action, never done by the runner |
| Engine / dependency manifest | the lock file plus the installed manifest |
| License, notices, source obligations | `license` |
| Capability checks and native oracles | `capabilities` and the smoke cases |
| Publisher authenticity | **not established**: stated in `trust.authenticity`. Hashes prove content identity only |

## The transaction

States, in SEED's vocabulary: `queued`, `preflight`, `staging` (toolchain, source), `building`, `verifying`, `smoke`, `activating`, `ready`; outcomes `failed`, `cancelled`, `interrupted`. Every transition is written to an install record before it is announced.

- **Preflight** finds conda and git in the distribution, checks free space and picks the job count (cores, capped at 8). A missing prerequisite fails with its name and nothing is created.
- **Versioned prefix.** Each attempt builds in its own directory `<root>/scram/<version>-r<rev>-<timestamp>-<id>`. A conda environment is not relocatable, so the build happens at its final path; "activation" is a pointer, not a rename.
- **Toolchain lock** is copied into the prefix and its sha256 re-checked on the Linux side before conda reads it, so the file conda uses is the file the recipe pinned.
- **Source** is fetched by commit and verified with `git rev-parse HEAD` against the pinned commit. The recipe loader refuses any recipe that has no such verification step.
- **Steps** are argument lists run through `wsl.exe --exec` with a hard timeout. The loader refuses shell interpreters (also behind `env`), unknown or undefined placeholders, absolute paths outside the prefix and `..` segments.
- **Smoke** runs the real pipeline (export, engine, report parsing, result checking) on the fresh build. A failing check means the build is never activated.
- **Activation** is one atomic pointer write (`active.json`) after every check passed. The previous version stays on disk and is recorded as `previous`.
- **Failure and cancel** leave the active pointer untouched and remove the partial prefix (only a path the runner created: a strict name pattern under a validated root). `keepFailed` keeps it for diagnosis. Cancel kills only processes whose arguments contain the prefix.
- **One install at a time.** A lock file with a heartbeat; a holder whose heartbeat is more than 60 s old is stale (a bare PID is not trusted). The next install, or `recover`, takes a stale lock over.
- **Crash recovery** marks a non-terminal record `interrupted`, stops any surviving owned Linux processes by the prefix in their arguments, deletes the partial prefix and frees the lock. It never reads a half-built prefix as a success and never touches the active pointer.
- **Rollback** is a new activation: the previous runtime must still verify (ready marker, binary hash, version), and the runtime being left becomes `previous`. Refused while an install holds the lock.
- **Verify** re-checks the active runtime: manifest unchanged since activation, binary present, hash and version equal to install time.

State (pointer, records, installed manifests, logs) lives on the Windows side under a state directory; only the heavy runtime lives in WSL. The Linux root must be a plain absolute path (`/root/sneed-runtime`). That check exists because a Windows shell once rewrote `/root/...` into `C:/Program Files/Git/root/...` and the first real attempt created stray directories under the working directory before the check was added. Set the variables from PowerShell, or with `MSYS_NO_PATHCONV=1` in Git Bash.

## How the app uses it

`resolveEngine(env)` reads the active pointer, checks the manifest's hash against it and returns an engine configuration whose pinned sha256 is the one recorded at install. Every analysis result record carries `engine.runtime` (install id, recipe revision, manifest hash), or `null` for an unmanaged development build. The binary hash is per install, not global: the build path is compiled in, so the same source and toolchain built in another directory gives another hash. That is why the app pins what the installer recorded and not a constant.

## Evidence

| Check | Result |
|---|---|
| Real install from scratch (warm conda cache) | ready in about 51 s: toolchain 6 s, source fetch 1 s, compile 36 s on 8 jobs; 7 of 7 smoke checks passed |
| Whole engine suite against the installed runtime | 52 of 52 |
| Real second install, rollback to the first, re-verify, analysis with the rolled-back engine | passed |
| Real cancel 10 s into a compile | cancelled; no cmake, ninja or compiler process left; prefix removed; active pointer byte-identical |
| Real hard kill of the Windows process tree mid-compile | all 26 Linux processes were gone within 3 s on this machine; the record stayed `building` with a stale lock; `recover` then marked it `interrupted`, removed the prefix and freed the lock |
| Wrong pinned hash | the analysis is refused before the engine runs |
| Mutation checks | 110 deliberate breaks across validator, schema, hash, exporter, parser, result checking, run layer, recipe loader and runner: all caught |

## What SEED should take, and what it must add

- **Take** the recipe, the lock and the smoke cases as data, and the manifest format if it is useful. Replace the runner with SEED's own transaction store; the recipe does not depend on it.
- **SEED must provide** an offline cache (the recipe supports none: a cold install downloads about 200 MB and the cold time was not measured), deferral of an upgrade while jobs use the runtime (this runner does not know about jobs), removal of old versions (each kept version is about 1.2 GB; there is no cleanup), and the lifecycle authority SEED's plan assigns to it.
- **Platforms.** One recipe, one lock: linux x86_64 under WSL2. macOS or native Linux needs its own lock and a recipe variant; none was attempted.

## Not established

- Cold-cache install time and behaviour with no network.
- Redistribution: building on the user's machine from the pinned commit should not distribute anything, but nobody qualified has reviewed the GPL position for a cached or shipped binary.
- The recipe is not signed. A reviewer must read it; the hashes only stop silent substitution.
- Whether a different WSL version also ends Linux children when the Windows side is killed (recovery does not rely on it).
- The upstream `atleast` defect is worked around by the exporter, not fixed; see `docs/spike/README.md`.
