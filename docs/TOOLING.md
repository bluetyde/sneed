# Tooling and ecosystem survey

What this app will use, may use, and must check. Written 2026-10-03. **Nothing in sections 2 and 3 has been verified in this session: no engine is installed and no external page was read. Treat it as a list of questions, not facts.**

## 1. Our own context

| Item | Role |
|---|---|
| SEED (`bluetyde/seed`) | Workspace host and the harness this app's adapter plugs into |
| NODAL Studio (`pipe-studio` folder) | Source of component IDs for optional links; stack and renderer decision to compare |
| Virtual Reactor (RAFT) | Scenario source/target; pattern for `schema/` and validation plans |
| OpenMC Studio | Ribbon look to follow; no data exchange planned |

## 2. External tools, with the question to answer in P0

| Tool | Listed source | Question |
|---|---|---|
| SCRAM (fault-tree and event-tree analysis engine) | https://github.com/rakhimov/scram , docs https://scram-pra.org/ (listed 2026-09-30) | Release, license (believed copyleft; **verify**), Windows build, Open-PSA subset, probability methods, report format, limits |
| Open-PSA Model Exchange Format | Documented by the Open-PSA initiative | Which constructs the native model can map; which to refuse |
| XML parser with entity expansion disabled | Chosen with the stack | Safe-by-default setting and a test with a hostile file |
| JSON Schema validator | Chosen with the stack | Draft support, error codes, size |
| Drawing library or SVG approach | Chosen after the editor spike | Accessibility, layout of trees with repeated references |
| Other open fault-tree tools | To survey | What they teach well; what they lack (prior art for the "why" table) |

## 3. Candidates to survey (unchecked)

- Existing PRA teaching tools and course material (for lesson design, not code).
- Property-testing libraries for the brute-force enumeration oracle.
- A tidy-tree layout algorithm suitable for repeated references.

## 3a. Format and data ecosystem (checked 2026-10-05)

Evidence level: web search summaries plus one primary fetch (the Open-PSA `mef` repository page, which lists no tools and shows no license). Paper claims were **not read in full**. Treat "claimed" as a lead, not a fact.

| Item | Claimed | Evidence | Verdict |
|---|---|---|---|
| SCRAM, XFTA | Implement Open-PSA MEF | SCRAM: run in the P0 spike. XFTA: search summaries of benchmark papers comparing XFTA and SCRAM on the same generated trees | SCRAM verified. XFTA is a candidate second engine for cross-checks (differential testing, not translation); not run |
| RiskSpectrum | Made efforts to follow MEF; a validation project exported a RiskSpectrum model to MEF and re-imported it through an IMDR-XML application | [Validation of the Open PSA format (PDF)](https://woody.com/wp-content/uploads/sites/35/2010/12/Validation_of_the_Open_PSA_Model_Exchange_Format.pdf), summary only | Unverified for current versions; commercial |
| SAPHIRE, CAFTA | Do **not** natively support MEF; have their own model formats. A SAPHIRE-to-Open-PSA converter and a SAPHIRE/CAFTA model exchange methodology were published | Search results listing the titles ([SAPHIRE to Open-PSA converter](https://www.researchgate.net/publication/391672556_Facilitating_PRA_Model_Accessibility_Model_Converter_Utility_from_SAPHIRE_to_Open-PSA), [SAPHIRE/CAFTA exchange](https://www.researchgate.net/publication/372680139_Model_Exchange_Methodology_Between_Probabilistic_Risk_Assessment_Tools_SAPHIRE_and_CAFTA_Case_Study)); not read | Lead only: plant-tool models reach MEF through converters, not native export |
| RiskA, OpenPRA | Made efforts to follow MEF | Search summaries | Unverified |
| NUREG/CR-6928 and its updates (INL/EXT-21-65055, data 2006 to 2020) | Industry-average component failure probabilities, rates and initiating-event frequencies | The report PDF at nrcoe.inl.gov was fetched but its text was not extractable, so contents and any copyright or distribution note are **unconfirmed** | Candidate data library for lessons; read the report and its terms before use |
| Open-PSA `mef` repository | Specification source (https://github.com/open-psa/mef) | Fetched: no license shown, no tool list, no version stated on that page | Find the MEF version and license from the specification itself before claiming conformance |

Conclusions that follow only from the above, and nothing more:

- Native model to MEF is the right primary translation. Importing plant-tool models would go through a third-party converter and would hit constructs outside the documented subset, so it is not v1.
- An independent solver (XFTA) and our own enumerator are better cross-checks than any file converter.
- T-H coupling and data libraries are not translations of a file format; they are tracked in the TODO under P4.

## 4. How to refresh this survey

For each item: record the date; read the license file, latest release and activity (with `gh` if available); read the part of the documentation that answers the question; write a two-line verdict (use, learn from, ignore) with the evidence. Do not copy a claim into PLAN.md until it has a date and a source here. Pin versions in the P0 decision record.

## 5. Decisions already made

Use an existing engine rather than writing one (SCRAM, run in WSL2 through an argument list, fetched and built from the pinned source by SEED's installer using a recipe this app publishes, never bundled; decided 2026-10-05); keep the native model authoritative; Open-PSA for a documented subset; no engine bundled until its license is recorded.
