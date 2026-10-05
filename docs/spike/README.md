# P0 spike: SCRAM engine reproduction

Run 2026-10-05 by Claude Code. Oracles in `../../tests/oracles.json` were frozen before any run and were not edited. This is a spike record, not a release: the unit tests of SCRAM were not run (see Gaps).

## Pinned build

| Item | Value |
|---|---|
| Engine | SCRAM 0.16.2, the latest tagged release (2018-01-12); last upstream push 2023-09-19 |
| Source | https://github.com/rakhimov/scram, commit `9c9a75ca0c5c2fbb5b4a7d32e29fd25bf90f7bab` |
| License | GPL-3.0 (`LICENSE` in the source tree is the GNU GPL v3 text). Not yet decided what bundling requires; see decisions |
| Platform | WSL2 Ubuntu 24.04, conda env `/root/pra-scram/env-old`: GCC 11, CMake 3.27, Boost 1.78, libxml2 2.10.4 |
| Binary | `/root/pra-scram/build/bin/scram`, sha256 `eaa41f5ae3bfef0f445f302f65079189b13a545e575ec2e1b65c77dfa0b78ed8` |
| `--version` | `SCRAM 0.16.2 ()`, `Boost 1_78`, `libxml2 2.10.4` |

Build record: `build-env-and-scram.sh`, `build-cli-target.sh`. Built with `-DBUILD_GUI=OFF -DWITH_TCMALLOC=OFF -DWITH_JEMALLOC=OFF`.

### Build findings

- No package exists on conda-forge or apt (`apt-cache policy scram`: no candidate). It must be built from source.
- Current toolchain fails: GCC 16 with Boost 1.85 and libxml2 2.15 errors on `BOOST_THROW_EXCEPTION_CURRENT_FUNCTION` and a const `xmlErrorPtr`. Pinning Boost 1.78 and libxml2 2.10 works.
- Boost 1.78 still needs one flag, no source edit: `-DCMAKE_CXX_FLAGS=-DBOOST_THROW_EXCEPTION_CURRENT_FUNCTION=BOOST_CURRENT_FUNCTION`.
- The test target needs the Catch v1 header `catch.hpp`, which was not installed; only `bin/scram` was built.
- SCRAM loads its schemas from `<build>/share/scram/*.rng`. The build tree has none, so a symlink `build/share/scram -> src/share` was made. A packaged install needs that layout, plus `LD_LIBRARY_PATH` for `libscram.so`.
- Windows route: the engine runs in WSL. Paths with spaces work when passed as an argument list through `wsl --exec` (no shell); the working path here is `C:\Users\jwncr\Claude Code Test\...`. Some error messages show the path URL-encoded (`%20`), so the adapter must not match on message path text. `\\wsl$` paths were not tested.

## Invocation

```
wsl -d Ubuntu --exec env LD_LIBRARY_PATH=<libs> /root/pra-scram/build/bin/scram \
    --bdd --probability true [--rare-event | --mcub] <input.xml> -o <report.xml>
```

Methods map: exact = `--bdd --probability true`; rare event = `--rare-event`; MCUB = `--mcub`. Input is Open-PSA MEF XML with a `define-fault-tree`, nested connectives and `define-basic-event` with `<float value=.../>`.

## Oracle results (`run_oracles.py`)

13 of 13 numerical oracles pass: probability absolute difference 0 at the frozen `1e-12`, and cut-set membership equal after sorting. This includes the rare-event (0.03) and MCUB (0.029701) variants, the shared-event cases and the single-basic-event top (a basic event can be written as the gate formula directly).

- **`A AND A` / `A OR A` are refused by SCRAM** as written: `DuplicateArgumentError: Duplicate argument A`, exit 1, no report (`runs/pra-aa-as-written`, `runs/pra-oa-as-written`). They pass only after the exporter collapses duplicates to the single reference, as plan 01 already requires. That normalization is therefore mandatory, not optional.
- Native voting: `<atleast min="2">` of three gives 0.028 and the three expected cut sets (matches the AND/OR expansion).

## Failure behaviour (`probes.py`, `runs/probe-summary.json`)

| Input | Exit | Report | Message (abridged) | Map to |
|---|---|---|---|---|
| probability 1.2 or -0.1 | 1 | none | `DomainError Invalid probability value for A` | `E_PROB_RANGE` |
| undefined basic event | 1 | none | `ValidityError ... Undefined basic-event ZZ` | `E_MISSING_REF` |
| gate cycle | 1 | none | `CycleError Detected a cycle in TOP gate: TOP->G2->TOP` | `E_CYCLE` |
| malformed / empty XML | 1 | none | `ParseError ... Premature end of data` / `Document is empty` | engine parse failure, never completed |
| missing input file | 1 | none | `IOError Input file doesn't exist` | input error |
| duplicate argument | 1 | none | `DuplicateArgumentError` | export bug if reached |

Every refusal uses exit 1 and writes no report. Messages are free text, so the adapter should key on exit code plus the exception class name.

## Truncation: the main risk

- A product-order limit silently drops cut sets. With `-l 2` on A AND B AND C, SCRAM exits 0 with `products=0` and a `warning="The set is NULL/Empty."` only because all products were dropped.
- The default limit is 20 and applies with no flag. A 21-input AND exits 0, `products=0`, probability 4.76837e-07 (correct), cut sets empty. A partial drop (some sets kept, some dropped) was not probed and may carry no warning at all.
- In BDD mode the probability stays exact even when the cut sets are dropped; with `--zbdd` the probability went to 0 and the approximation silently became rare-event.
- The report echoes the limit in `calculated-quantity/limits/product-order`, so the adapter can read it. Exit code zero and no warning are therefore insufficient, as plan 02 assumed.
- `--cut-off 0.1` did not drop the 0.02 product in any of BDD, ZBDD or MOCUS (0.02 < 0.1). Its effect is unresolved; do not use it.

## Determinism

Two runs of the same input and settings: raw reports differ by sha256 (`0e15078f4019...` vs `ec9b0f5ea202...`; timestamps and calculation times), and after removing `<time>`, `<calculation-time>` and its children the reports are identical. Non-semantic differences observed: the `<time>` element and the `<performance>` block. Nothing else differed in this one case.

## Hostile XML

- Entity expansion in a DOCTYPE is accepted (exit 0, correct report). SCRAM and libxml2 do not refuse DTDs here.
- An external entity (`file:///etc/hostname`) in a position the schema rejects was refused by schema validation, not by entity prohibition. Whether the entity was resolved is **not established**.
- Conclusion for the design: the app must reject any DOCTYPE/entity input itself before SCRAM sees it. Do not rely on SCRAM.

## Identifiers (probed 2026-10-05)

SCRAM accepted `A` and `a` as two distinct events, letters/digits/underscore, an inner dash, a leading underscore, UTF-8 names and a 201-character name. It refused a leading digit, a leading or trailing dash, a dot (the Open-PSA path separator) and a space with `failed to validate attributes`, and refused an event and gate sharing one name (`RedefinitionError`). A first Unicode probe failed only because the probe wrote its file in the Windows code page; it was redone as UTF-8 and passed. The native ID pattern in `../SCHEMA.md` is the safe intersection. These probes were added after the first spike write-up; `runs/probe-summary.json` has all of them.

## Precision

SCRAM prints probabilities with 6 significant digits (4.76837e-07 for 0.5^21 = 4.768371584e-07). All 13 oracles have 5 or fewer significant digits and matched exactly, but an oracle with more digits would miss a `1e-12` absolute check at the rounding level. No tolerance was changed.

## Decisions (proposed; the user has not approved)

1. **Windows route:** run SCRAM in WSL2 through an argument list (`wsl --exec`), as the OpenMC apps do. A native Windows build was not attempted.
2. **Pin:** SCRAM 0.16.2 at commit `9c9a75ca`, built with Boost 1.78 and libxml2 2.10.4. No newer toolchain works without source changes.
3. **Completeness by construction:** the adapter passes a product-order limit at least equal to the number of distinct basic events (so no product can be dropped) and passes no cut-off, then reads the limit back from the report. Anything else is `truncated` or `failed`, never `completed`.
4. **Exporter:** collapse duplicate inputs on a gate; write a basic-event top as a bare formula (confirmed to work).
5. **Methods:** always pass the method explicitly and read `approximation` back from the report; never rely on `--zbdd` defaults.
6. **Voting:** SCRAM's `atleast` matches the expansion, so import is feasible; the native-gate question stays the user's.
7. **Hostile input:** the app rejects DTD/entities before the engine.
8. **License:** GPL-3.0. Invoking SCRAM as a separate process is the plan; whether and how to redistribute the binary needs a decision (source offer required). Not resolved here.

## Gaps (not done)

- SCRAM's own unit tests were not built or run (missing Catch v1).
- `--cut-off` behaviour unexplained; `\\wsl$` paths and resource limits were not exercised. (Partial truncation, timeout and process-tree kill were exercised later, in TODO item 8, see below.)
- Windows-native build not attempted.
- The pra-trunc oracle row has no frozen expected value yet; the observed behaviour above is evidence for choosing it, not the criterion.
- The Open-PSA subset is documented only by what was used here (fault tree, and/or/atleast, basic events with float probabilities).
- Codex P0 exit review not run (waived by the user, 2026-10-05).

## Added by TODO item 8 (2026-10-05): findings from the headless acceptance run

These came from running the exporter, run manager and parser (`src/core/`) against the independent enumeration oracle (`tests/oracle/`). Evidence is in `tests/engine/` and the saved runs under `runs/` (not committed).

### SCRAM 0.16.2 gives wrong answers for some `atleast` gates (silently)

- **Minimal reproducer:** `TOP = atleast 2 of [C, A, G0, B]` with `G0 = A OR C`, P(A)=0.1, P(B)=0.2, P(C)=0.3. Correct: cut sets {A} and {C}, probability 0.37 (A alone makes both A and G0 true, so 2 of 4). SCRAM reports cut sets {C} and {B} with probability 0.44, exit 0, no warning, in BDD, ZBDD and MOCUS alike. Writing the same logic as an OR of ANDs gives 0.37 in every algorithm.
- **How it was found:** a seeded random tree (seed 110) disagreed with the oracle; it was then shrunk by hand. The oracle's answer was checked by reasoning, and the exported XML was checked against the native model by a separate evaluator, so the discrepancy is in the engine.
- **How common:** of 70 random trees containing voting gates, native `atleast` was wrong in 1 (all 70 right when written as OR of ANDs). Among 160 trees whose voting gates have only basic-event inputs (with those events reused elsewhere), native `atleast` was right in all 160. Other shapes tried (voting over gates with disjoint or overlapping supports) were right. The trigger was not fully characterised; the only failing shape found has an input gate that is implied by two other inputs of the same voting gate.
- **Consequence:** the exporter writes `atleast` only when every input is a distinct basic event (`voting: 'auto'`) and otherwise expands to OR of ANDs. A voting gate that would expand past 2000 terms is refused (`E_EXPORT_LIMIT`). A test pins the defect, so a SCRAM upgrade that fixes it makes the test fail and prompts a review of the rule.
- **Not reported upstream.** The upstream project's last push was 2023, and I have not checked whether the defect is already known.

### Other engine behaviour seen in the same work

- Probabilities of exactly 0 and 1 are accepted and the cut sets stay structural (an AND with a 0 event still lists the cut set, with probability 0).
- A rare-event sum above 1 is **clamped to 1** with only the warning "Probability may have been adjusted to 1.". The printed value is not the method's value. The result record (decided 2026-10-05) is a completed result that keeps the bound 1 as `top_event_probability`, carries the method's own value recomputed from the cut sets in `approximation_value`, and labels it with the caveat `approximation-exceeds-1`; a printed value other than the clamp is still a failure. MCUB with an event of probability 1 also prints the warning although the value is exactly 1; the recomputation tells the two cases apart (no caveat when the value is not above 1).
- A product-order limit of at least the number of events cannot drop a cut set; the default limit of 20 does drop a 21-event cut set silently (confirmed again: with the limit raised to 21 the cut set is kept).
- Arguments containing spaces, quotes, backslashes, `$()`, backticks, `;` and `*` reach a program started with `wsl.exe --exec` unchanged (tested with `printf`).
- Cancel and timeout: killing the Windows process alone is not enough. The run manager kills the Linux processes by a unique run-directory path in their arguments (regex-escaped, since `pkill -f` takes a regular expression). Tested: the owned `timeout` wrapper and its child both end, an unrelated process survives, and a tag containing `( ) [ ] + .` works.
