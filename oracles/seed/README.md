# SEED oracle entries for SNEED

Generated, do not edit: `npm run gen:seed-oracles` rebuilds `entries/` and `models/` from `tests/oracles.json`, the hand-oracle builders in `tests/oracle/models.ts` and the bad-model vectors in `schema/vectors/bad/`. A test (`tests/unit/seed-oracles.test.ts`) fails if these files drift from their sources or from SEED's `seed.oracle/0.1` schema.

SNEED owns its entries (SEED decision D3); SEED pins their hashes and the app commit. Paths in an entry are relative to this folder.

## What is here (14 entries)

- **11 `good` entries**, quantity `top_event_probability`, unit `1`, method exact. Expected values come from hand derivations, with tolerance `abs 1e-12, rel 0` fixed before any engine run. The second method is exhaustive enumeration with exact rational arithmetic (`tests/oracle/enumerate.ts`). A defect that both the hand derivation and the enumerator share would pass; the engine tests also run every model through SCRAM.
- **3 `bad-input` entries**: a probability above 1 (`E_PROB_RANGE`), a gate cycle (`E_CYCLE`) and a gate input that is not defined (`E_MISSING_REF`).

## What is not here, and why

- **Rare-event and min-cut-upper-bound rows** and the **product-order-limit row**: `seed.oracle/0.1` has no field for run settings, so SEED would run them with the default method and get a different number. They stay in `tests/oracles.json`. Needs a settings field in the oracle schema (a SEED decision).
- **Cut sets**: an entry holds one number. Cut sets are checked by SNEED's own tests.
- **Unsupported Open-PSA constructs** (`pra-unsupported`): needs the importer, which is not built.

Coverage is by the shapes of these models (AND, OR, repeated events, shared events, 2-of-3). A model with another shape is `unverified` in SEED even for the same engine.

All values are synthetic. A result is a probability under stated assumptions, not a frequency and not a plant risk figure.
