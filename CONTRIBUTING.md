# Contributing to Print Farm Manager

Thanks for your interest in improving Print Farm Manager! This project runs real print farms, so the bar is simple: keep it reliable, keep it boring, and never lose an operator's part counts.

This guide is written to work for any copy of the repository. Print Farm Manager was created by Joel Telling at [joeltelling/print-farm-manager](https://github.com/joeltelling/print-farm-manager) and is now continued at [seanlw/print-farm-manager](https://github.com/seanlw/print-farm-manager). If you cloned or forked either of them, everything below applies to your copy too: wherever this guide says "the repository", it means the one you are working in and sending changes to.

## Getting Set Up

You need **Node.js 22 LTS**. Node 24+ has known issues compiling the native SQLite dependency on Windows, so stick with 22.

```bash
git clone https://github.com/<your-account>/print-farm-manager.git   # your fork, or the repository you are working from
cd print-farm-manager
npm install
cd client && npm install && cd ..
npm run dev
```

- API server: `http://localhost:3000`
- Web UI with hot reload: `http://localhost:5173`

Prefer not to install Node.js locally? `docker compose up --build print-farm-manager-dev` runs the same hot-reload workflow in a container. See the [README](README.md#quick-start-development) for details. After you change dependencies, rebuild the image and renew its anonymous volumes (`docker compose up -d --build -V print-farm-manager-dev`), or the container keeps the old `node_modules`.

Set `DEMO_MODE=true` while developing. It skips real printer polling, and `server/seed-demo.js` fills a demo database. This matters if your database was ever restored from a real farm: it still contains real printer addresses, and without `DEMO_MODE` the poller will contact them.

Run the test suite before opening a PR. All tests must pass:

```bash
npm test
```

Using Docker instead? `docker compose run --rm print-farm-manager-dev npm test` (or `docker compose exec print-farm-manager-dev npm test` if the dev container is already running).

There is no automated test suite for the client yet. For UI changes, check them in a browser (with `DEMO_MODE=true`) and say in your PR which pages and interactions you checked.

## Working on a Fork

- **Choose where your changes go.** Send a PR to the repository you want the change in: your own fork's `main`, or another repository you have agreed to contribute to. Nothing in this project assumes a particular upstream.
- **CI runs on your fork.** `.github/workflows/docker-publish.yml` runs the test suite and a Docker build on every pull request. On pushes to `main`, tags, and a nightly schedule it publishes a multi-arch image to `ghcr.io/<your-account>/print-farm-manager`, because the image name follows the repository it runs in. Enable GitHub Actions on your fork and check its package visibility settings if you want that image to be publicly pullable. See [docs/docker-publish.md](docs/docker-publish.md).
- **Turn Dependabot on for your copy.** The repository ships `.github/dependabot.yml` (monthly, grouped updates), but forks do not run Dependabot until you enable it under Settings, Advanced Security. Majors of `better-sqlite3`, the `node` base image, `react`, and `react-dom` are ignored on purpose; the reasons are in that file.
- **Following another repository is optional.** If you want to pull changes from the repository you forked, add it as a second remote (`git remote add upstream <url>`) and merge from it when you choose to. The project does not depend on it.

## Before You Build Something Big

Open an issue first in the repository you plan to send the change to, and describe what you want to build. This project has a deliberate scope (see `ARCHITECTURE.md` for the original spec), and some things that look like missing features are intentional decisions. Examples: there is no authentication (the app is designed for trusted LANs only), and there is no database migration framework. A quick issue conversation can save you a weekend of work on a PR that will not merge.

Small fixes, docs improvements, and bug reports need no advance discussion. Just send them.

## Project Conventions

These are load bearing. PRs that break them will be asked to change, no matter how clean the code is.

- **Database access is synchronous.** All queries use the `better-sqlite3` synchronous API. No `async/await` for database operations, ever. This is a deliberate architectural choice, not an oversight.
- **No migration system.** Schema changes use `CREATE TABLE IF NOT EXISTS` plus additive `ALTER TABLE` wrapped in try/catch. Do not introduce a migration framework. Order matters: new `ALTER TABLE jobs ADD COLUMN` lines must come after the older migration that rebuilds `jobs`, and every schema change should be tried against a brand-new database, not only your long-lived dev one.
- **Timestamps are Unix epoch milliseconds** (`Date.now()`), stored as INTEGER.
- **Booleans in SQLite are INTEGER** `0` / `1`.
- **Partial updates use `COALESCE(?, column)`** so that omitting a field leaves the existing value intact.
- **Route modules export a factory** `(db) => router` and are mounted in `server/index.js`.
- **New UI text goes through i18n, never hardcoded in JSX.** Add a key to `client/src/locales/en.json` (the source of truth for every user-facing string, and the schema every other language file must match) and render it with `t('namespace.key')`. You do not need to translate the other language files yourself, translation is handled separately from feature work. See [docs/TRANSLATING.md](docs/TRANSLATING.md) for the key convention, pluralization, and what belongs in `common.*` versus a page namespace.
- **Part counts are sacred.** Any code path that credits `completed_qty` must be impossible to double-trigger. If your change touches job completion, recovery, or operator confirmation, explain in the PR how it avoids double crediting.

## Documentation Is Part of the Change

Every feature or behavior change updates the docs in the same PR:

1. Update the relevant component doc in `docs/` (for example `docs/multi-brand.md` for driver work).
2. Add a dated entry to `docs/CHANGELOG.md` describing what changed and why.
3. If the change affects how someone installs or first uses the app, update `README.md` and `docs/installation.md` too. These are the two files new users actually read.

Look at recent `docs/CHANGELOG.md` entries for the expected style.

## Printer Drivers

Driver changes get extra scrutiny because most reviewers cannot test them: nobody owns every printer.

Start with the full authoring guide at [docs/driver-authoring.md](docs/driver-authoring.md). It documents the driver contract, the canonical status semantics, the registration checklist, and the hardware test matrix expected in a driver PR. The points below are the summary.

- **State your test hardware in the PR description.** "Validated on a P1S with AMS, firmware 01.07.02" is ideal. "Untested, written from protocol docs" is also acceptable, just say so. What we cannot work with is silence.
- **Work from official protocol documentation**, not guesses. Link the docs or the reverse engineering source you used. Field formats in printer protocols are full of traps (form fields vs. query params, array shapes, unit mismatches), and guessed formats have burned this project before.
- **Implement the shared driver interface**: `getStatus`, `uploadAndPrint`, `cancelJob`, `checkIfPrinting`. See `server/drivers/octoprint.js` for a clean, recent example and `docs/multi-brand.md` for how the pieces fit.
- **Map to canonical statuses** (`IDLE`, `PRINTING`, `PAUSED`, `FINISHED`, `STOPPED`, `ERROR`, `OFFLINE`, `UNKNOWN`). Pay attention to what happens when an operator cancels a print at the printer itself. The poller and scheduler rely on these transitions for the operator sign-off flow.
- **Add driver tests** that mock the network layer. See `server/tests/octoprint-driver.test.js` for the pattern.

## Pull Requests

- Keep PRs small and focused. One concern per PR.
- CI must be green: the `test` job runs the full suite, and the Docker build must succeed on both architectures.
- Commit messages follow the existing style: `feat(scope): ...`, `fix(scope): ...`, `chore(scope): ...`, `docs: ...`.
- Match the surrounding code style. This codebase favors plain, readable JavaScript over cleverness.
- If a UI change is visible, a before/after screenshot in the PR description is appreciated.

## Reporting Bugs

Open an issue in the repository you got the code from. Include your OS, Node version, printer brand and model (if printer related), and the relevant server log output. `pm2 logs print-farm-manager` or `docker compose logs` will get you the logs depending on your install.

## License

By contributing, you agree that your contributions are licensed under the MIT License, the same license as the project.
