---
name: pr-review
description: Review a community pull request against Print Farm Manager's specific failure modes: adjacent-code drift, part-count integrity, driver contract compliance, docs completeness. Use for any GitHub PR from an outside contributor. Takes a PR number as argument.
---

# Review a Community PR

The repo is public and gets real PRs from strangers and regulars. Review them against this repo's rules, not generic lint taste. The standing lesson: the worst bug a community PR ever nearly shipped was NOT in the diff. It was adjacent code the diff made stale (a hardcoded restore column list that silently dropped `serial_number`, `loaded_material`, `loaded_color` after export gained them). Review the neighborhood, not just the diff.

## Phase 1: Context

1. `gh pr view <number>` and `gh pr diff <number>`. Read the description, linked issues, and any prior review threads (`gh pr view <number> --comments`). Do not repeat findings another reviewer already raised; build on them.
2. `gh pr checkout <number>` so you can run and grep the real tree.
3. Identify what kind of PR it is: driver/connector, server logic, client UI, docs, CI, dependency bump. That selects the deep-dive lists below.
4. Check CI state (`gh pr checks <number>`). The test job gates everything; a red suite is an automatic changes-requested.

## Phase 2: Baseline checks (every PR)

- Conventions: synchronous better-sqlite3 (no `await` on DB calls), epoch-ms timestamps, INTEGER booleans, route factory pattern, COALESCE partial updates, static routes before `/:id`, error shape `{ error: '...' }` with correct 400/404/409.
- Windows safety: `path.join`, no bash-only assumptions, `split(/[\\/]/)` when parsing stored filepaths.
- Schema: any migration must be additive (`try/catch ALTER TABLE` in db.js). Anything destructive or framework-shaped is changes-requested.
- Tests: `npm test` locally on the checked-out branch. Then read the new tests and ask: do they seed and assert the NEW tables/fields/behavior, or do they only re-assert what already passed? A test that cannot fail is a finding.
- Docs: component doc updated, dated CHANGELOG entry present in house format. Missing docs is a real finding, not a nitpick (CONTRIBUTING.md requires them).
- New prose dash check on added lines only:
  `gh pr diff <number> | grep -Pn '^\+.*[\x{2013}\x{2014}]'`
- Security (repo is public, app is LAN-only by design): no secrets or real access codes in code, tests, or fixtures; file endpoints validate paths (no traversal); nothing that adds cloud calls or telemetry.
- Dependencies: any new dependency needs strong justification; native modules must build on Windows under Node 22/23.

## Phase 3: Adjacent-code audit

For every file the diff touches, open the WHOLE file and its counterpart in the sync-pairs table (CLAUDE.md "Sync pairs"). Ask: does this change make any unchanged code stale?

Specific known traps:
- server/routes/backup.js: export and restore must handle the same tables and columns. Column lists must derive from the live schema, never hardcoded.
- scheduler.js eligibility SQL vs `routes/parts.js` dispatch-status: the diagnostic must mirror dispatch reality.
- Driver registration: a new brand must hit all six touchpoints (driver file, drivers/index.js, models.js VALID_CONNECTORS, printers.js NO_API_KEY_TYPES if keyless, Settings.jsx brand spots, db.js migration if new fields).
- Duplicated derived-status logic ("awaiting sign-off") across Dashboard/Fleet/Printers: a change to one copy needs all three.

## Phase 4: Deep dives by PR type

**Anything touching jobs, parts, scheduler, set-ready, or backup restore:**
- Trace every path that writes `parts.completed_qty`. For each: what unique real-world event backs it? Can it fire twice across a server restart, a Bambu MQTT reconnect, or an OFFLINE-to-FINISHED flap? Recovery paths must gate on process lifetime (`finished_at > scheduler.startedAt`), never wall-clock windows. Any doubt here is a P1.
- Check hold semantics: nothing may clear `is_held` except operator endpoints and the documented recovered-to-PRINTING path.

**Driver PRs, additionally:**
- Full contract check against docs/driver-authoring.md: four functions, getStatus never throws (OFFLINE on error), canonical statuses only, cancel maps to STOPPED not ERROR, `UPLOAD_CONFLICT` code, no DB access in the driver, module-level Map for persistent state.
- Payloads verified against the official protocol docs (fetch them; do not trust the PR's claims about field formats).
- Hardware evidence: the PR must state what real hardware it was tested on. Mock-only drivers can merge but must be labeled community-maintained/unvalidated in docs, per driver-authoring.md.

**Client PRs, additionally:**
- useToast/useConfirm rules (elements rendered, no window.confirm/alert), background-poll errors swallowed vs mutation errors toasted, refetch-after-mutate, palette hexes copied not invented, 600 px breakpoint respected, `npm run build` passes.

**Dependency-bump PRs (including Dependabot):**
- Read the changelog of the bumped package for breaking changes in the used API surface. Confirm lockfile consistency and that `npm ci && npm test` passes. Never recommend enabling auto-merge.

## Phase 5: Verdict and delivery

1. Rank findings by severity, house style: **[P1]** correctness/data-loss/security (blocks merge), **[P2]** should fix before or shortly after merge, then minor notes. For each finding: file, line, what breaks, and a concrete failure scenario ("restore a backup taken after this PR and loaded_color comes back NULL").
2. Verify each P1 by actually exercising the code where feasible (run the test, hit the route with curl against a dev server, or write a quick throwaway test) rather than reasoning from the diff alone.
3. Deliver as Joel directs: default is a summary to him with a recommended verdict (approve / approve-with-nits / request-changes). Only post to GitHub (`gh pr review`) when he asks.
4. Merge mechanics to remember:
   - docs/CHANGELOG.md prepend conflicts: `.gitattributes` has `merge=union` for it, but GitHub's server-side merge IGNORES that. Resolve locally and push back to the PR branch (regulars leave "allow maintainer edits" on).
   - Squash-merge titles should follow the `type(scope): summary` convention.
5. If the PR is good work, say so specifically. Community goodwill is an asset; regulars like seanlw follow the conventions and deserve fast, substantive reviews.
