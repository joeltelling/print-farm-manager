---
name: ship
description: Finishing pass for any Print Farm Manager change. Runs tests, syncs docs and CHANGELOG, checks sync pairs, verifies dash-free prose, and commits in house style. Use when a change is functionally done and needs to be landed properly.
---

# Ship a Change

The change is written; this skill makes it landable. Work through every phase. Do not skip a phase because the change "is small": the small changes are the ones that skip docs.

## Phase 1: Inventory the change

1. `git status` and `git diff` (plus `git diff --staged` if anything is staged). Build a mental list of every touched file and what changed in it.
2. If the diff contains changes you did not make and cannot explain, stop and ask Joel before proceeding. Never sweep unknown edits into a commit.
3. Classify the change: bug fix, feature, endpoint change, driver work, client-only, docs-only. This decides which quality bar in CLAUDE.md applies.

## Phase 2: Sync pairs

Check the "Sync pairs" table in CLAUDE.md against the touched files. Concretely:

- Touched scheduler eligibility SQL? Check `routes/parts.js` dispatch-status mirrors it.
- Added a table or column? Check `server/routes/backup.js` handles it in export and restore, and `server/tests/backup-restore.test.js` seeds and asserts it.
- Touched a route's request or response shape? Check `docs/api.md` and the route's test.
- Touched driver registration anywhere? Check all six touchpoints (see /add-connector).
- Touched install steps in one of README.md / docs/installation.md? Check the other.

Fix any drift now, as part of this change.

## Phase 3: Tests

1. Run `npm test`. The full suite must pass: no new skips, no "unrelated" failures waved through. If a failure is genuinely pre-existing, verify with `git stash && npm test && git stash pop` and report it to Joel with the exact output rather than papering over it.
2. Does the change have its own test?
   - Bug fix: there must be a regression test that fails without the fix. If missing, write it now (in-memory SQLite, factory-mounted route, supertest; transport-mocked for drivers).
   - New endpoint: success + validation failure + not-found cases.
   - Behavior change: the old asserted behavior must be updated intentionally, not deleted to make the suite pass.
3. If any client file changed: `npm run build` must succeed.

## Phase 4: Docs

1. Update the relevant component doc in docs/ (server.md, database.md, api.md, poller.md, web-app.md, multi-brand.md, filaments.md, installation.md). Match the existing format exactly: database.md uses full DDL blocks with aligned inline comments; api.md uses `### VERB /path` headings with fenced JSON examples and status-code prose.
2. Prepend a docs/CHANGELOG.md entry at the top (below the `# Changelog` heading and rule):

   ```markdown
   ## YYYY-MM-DD: short imperative title

   One or more paragraphs: what changed and why. For bug fixes, name the
   real-world trigger ("Hit on a real farm machine after ..."). Mention new
   dependencies or configuration.

   ### Changes
   - `path/to/file.js`: what changed there.
   - `docs/whatever.md`: documented X.
   ```

   Use today's real date. Use a colon after the date, not a dash (the heading style is being standardized dash-free going forward).
3. If a new docs/ file was created, add its row to the docs/README.md index table.
4. If the change affects install or first-run behavior, update README.md and docs/installation.md. These serve strangers now; steps must be copy-pasteable and complete.

## Phase 5: Dash check

Run the check on every changed file that contains prose (docs, comments, UI strings, commit message draft):

```bash
git diff HEAD --unified=0 | grep -Pn '^\+.*[\x{2013}\x{2014}]'
```

Any hit on a line you added must be rewritten with a comma, colon, parentheses, or plain hyphen. Legacy dashes on untouched lines stay.

## Phase 6: Commit

1. Stage exactly the files that belong to this change. Never `git add -A` blindly; check for strays (scratch files, `server/gcode/` test artifacts, `server/data/`).
2. Message format:

   ```
   type(scope): imperative summary under 72 chars

   Body: why the change was needed and anything non-obvious about how.
   Real-world context beats restating the diff.

   Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
   ```

   Types in use: `feat`, `fix`, `docs`, `chore`, `test`, `ci`. Scope is the module (`scheduler`, `bambu`, `client`, `backup`, `update.bat`).
3. One concern per commit. If the diff contains two unrelated changes, split them.
4. Commit to a branch if on `main` and the change is more than trivial, unless Joel said to commit straight to main. Do not push unless asked.

## Phase 7: Report

Summarize for Joel in this order: what shipped, test results (suite count and pass state), which docs were updated, anything flagged (pre-existing failures, assumptions, unvalidated hardware behavior, sync pairs you had to fix). If hardware validation is pending, say so explicitly.
