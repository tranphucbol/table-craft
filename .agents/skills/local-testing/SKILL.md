---
name: local-testing
description: Run TableCraft's database, smoke and live tests locally and capture a plan's evidence. Covers which suite a change needs, the docker compose database servers and their ports, the remote TiDB in `.env`, parallel worktrees, the headless box, evidence for a plan's Live test, launching the app by hand, and reading a failed run. Use before running `bun run test:db`, any `test:smoke*` suite or `bun run desktop` against a database, and when asked to "live test", "smoke test", "run the e2e tests", "test against MySQL/Postgres/Redis", "capture evidence", "fill in the Live test", "local testing" or "e2e testing".
---

# Local testing

How to run TableCraft's tests beyond `bun run test`: the contract suites against real database
servers in `docker compose` (`test/db/compose.yml`), the Playwright smoke suites that drive the
built app (`test/e2e/`), and a plan's Live test with its screenshots. Run every command from the
repository root.

Read a reference only when the step needs it:

- [references/databases.md](references/databases.md): every server, port, profile, user and seed;
  the remote TiDB and its scratch databases
- [references/parallel-checkouts.md](references/parallel-checkouts.md): the compose project and port
  variables a second checkout sets
- [references/smoke-scenarios.md](references/smoke-scenarios.md): writing or changing a smoke
  scenario with the harness
- [references/manual-launch.md](references/manual-launch.md): launching the app by hand on a test
  database, and the packaged suite

## 1. Pick the run

| You changed                                       | Run                                                                   |
| :------------------------------------------------ | :-------------------------------------------------------------------- |
| The renderer, core or main                        | `bun run test`                                                        |
| A plugin, the contract suite or `test/db/schema/` | `bun run test:db`, plus that plugin's own, such as `test:db:postgres` |
| What the app shows or does                        | `bun run test:smoke:headless`, or `test:smoke:db:headless` with SQL   |
| A plan's user-visible behaviour (its Live test)   | `test:smoke:db:headless` with `TABLE_CRAFT_EVIDENCE_DIR` (step 4)     |
| Packaging or the update flow                      | `bun run test:smoke:packaged`, on the host                            |
| The plugin API                                    | `bun run api:check`                                                   |

`test:db` starts MySQL, TiDB and MariaDB (decision 099). `TABLE_CRAFT_DATABASES`, a comma list of
`mysql`, `tidb`, `mariadb`, `postgres`, `oracle`, `mssql`, `redis`, `etcd` or `all`, picks the servers
`test/db/up.ts` starts and the suites that run; `test:db:postgres`, `test:db:oracle`,
`test:db:mssql`, `test:db:redis`, `test:db:etcd`, `test:db:mariadb` and `test:db:all` set it. SQLite always runs.
Run the suite of every plugin you touched.

## 2. Prepare

- **In a worktree**, copy the main checkout's `.env` into its root right after the worktree is made
  (`cp <main checkout>/.env .env`, when the main checkout has one), before any test. It names the
  remote TiDB the suites use instead of the emulated container.
- **Beside another checkout** whose suites may run at the same time, set `COMPOSE_PROJECT_NAME`
  and the port variables in
  [references/parallel-checkouts.md](references/parallel-checkouts.md) on every `test:db`,
  `test:smoke:db` and `docker compose` command, so this checkout gets its own containers.
- Start servers only through `test:db`, `test:smoke:db`, their headless forms or `bun test/db/up.ts`.
  `up.ts` recreates any container whose seed files changed (the `table-craft.seed` label,
  `test/db/stack.ts`), so an edit under `test/db/schema/` or `test/db/tls/` reseeds on the next run
  with no `down`.

## 3. Run

Agents and plan sessions run smoke and live tests in the headless box (decision 063): a Linux
container under Xvfb with its own keyring, so nothing takes the screen, keyboard or clipboard.

- `bun run test:smoke:headless` runs the suites on in-memory SQLite;
  `bun run test:smoke:db:headless` adds MySQL and TiDB, and `test:smoke:db:headless:postgres`,
  `:oracle`, `:mssql`, `:redis`, `:etcd` and `:all` add that server. The first line names the selected set.
- Paths narrow the run like `vitest run`, and arguments starting with `-` go to Vitest:
  `bun run test:smoke:db:headless test/e2e/namespace.smoke.test.ts`.
- Files run `TABLE_CRAFT_SMOKE_WORKERS` at a time, one display each (decision 096). Unset, that is
  3 on a Docker VM of 8 GiB or more and 1 below, shared with headless runs already on the VM, as the
  first line of the run says. The files in `SERIAL_SMOKE_FILES` (`test/e2e/serialFiles.ts`) run
  after, one by one.
- `bun run test:smoke` and `bun run test:smoke:db` run the same suites on the host and need a
  display; use them only for what the box cannot show.
- macOS-only checks stay on the host: `test/e2e/titleBar.smoke.test.ts`,
  `test/e2e/update.live.test.ts` and the packaged suite.

## 4. Capture a plan's evidence

A plan is done when its Live test table (`docs/plans/TEMPLATE.md`) lists one row per user-visible
behaviour, against every database the plan touches, each with a PNG in `docs/evidence/NNN/`.

1. In the plan's smoke file, take `const captureWindow = evidenceFor("NNN")` from
   `test/e2e/harness.ts` and call `await captureWindow(page, "01-what-it-shows")` once per
   behaviour (`evidenceTextFor` writes text evidence such as a log excerpt). Put the command that
   regenerates the evidence in the file's header comment.
2. Run it with the folder named:
   `TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/NNN bun run test:smoke:db:headless test/e2e/<file>.smoke.test.ts`.
   Each suite captures only for its own plan, so other files never write into the folder.
3. Open every PNG and check it shows the behaviour before filling in the row. Evidence from the box
   is Linux evidence; say so in the row when the behaviour differs by platform.
4. A bug the live test finds is fixed before the plan is marked done, with a regression test named
   in the row.

Plans and evidence are git-ignored (decision 035); never commit them.

## 5. When a run fails

| You see                                           | Do                                                                                                                 |
| :------------------------------------------------ | :----------------------------------------------------------------------------------------------------------------- |
| Setup fails because a container predates its seed | `bun test/db/up.ts`, with the same compose variables, then rerun                                                   |
| `TiDB: local container` while `.env` exists       | The remote did not answer. Say so in the report, and stop that container when the run ends                         |
| A file passes alone and flakes beside others      | Move it to `SERIAL_SMOKE_FILES` with the reason it conflicts. Never raise a timeout to hide it                     |
| A port is already allocated                       | Another checkout's containers hold it: set this checkout's ports (step 2), never stop containers you did not start |
| The frozen SQLite plugin fails the contract       | Fix the host or the contract; `bun scripts/frozen-plugin.ts` runs only when that plugin's API version changes      |
| A headless capture differs from the host          | Expected: the box is Linux. Check macOS-only behaviour on the host                                                 |

## Rules

- The remote TiDB is shared. A run works only in its own `tc_run_*` database and drops it after;
  never write to, create users in, or kill sessions outside what the run made.
- Prefer the remote TiDB whenever `.env` names it: never pass `--profile tidb` to `docker compose`,
  and never start the `tidb` service or any TiDB container by hand.
- Never stop, remove or reseed containers another checkout started.
- Never commit `docs/plans/`, `docs/evidence/`, `.env` or anything under `release/` or `dist/`.
