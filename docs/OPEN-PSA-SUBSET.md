# Open-PSA subset and export mapping (proven by the P0 spike)

Status: **documented from evidence**, 2026-10-05; the importer (`src/core/import.ts`) was built 2026-10-06 from the import rules below. Every construct below was run through SCRAM 0.16.2 (commit `9c9a75ca`) in `../docs/spike/`; anything not listed is outside the subset. The Open-PSA specification itself was not read in this work (its repository page was fetched and shows no version or license), so this is a statement about what the engine accepted, not about the standard.

## Supported constructs

| Construct | Form | Evidence |
|---|---|---|
| Root | `<opsa-mef>` | all inputs |
| Fault tree | `<define-fault-tree name="FT">` containing gates and basic events | all inputs |
| Gate | `<define-gate name="X">formula</define-gate>` | all inputs |
| AND, OR | `<and>`/`<or>` over references, 2 or more distinct arguments | oracle set |
| Nested formula | a connective directly inside another | pra-shared, pra-pump3-* |
| Voting | `<atleast min="k">`, 2 <= k < N, distinct arguments, **only when every argument is a distinct basic event** (see the defect note under export rule 4) | native-atleast-2of3, the boundary probes, and 160 random pure-event voting trees |
| References | `<basic-event name="A"/>`, `<gate name="G"/>` | oracle set, cycle probe |
| Basic event | `<define-basic-event name="A"><float value="0.1"/></define-basic-event>` | all inputs |
| Basic-event top | a gate whose formula is just `<basic-event name="P"/>` (pass-through) | pra-pump1: probability 0.1, cut set {P} |

## Export rules (native model to XML)

1. Identifiers are written unchanged. Native IDs already match SCRAM's accepted names ([SCHEMA.md](SCHEMA.md)), so no renaming or mapping table is needed.
2. Deduplicate repeated inputs on an `and`/`or` gate: SCRAM refuses duplicates (`DuplicateArgumentError`). A gate left with one distinct input is replaced by that input wherever it is used. Never create a second copy of an event.
3. A basic-event top is exported as a wrapper gate with a bare-reference formula. The wrapper's name must not collide with any native ID (append a suffix until unique) and the mapping is recorded; the wrapper never appears in results or cut sets (it did not in the pra-pump1 report).
4. **Voting gates.** SCRAM 0.16.2's `atleast` returns wrong cut sets for some shapes with no warning (reproducer and evidence in [spike/README.md](spike/README.md)). The exporter therefore writes `<atleast>` only when every input is a distinct basic event; otherwise, and also when two inputs resolve to the same reference, it writes an OR over the k-combinations of inputs, each combination an AND of its distinct references. A voting gate that would expand to more than 2000 terms is refused with `E_EXPORT_LIMIT`. Duplicate inputs on a native voting gate are still refused by validation (`E_VOTE_DUP`); duplicates that appear only after collapsing are handled by the rewrite.
5. Probabilities are written with enough digits to round-trip a double. SCRAM's *report* prints about 6 significant digits, so comparisons use the frozen tolerances only for oracle values with up to that many digits.
6. One fault tree, one top gate, no unreferenced gates in the export (unreachable native definitions are dropped from the XML and kept in the native file). Not yet verified: how SCRAM chooses the top when several unreferenced gates exist, so export a single top only.
7. Analysis flags are always explicit: `--bdd --probability true`, plus `--rare-event` or `--mcub` for those methods, and a product-order limit not below the number of distinct basic events. Never pass `--cut-off` (its effect was not understood) or rely on `--zbdd` defaults (they silently chose rare-event).

## Import rules

Accept exactly the table above, with these checks: no DOCTYPE or entity declarations (SCRAM accepted entity expansion, so the app must refuse it itself before the engine sees the file), `min` an integer within range, probabilities in [0, 1], identifiers matching the native pattern or refused with `E_ID_FORMAT` naming the identifier. Anything else raises `E_UNSUPPORTED` naming the construct and line, and the original file is stored unchanged beside the model.

Known outside the subset (not tested for acceptance, only listed as refused by policy): event trees and sequences, common-cause groups, parameters and expressions other than a literal float, `not`/`xor`/`nand`/`nor`/`null` connectives, house events, components, labels and attributes, external libraries (`--allow-extern`), time-dependent or distribution-valued probabilities. SCRAM may accept several of these; the app refuses them because their semantics are not in V1.

### How the importer reads a file (2026-10-06)

- **Scanner.** A small strict scanner written for this subset, not a general XML parser. Refused as `E_XML`: a DOCTYPE or any `<!` declaration, CDATA, any processing instruction other than the XML declaration, any entity but the five predefined ones and numeric references, duplicate attributes, unquoted values, mismatched tags, text outside the root, a second root. Limits (`E_IMPORT_LIMIT`): 2 MB, depth 128, 100,000 elements, 16 attributes per element, 1000 characters per value, 200 per name. Every element has a line and column.
- **Accepted beyond the table.** Basic events may sit in `<model-data>` as well as in the fault tree (what SCRAM-style files usually do); `<event name>` is accepted as a reference; `xmlns`, `xsi:` and `version` attributes on the root; comments.
- **Meaning.** A nested connective becomes a generated gate named `<gate>_<n>` (never colliding with a defined name) and the import notes say so. A pass-through gate (a formula that is only a reference) is replaced by its target wherever it is used, chains included; a top that is a pass-through to an event is a basic-event top. The top is the one gate no other gate refers to: none is `E_NO_TOP`, several are `E_UNSUPPORTED` ("several top gates", listed with their lines). A file with no gates and exactly one basic event has that event as its top.
- **Errors.** Every problem found is returned (up to 50) with its line: `E_XML`, `E_IMPORT_LIMIT`, `E_UNSUPPORTED` (with the construct), `E_ID_FORMAT`, `E_DUP_ID`, `E_PROB_RANGE`, `E_MISSING_REF`, `E_NO_TOP`, `E_CYCLE`, `E_GATE_ARITY`, `E_VOTE_RANGE`, `E_VOTE_DUP`. The result is then checked by the same validator as every other model.
- **Stored.** `POST /api/import` writes `<name>.json`, the original `<name>.opsa.xml` byte for byte and `<name>.opsa-import.log` (importer version, source sha256, notes), the model last; an existing model is never replaced.
- **Tested.** Round trip with the exporter on the oracle models and 1500 random trees (logic equal to exhaustive enumeration), hostile files, 5000 seeded mutations, and a found-by-test infinite loop on pass-through gates that refer to each other (fixed). Mutation checks of the importer are NOT yet written.

## Result reading

From the report: `results/sum-of-products` (`probability`, one `product` per cut set with `order` and `probability`, its `basic-event` names), the `warning` attribute, `information/software` (name, version), and `calculated-quantity` entries (`approximation` for the probability method, `limits/product-order`). A report is a result only after the completeness rules in [plan 02](plans/02-engine-and-adapter.md#lifecycle-and-completeness-contract) pass; a missing, unparsable or inconsistent report is a failure, and an echoed product-order limit below the event count is `truncated`.
