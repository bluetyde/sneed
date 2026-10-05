# Third-party notices

SNEED is MIT licensed (see [LICENSE](LICENSE)). It uses the software below. Licenses were read from the installed packages or from the SCRAM source on 2026-10-05; they were not independently audited.

## Run-time dependencies (npm)

| Package | Version | License | Use |
|---|---|---|---|
| ajv | 8.20.0 | MIT | JSON Schema validation of native models and runtime recipes |
| fast-xml-parser | 5.11.2 | MIT | Reading the engine's XML report (with entities and DTDs refused before parsing) |

## Development dependencies (npm)

| Package | Version | License |
|---|---|---|
| typescript | 5.9.3 | Apache-2.0 |
| vitest | 5.0.3 | MIT |
| tsx | 4.23.15 | MIT |
| vite | 8.3.2 | MIT |
| @playwright/test | 1.63.0 | Apache-2.0 |
| axe-core | 4.13.0 | MPL-2.0 (used only to audit accessibility in the tests; not distributed with the app) |
| @types/node | 24.19.1 | MIT |

Their own dependencies carry their own licenses (see `package-lock.json`).

## SCRAM (analysis engine): not part of this repository, not bundled

| | |
|---|---|
| Software | SCRAM 0.16.2, https://github.com/rakhimov/scram |
| Pinned commit | `9c9a75ca0c5c2fbb5b4a7d32e29fd25bf90f7bab` |
| License | GPL-3.0-or-later: the `LICENSE` file is the GNU GPL v3 text and all 66 source files carry the "version 3 ... or (at your option) any later version" header |
| How SNEED uses it | Started as a separate process. It is built on the user's own machine from the pinned commit by the recipe in [runtime/](runtime/README.md) (run by `npm run runtime -- install`, or by SEED's installer). SNEED does not contain, copy or link SCRAM code. |
| Obligations | Nothing is distributed by building locally. If a built SCRAM binary were ever shipped or cached for other people, the corresponding source (the pinned commit) and the recipe would have to accompany it. That case has not been reviewed by anyone qualified. |

## Build toolchain installed by the recipe (not part of this repository)

The recipe installs 48 conda-forge packages (GCC 11 toolchain, CMake, Ninja, Boost 1.78, libxml2 2.10 and their dependencies) into the runtime directory to compile SCRAM. They are listed with sha256 hashes in [runtime/scram-toolchain.linux-64.lock](runtime/scram-toolchain.linux-64.lock). Each carries its own license (for example Boost under the Boost Software License, libxml2 under MIT, GCC runtime libraries under GPL-3.0 with the GCC runtime library exception). They were not individually audited, and none is redistributed by this repository.

## Open-PSA Model Exchange Format

SNEED reads and writes a documented subset of the Open-PSA MEF XML format as an interchange format ([docs/OPEN-PSA-SUBSET.md](docs/OPEN-PSA-SUBSET.md)). No Open-PSA specification text or schema is copied into this repository.
