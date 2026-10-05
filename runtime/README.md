# runtime/

The SCRAM runtime recipe. It is data; the explanation, the contract mapping and the evidence are in [../docs/RUNTIME.md](../docs/RUNTIME.md).

| File | What it is |
|---|---|
| `scram.recipe.json` | The recipe (schema `../schema/runtime-recipe.schema.json`) |
| `scram-toolchain.linux-64.lock` | Conda explicit lock, sha256 per package, pinned by the recipe |
| `scram-smoke.json` | Native checks that must pass before a build is activated |
| `evidence/` | Install record and manifest from the first real install |

Install into WSL with `npm run runtime -- install` (set `SNEED_RUNTIME_ROOT` and `SNEED_RUNTIME_STATE` from PowerShell, not Git Bash).

Changing any file here means changing the recipe revision: the lock's sha256 and the recipe's own hash are recorded in every installed manifest.
