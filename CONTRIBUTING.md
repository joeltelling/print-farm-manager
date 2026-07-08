# Contributing to Print Farm Manager

Thanks for your interest in improving Print Farm Manager! This project runs real print farms, so the bar is simple: keep it reliable, keep it boring, and never lose an operator's part counts.

## Getting Set Up

You need **Node.js 22 LTS**. Node 24+ has known issues compiling the native SQLite dependency on Windows, so stick with 22.

```bash
git clone https://github.com/joeltelling/print-farm-manager.git
cd print-farm-manager
npm install
cd client && npm install && cd ..
npm run dev
```

- API server: `http://localhost:3000`
- Web UI with hot reload: `http://localhost:5173`

Prefer not to install Node.js locally? `docker compose up --build print-farm-manager-dev` runs the same hot-reload workflow in a container — see the [README](README.md#quick-start-development) for details.

Run the test suite before opening a PR. All tests must pass:

```bash
npm test
```

Using Docker instead? `docker compose exec print-farm-manager-dev npm test`.

## Before You Build Something Big

Open an issue first and describe what you want to build. This project has a deliberate scope and a phased roadmap (see `ARCHITECTURE.md`), and some things that look like missing features are intentional decisions. Examples: there is no authentication (the app is designed for trusted LANs only), and there is no database migration framework. A quick issue conversation can save you a weekend of work on a PR that will not merge.

Small fixes, docs improvements, and bug reports need no advance discussion. Just send them.

## Project Conventions

These are load bearing. PRs that break them will be asked to change, no matter how clean the code is.

- **Database access is synchronous.** All queries use the `better-sqlite3` synchronous API. No `async/await` for database operations, ever. This is a deliberate architectural choice, not an oversight.
- **No migration system.** Schema changes use `CREATE TABLE IF NOT EXISTS` plus additive `ALTER TABLE` wrapped in try/catch. Do not introduce a migration framework.
- **Timestamps are Unix epoch milliseconds** (`Date.now()`), stored as INTEGER.
- **Booleans in SQLite are INTEGER** `0` / `1`.
- **Partial updates use `COALESCE(?, column)`** so that omitting a field leaves the existing value intact.
- **Route modules export a factory** `(db) => router` and are mounted in `server/index.js`.
- **Part counts are sacred.** Any code path that credits `completed_qty` must be impossible to double-trigger. If your change touches job completion, recovery, or operator confirmation, explain in the PR how it avoids double crediting.

## Documentation Is Part of the Change

Every feature or behavior change updates the docs in the same PR:

1. Update the relevant component doc in `docs/` (for example `docs/multi-brand.md` for driver work).
2. Add a dated entry to `docs/CHANGELOG.md` describing what changed and why.
3. If the change affects how someone installs or first uses the app, update `README.md` and `docs/installation.md` too. These are the two files new users actually read.

Look at recent `docs/CHANGELOG.md` entries for the expected style.

## Printer Drivers

Driver PRs get extra scrutiny because most reviewers cannot test them: nobody owns every printer.

Start with the full authoring guide at [docs/driver-authoring.md](docs/driver-authoring.md). It documents the driver contract, the canonical status semantics, the registration checklist, and the hardware test matrix expected in a driver PR. The points below are the summary.

- **State your test hardware in the PR description.** "Validated on a P1S with AMS, firmware 01.07.02" is ideal. "Untested, written from protocol docs" is also acceptable, just say so. What we cannot work with is silence.
- **Work from official protocol documentation**, not guesses. Link the docs or the reverse engineering source you used. Field formats in printer protocols are full of traps (form fields vs. query params, array shapes, unit mismatches), and guessed formats have burned this project before.
- **Implement the shared driver interface**: `getStatus`, `uploadAndPrint`, `cancelJob`, `checkIfPrinting`. See `server/drivers/octoprint.js` for a clean, recent example and `docs/multi-brand.md` for how the pieces fit.
- **Map to canonical statuses** (`IDLE`, `PRINTING`, `PAUSED`, `FINISHED`, `STOPPED`, `ERROR`, `OFFLINE`, `UNKNOWN`). Pay attention to what happens when an operator cancels a print at the printer itself. The poller and scheduler rely on these transitions for the operator sign-off flow.
- **Add driver tests** that mock the network layer. See `server/tests/octoprint-driver.test.js` for the pattern.

## Pull Requests

- Keep PRs small and focused. One concern per PR.
- Commit messages follow the existing style: `feat(scope): ...`, `fix(scope): ...`, `chore(scope): ...`, `docs: ...`.
- Match the surrounding code style. This codebase favors plain, readable JavaScript over cleverness.
- If a UI change is visible, a before/after screenshot in the PR description is appreciated.

## Reporting Bugs

Include your OS, Node version, printer brand and model (if printer related), and the relevant server log output. `pm2 logs print-farm-manager` or `docker compose logs` will get you the logs depending on your install.

## License

By contributing, you agree that your contributions are licensed under the MIT License, the same license as the project.
