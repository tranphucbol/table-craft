# 133: Testing know-how is a skill agents load when they test

Status: Accepted. Amends 132.

## Decision

How to run the database, smoke and live tests lives in the project skill
`.agents/skills/local-testing/`, not in `AGENTS.md`. `SKILL.md` is the procedure: pick the run,
prepare a worktree or a parallel checkout, run in the headless box, capture a plan's evidence, read
a failed run. Its `references/` hold the detail a step needs: every server with its port, profile
and users (`databases.md`), the compose project and port variables of a second checkout
(`parallel-checkouts.md`), writing a smoke scenario with the harness (`smoke-scenarios.md`), and
launching the app by hand or packaged (`manual-launch.md`).

`AGENTS.md` keeps one line per command, the instruction to load the skill before a database or
smoke run, and the rules that protect what other people share whether or not the skill is loaded:
the remote TiDB is touched only inside a run's own `tc_run_*` database, no TiDB container is
started by hand, and a worktree copies the main checkout's `.env`.

`test/desktop/localTestingSkill.test.ts` checks the skill against the code: its `bun run` scripts
exist, the repository paths it names exist, its port table matches the defaults in
`test/db/compose.yml`, and the harness helpers and serial-file list it names are real.

## Rationale

`AGENTS.md` is in every session's context. Its Commands section had grown to about 85 lines of
test servers, Redis services, remote TiDB rules, port variables and headless-box behaviour, which
a session that only edits the renderer pays for and never reads. A skill is loaded only when a
session tests, and its references only when a step needs them.

Moving the detail to `CONTRIBUTING.md` would not help agents, which load `AGENTS.md`, and would mix
a human on-ramp with a port table. A skill in `.agents/skills/` is found by the agent tools that
read that folder, sits beside `create-pr`, and is plain Markdown people can read too.

Keeping the shared-server rules in `AGENTS.md` as well is deliberate duplication: an agent that runs
`docker compose` without loading the skill must still not start a TiDB container or write to the
remote server.

## Consequences

- A change to a test server, port, compose profile or harness helper updates the skill; the test
  fails when a port or helper drifts.
- `CONTRIBUTING.md` links the skill for test servers and parallel checkouts instead of
  `AGENTS.md#commands`.
- The plan template's Live test points at the skill.
