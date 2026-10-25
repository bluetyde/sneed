# Contributing

Thank you for helping. SNEED is a teaching tool, so a clear change with a checked result is worth more than a large one.

## Set up

1. Install Node.js 24 and npm. The tests do not pass on Node 22.
2. Run `npm ci`.
3. Run `npm run typecheck`.
4. Run `npm test`. This needs no WSL and no SCRAM.

Other test commands:

- `npm run e2e` runs the browser tests in Chrome with Playwright.
- `npm run test:engine` runs the tests that call SCRAM. It needs WSL and an installed SCRAM runtime ([docs/RUNTIME.md](docs/RUNTIME.md)).

## Before you open a pull request

1. Keep the change to one topic.
2. Add or change a test. A new numerical result needs an independent check: a hand calculation or the enumeration oracle in `tests/oracle/`. Do not take the expected value from SNEED's own output.
3. Run `npm run typecheck` and `npm test`. Both must pass.
4. If you change what a screen shows, say so in the pull request.
5. Update [TODO.md](TODO.md) if the change finishes or opens an item. Close an item with evidence: a command and its result.

## Rules that protect the results

- A failed, cancelled, truncated or timed-out run is never shown as a success.
- A result names its method and its assumptions.
- A probability or frequency in an example or a lesson is invented and labelled as invented.
- Do not skip, delete or loosen a test to get a green run. Say what is wrong instead.
- Do not commit a user name, a local path or a credential. `npx tsx scripts/scrub.ts <folder>` checks a folder for these.

## Where things are

- Design: [PLAN.md](PLAN.md) and [docs/plans/](docs/plans/).
- Structure: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- Method (oracles and mutation checks of the tests): [docs/WORKFLOWS.md](docs/WORKFLOWS.md).

## Licence

SNEED is MIT licensed. By sending a change, you agree that it is released under the same licence ([LICENSE](LICENSE)). Do not add code with an incompatible licence. Record any new package in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Conduct

Be polite and stay on the topic. Maintainers may close a thread that is not.
