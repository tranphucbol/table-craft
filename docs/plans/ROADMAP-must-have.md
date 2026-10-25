# Roadmap: the must-have release

Status: in progress. Coordinated from the main checkout; every plan is implemented by its own
OpenChamber session in its own worktree on its own `feature/…` branch. Scope is decision 069.

## Scope

The user asked for gap-review items Must-have 1–4 and every Should-have item:

- Must-have: SSH tunnel (036), SSL/TLS certificate files (037), SQL files on disk (041), error
  location in the editor (042).
- Should-have: sessions and processes view (045), run a routine with arguments (046), users, roles
  and grants (047), triggers and events (048), startup SQL and isolation level (038), grid helpers
  (043), custom keyboard shortcuts (044), export/import of data source definitions (040, importing
  from DataGrip is plan 035, already in flight), dump and restore (039), Run All past errors (042).

The user's words that override any plan: "you must live test and record evidence for them too", and
"after implementing done for a feature, you must rebase with main then merge it" (the coordinator
does the merge, below).

## Tracks

At most three sessions run at once. Plans in a track run in order; the next plan in a track is
dispatched as soon as its predecessor is merged.

| Track                 | 1                     | 2                    | 3                           | 4                     | 5                             |
| --------------------- | --------------------- | -------------------- | --------------------------- | --------------------- | ----------------------------- |
| A — connection        | 036 SSH tunnel        | 037 SSL certificates | 038 startup SQL & isolation | 039 dump & restore    | 040 export/import datasources |
| B — console & grid    | 041 SQL files on disk | 042 error location   | 043 grid helpers            | 044 custom shortcuts  |                               |
| C — explorer & server | 045 sessions view     | 046 run routine      | 047 users, roles, grants    | 048 triggers & events |                               |

**Gate, plan 049 (cut agent token burn):** the user ruled that 049 lands before any further plan is
dispatched. Its engine and protocol split conflicts with every open branch, so it runs alone,
between waves: 037, 042 and 046 finish and merge, then 049's Phases 1–4 run on that main and
merge, and only then do 038, 043 and 047 start (they are the "after" sessions 049 measures).
049's Phase 0 (`scripts/agent-cost/`, baseline) touches nothing else and runs early. Plan 050
(Bun 1.4.4) is under the same gate: it lands before 038, 043 and 047 are dispatched, and runs as
soon as a slot is free since it touches no engine code. Plan 051 (fast headless suite) is under
the same gate too (the user, 2026-10-25): it runs now in the third slot, touches only test
infrastructure (compose, headless runner, harness, Vitest config), and 038, 043 and 047 wait
until 049, 050 and 051 have all merged.

**Paused, tracks A–C (the user, 2026-10-25):** do not dispatch 038, 043, 047 or anything after
them until the user orders it, even once 050 and 051 merge. Plan 052 (MySQL and TiDB function
completion with signatures and parameter hints) goes first, in the free slot beside 050 and 051.

Why this order:

- 037 after 036: both add sections to the Data Sources dialog and both reshape the options a plugin
  hands its driver.
- 038 after 037: also a Data Sources dialog section, and it runs SQL in the connect funnel 036 wraps.
- 039 after 036–038: `pg_dump` and `mysqldump` must go through the SSH tunnel, the certificates and
  the startup options, so it needs all three.
- 040 after 039 **and after plan 035 merges**: it reuses 035's import dialog and writes every field
  036–038 add.
- 042 after 041: both change the console editor and its tab model; 042's Run All continue also
  applies to 041's Run SQL Script.
- 043 after 042: both touch the result area's status and toolbar.
- 044 last in B: the Keymap page lists every action, so it should land after the others add theirs.
- 046, 047, 048 after 045: all change plugin introspection, `explorerTree.ts` and the `DatabasePane`
  menus; serialising avoids three sessions rewriting the same files.

## Reserved numbers

| Plan | Branch                                 | Worktree                  | Decisions | Compose project / PG / MySQL / TiDB port                    |
| ---- | -------------------------------------- | ------------------------- | --------- | ----------------------------------------------------------- |
| 036  | `feature/036-ssh-tunnel`               | `036-ssh-tunnel`          | 070–071   | `tc-d` / 59432 / 57306 / 54004                              |
| 037  | `feature/037-ssl-certificates`         | `037-ssl-certificates`    | 072–073   | `tc-d` / 59432 / 57306 / 54004                              |
| 038  | `feature/038-startup-sql-isolation`    | `038-startup-isolation`   | 074–075   | `tc-d` / 59432 / 57306 / 54004                              |
| 039  | `feature/039-dump-restore`             | `039-dump-restore`        | 076–077   | `tc-d` / 59432 / 57306 / 54004                              |
| 040  | `feature/040-datasource-export-import` | `040-datasource-export`   | 078–079   | `tc-d` / 59432 / 57306 / 54004                              |
| 041  | `feature/041-sql-files`                | `041-sql-files`           | 080–081   | `tc-e` / 60432 / 58306 / 54005                              |
| 042  | `feature/042-error-location`           | `042-error-location`      | 082–083   | `tc-e` / 60432 / 58306 / 54005                              |
| 043  | `feature/043-grid-helpers`             | `043-grid-helpers`        | 084–085   | `tc-e` / 60432 / 58306 / 54005                              |
| 044  | `feature/044-custom-shortcuts`         | `044-custom-shortcuts`    | 086–087   | `tc-e` / 60432 / 58306 / 54005                              |
| 045  | `feature/045-sessions-view`            | `045-sessions-view`       | 088–089   | `tc-f` / 61432 / 59306 / 54006                              |
| 046  | `feature/046-run-routine`              | `046-run-routine`         | 090–091   | `tc-f` / 61432 / 59306 / 54006                              |
| 047  | `feature/047-users-roles-grants`       | `047-users-roles`         | 092–093   | `tc-f` / 61432 / 59306 / 54006                              |
| 048  | `feature/048-triggers-events`          | `048-triggers-events`     | 094–095   | `tc-f` / 61432 / 59306 / 54006                              |
| 049  | `feature/049-cut-agent-token-burn`     | `049-agent-token-burn`    | 091       | `tc-g` / 62432 / 60306 / 54007, SSH 2207                    |
| 050  | `feature/050-bun-1-4-4`                | `050-bun-1-4-4`           | none      | `tc-h` / 63432 / 61306 / 54008, SSH 2208                    |
| 051  | `feature/051-fast-headless-suite`      | `051-fast-headless-suite` | 096       | `tc-i` / 64432 / 62306 / 54009, SSH 2209, TLS 64433 / 62307 |
| 052  | `feature/052-function-completion`      | `052-function-completion` | 097–098   | `tc-l` / 65432 / 63306 / 54010, SSH 2210, TLS 65433 / 63307 |

Every `test:db`, `test:smoke:db`, `test:smoke:db:headless` and `docker compose` command in a
worktree is prefixed with its row's
`COMPOSE_PROJECT_NAME=… TABLE_CRAFT_PG_PORT=… TABLE_CRAFT_MYSQL_PORT=… TABLE_CRAFT_TIDB_PORT=…`.
A plan that adds a compose service (036's SSH server, 037's TLS servers) adds a port variable for it
with a default, and states the per-track port in its plan: track A uses 2204 for SSH and
59433 / 57307 for the TLS servers. Since 036 every track also sets `TABLE_CRAFT_SSH_PORT`
(A 2204, B 2205, C 2206), because `test:db` starts the `ssh` bastion. Since 037 every track also
sets `TABLE_CRAFT_PG_TLS_PORT` / `TABLE_CRAFT_MYSQL_TLS_PORT` (A 59433/57307, B 60433/58307,
C 61433/59307, 049 62433/60307, 050 63433/61307). `docker compose -p <project> down` when the plan
is done.
Unused decision numbers stay unused. Decision 067–068 belong to plan 035.

## Plugin API version

Several plans change the contract. Each bumps `API_VERSION` (and the built-in manifests'
`apiVersion`) one minor above whatever `main` holds when it **merges**. A rebase conflict on it is
resolved by taking `main`'s value plus one minor.

## Protocol for each session

1. Copy its plan from the main checkout (`<main checkout>/docs/plans/`)
   into the worktree's `docs/plans/` (untracked, decision 035). Read `AGENTS.md`, the plan, the
   decisions it names and `test/e2e/harness.ts`. Copy the main checkout's `.env` too
   (`cp <main checkout>/.env .env`, git-ignored, never committed) so
   the TiDB suites use the remote QC server. Run `bun install` in the worktree.
2. Map first: one `explore` subagent with the brief from `AGENTS.md`, then read the files it
   names, each one whole. The plan is a coordinator's brief. Refine it in place before Phase 0:
   cite `file.ts:line` for every claim, settle anything left to the implementer, write the test
   names. A ruling in the brief may be changed only with the reason recorded under Deviations.
   Then implement phase by phase, each green.
3. Live test per the plan, against every database it touches, with
   `TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/NNN`, in the headless box
   (`bun run test:smoke:db:headless <files>`, decision 063) so nothing takes the user's screen; only
   macOS-only behaviour runs on the host. Inspect every PNG. Fix what it finds, with a regression
   test. Fill in the plan's Live test table.
4. Lint, format:check, typecheck, test, test:db, test:smoke:headless and test:smoke:db:headless all
   green.
5. `git fetch && git rebase origin/main`, re-run the checks, commit (small commits, imperative
   subject lines like the existing history), `git push -u origin <branch>`. **Do not merge to
   `main`** — the coordinator merges.
6. Copy the finished plan and `docs/evidence/NNN/` back to the main checkout's `docs/plans/` and
   `docs/evidence/NNN/`. `docker compose -p <project> down`.
7. Final answer (it is returned to the coordinator): branch, commits, checks with counts, evidence
   list, decisions written, `API_VERSION` taken, deviations, and risks for the next plan in the
   track.

## TiDB: the shared QC server (main `aee9f38`)

The emulated TiDB container is heavy. Since `aee9f38`, `test/db/up.ts`, the headless runner and
the Vitest global setup use the shared QC TiDB (v4.0.14, the same version as the image) named
in the main checkout's git-ignored `.env` (`TABLE_CRAFT_TIDB_REMOTE_*`; linked worktrees read the
main checkout's) whenever it answers, and start the container only when it does not. Rules for
every plan:

- Rebase on `origin/main` first to pick this up; then `docker compose -p <project> stop tidb`, so
  your track's old TiDB container stops (compose no longer starts it unless `--profile tidb`).
- Prefer the remote TiDB, always. Never pass `--profile tidb`, never `docker compose up tidb`, and
  never start a TiDB container by hand; go through `bun run test:db`, `bun test/db/up.ts` or the
  headless runner, which pick the remote. Running `vitest` directly on a TiDB suite still works:
  the global setup resolves the remote. If the log says `TiDB: local container` while `.env` is
  present, the remote did not answer: say so in your report rather than leaving the container
  running, and `docker compose -p <project> stop tidb` when the run ends.
- Never hard-code the `test` database or a fixed database name for TiDB: use `TIDB_DATABASE` (the
  run's own `tc_run_*` database, created and dropped by `test/support/tidbScratch.ts`) and
  `tidbScratchDatabase(suffix)` for any other database a test creates.
- Never write to, read rows from, or drop anything the run did not create; never create users or
  roles except named after `TIDB_DATABASE` and dropped in cleanup; never kill or cancel a session
  the test did not open itself (the server is shared with other people). Plan 045 terminates only
  its own sessions on TiDB; plan 047 skips user/role writes on TiDB unless named as above; plan
  039 dumps and restores only a scratch database.

## Merging (coordinator)

When a session reports done, the coordinator, in the main checkout: fetches, rebases the feature
branch onto `origin/main` (resolving `API_VERSION`, decision index, spec and README conflicts),
runs lint, format:check, typecheck, test and — when plugins or the contract moved — test:db, then
fast-forwards `main` to the rebased branch, pushes `main` and the rebased branch, and records the
merge below. Only then is the next plan in that track dispatched, from the new `main`.

## Dispatch log

| Plan | Session                          | Worktree                                                                                            | Dispatched                                                                                                                                                                                                                                                                                                         |
| ---- | -------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 036  | `ses_e9251eab9ffe4M2wvyiB8qexJg` | `~/.local/share/opencode/worktree/915303f81a639217122f43f6574741c473f18948/036-ssh-tunnel`          | 2026-10-24                                                                                                                                                                                                                                                                                                         |
| 041  | `ses_e9251d660ffe8PGu7axoZXUvAH` | `~/.local/share/opencode/worktree/915303f81a639217122f43f6574741c473f18948/041-sql-files`           | 2026-10-24                                                                                                                                                                                                                                                                                                         |
| 045  | `ses_e9251c4a4ffee8zbWBqDmFquFM` | `~/.local/share/opencode/worktree/915303f81a639217122f43f6574741c473f18948/045-sessions-view`       | 2026-10-24                                                                                                                                                                                                                                                                                                         |
| 037  | `ses_e91e46351ffe4ff5sNqY5ialxO` | `~/.local/share/opencode/worktree/915303f81a639217122f43f6574741c473f18948/037-ssl-certificates`    | 2026-10-24                                                                                                                                                                                                                                                                                                         |
| 042  | `ses_e91e44e48ffe9dH4CSiFiLdsV9` | `~/.local/share/opencode/worktree/915303f81a639217122f43f6574741c473f18948/042-error-location`      | 2026-10-24                                                                                                                                                                                                                                                                                                         |
| 046  | `ses_e91618f47ffe82xlmcsgV6PJGn` | `~/.local/share/opencode/worktree/915303f81a639217122f43f6574741c473f18948/046-run-routine`         | 2026-10-24                                                                                                                                                                                                                                                                                                         |
| 049  | `ses_e915c9c4affe8Kh75AXJnHkhCo` | `~/.local/share/opencode/worktree/915303f81a639217122f43f6574741c473f18948/049-agent-token-burn`    | 2026-10-24 (Phase 0 done `8e63fa2`, baseline median 418 steps / $19.65; Phases 1–4 after 037/042/046 merge, same session; Phases 1–4 sent 2026-10-25 on `ad5cb34`; main moved to `51063ef` via PR #2, which took decision 089, so 049 takes 091; Phases 1–4 done and pushed as `5907a21` on `51063ef`, not merged) |
| 050  | `ses_e913bf584ffeRqmlgcFi77Q6TT` | `~/.local/share/opencode/worktree/915303f81a639217122f43f6574741c473f18948/050-bun-1-4-4`           | 2026-10-24                                                                                                                                                                                                                                                                                                         |
| 051  | `ses_e90a808cbffe92nnnOgeAu7tXC` | `~/.local/share/opencode/worktree/915303f81a639217122f43f6574741c473f18948/051-fast-headless-suite` | 2026-10-25, from `51063ef`                                                                                                                                                                                                                                                                                         |
| 052  | `ses_e90487dbbffeK1F71SsO4aMNkf` | `~/.local/share/opencode/worktree/915303f81a639217122f43f6574741c473f18948/052-function-completion` | 2026-10-25, from `5907a21`                                                                                                                                                                                                                                                                                         |

## Merge log

| Plan | Merged at | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 036  | `de324f0` | Already on `aee9f38`; fast-forward. API 0.22.0. One flaky `bun run test` run, green on rerun                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 041  | `9799b2f` | Rebased over 036: core index, bridge channels, App effects, decisions index, spec channel table. API 0.23.0; script sessions now open through 036's tunnel connector. test:db 323, headless sqlFiles + sshTunnel 15 green                                                                                                                                                                                                                                                                                                                                                   |
| 045  | `c3cdd89` | Already on `9799b2f`; fast-forward. API 0.24.0. test 1704, test:db 342 green. Then `4e08cf0` fixes the box's misleading "TiDB: local container" line                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 037  | `f3a40a2` | Already on `4e08cf0`; fast-forward. API 0.25.0, decisions 072–073 (amends 067, 070). Session: test 1744, test:db 368, headless 41 + 323 green; coordinator re-ran lint, typecheck. Adds `postgres-tls`/`mysql-tls` compose servers                                                                                                                                                                                                                                                                                                                                          |
| 042  | `3e77346` | Fast-forward. API 0.26.0, decisions 082–083. Coordinator: lint, format, typecheck, test 1811 green                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 046  | `f38af4c` | Rebased over 042 (spec request table). API 0.27.0, decision 090 (091 unused). test 1838, test:db 386 (remote TiDB), headless errorLocation + routine + alignedFormat 20 green. Then `dd12ead`, `ad5cb34` replace borrowed fixture names with neutral `order_events`                                                                                                                                                                                                                                                                                                         |
| 049  | `5907a21` | Already on `51063ef` (PR #2); fast-forward. No API bump, decision 091 (PR #2 took 089). Session: test 1872, test:db 386, headless 47 + 338 green; coordinator re-ran lint, format, typecheck, test 1872. Follow-up: `workflows.smoke` `edit_probe` order on reused Postgres, handed to 051                                                                                                                                                                                                                                                                                  |
| 051  | `3665af6` | Already on `a65b58b`; fast-forward. Decision 096 (amends 063): headless files run `TABLE_CRAFT_SMOKE_WORKERS` at a time (3 on ≥7 GiB reported VM, shared across boxes), `SERIAL_SMOKE_FILES`, seed-hash reseed, trimmed MySQL. Full db headless 24 min/12 failures → 6.5 min/0. Session: test 1898, test:db 386, headless 58 + 349; coordinator re-ran lint, format, typecheck, test 1898. Later sessions: stagger concurrent runs ~45 s, no `down -v`, new table-counting/`orders`-writing smoke files go serial                                                           |
| 052  | `854b89a` | Already on `3665af6`; fast-forward. API 0.28.0, decisions 097 (function specs with server ranges; TiDB stays a MySQL flavour), 098 (signature help answered by the plugin, `completion.signature`). 356 MySQL/TiDB functions (8.4: 327, 5.7: 294, TiDB 4.0.14: 248), ⌘P Parameter Info. Session: test 1948, test:db 390, headless 60 + 359; coordinator re-ran lint, format, typecheck, test 1948. Risks: 038 keep server version reaching the completion catalog; 043/044 ⌘P taken, `editor.parameterInfo` rebindable; 047 add `GRANT … ON` words to the signature scanner |
| 050  | `a65b58b` | Rebased from `51063ef` onto `5907a21`, no conflicts; fast-forward. Bun 1.4.4 pinned in `.bun-version`, Dockerfile and README, box built from `.bun-version`, `toolchain.test.ts`. No API bump, no decision. Session: test 1865, test:db 386, headless 47 + 337 (1 order-dependent `resultSearch.smoke:360` failure, green alone), packaged 5; coordinator re-ran lint, format, typecheck, test 1878. Follow-up: `resultSearch.smoke` row order, handed to 051                                                                                                               |
