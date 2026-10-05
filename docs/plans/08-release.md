# Plan 08: Release

Packaging, licensing and the pre-release checklist. Not before P3 is verified.

## Distribution (to decide)

| Option | For | Against |
|---|---|---|
| Source clone plus local server (like the other suite apps today) | No packaging work; SEED can clone and install it | Needs Node/Python and the engine installed |
| Bundled engine in a package | One install | Redistribution terms of the engine must be satisfied; platform builds |
| Engine in WSL or a container with a launcher | Same engine on every OS | Heavier setup on Windows; needs prerequisites |
| Browser-only with no engine | Easiest for students | Cannot analyse without the engine; would need a second implementation (not planned) |

The choice follows the P0 findings on SCRAM's build and license.

## Licensing and provenance

- **Do not bundle SCRAM.** The recipe, installer and evidence are in [../RUNTIME.md](../RUNTIME.md). Decided 2026-10-05 (user): SEED's dedicated installer fetches SCRAM (pinned commit, GPL-3.0) and builds it on the user's machine from a recipe this app publishes; the app only starts it as a separate process. Record the license, source URL, commit and build recipe in `THIRD_PARTY_NOTICES.md`. If a binary is ever shipped or cached for others, corresponding-source obligations must be reviewed first; building locally does not by itself raise them, but that has not been checked with anyone qualified.
- This repo is MIT licensed (decided 2026-10-05, like the other suite apps; `LICENSE`, `THIRD_PARTY_NOTICES.md`). That choice rests on SCRAM being run as a separate process and built on the user's machine, never linked or bundled; if that ever changes, the licensing needs a fresh look.
- Fonts and assets bundled with their licenses; no remote script or font loading.

## Pre-release checklist

1. Fresh-machine install on each supported OS from the documented prerequisites only.
2. All oracle entries pass on the shipped engine version, and the direct-engine parity set passes.
3. Three lessons run end to end in the browser, keyboard only.
4. Harness acceptance: PRA through SEED (workspace) and standalone agree; MCP and direct agree (harness test 9).
5. Security pass: no shell strings, XML entity expansion off, run roots enforced, no command taken from model content.
6. Accessibility pass: keyboard, focus, contrast, screen reader names, 200% zoom.
7. Docs: install guide, student guide, instructor notes, adapter notes, supported Open-PSA subset, assumptions and limits.
8. Educational-use statement in the app, the lessons and the docs; no wording that reads as plant risk.
9. Changelog, tag and release assets; make the repo public only when the user says so.

## Open

- Distribution model (the license is decided: MIT).
- Whether a hosted demo is acceptable (it would need the engine on a server and a decision about user models).
- Update channel and how SEED's installer tracks releases (a catalog entry once a repo exists).
