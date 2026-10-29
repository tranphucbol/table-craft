# 129: The database backs the statement limit where it can

Status: Accepted. Amends 054. Amended by 131.

## Decision

The engine's timer stays the statement limit (decision 054). Where the server can stop a statement
by itself, the plugin also hands the same limit to the server, as a backstop for what the engine
cannot reach: a crashed app, a lost route, a TiDB without Global Kill.

- A plugin opts in with the capability `serverTimeout`. Each connected session reports what its
  server enforces in `Session.serverTimeout: ServerTimeout | null`: the `setting`, which statements
  it `covers` (`reads` or `all`) and what it `counts` (`statement`, from the start until the last row
  is sent, or `serverWork`). Null means this server version has no such setting. The MySQL plugin
  tells MySQL, MariaDB and TiDB apart this way, so the host never branches on a plugin id
  (decision 007).
- The host asks per statement with `ExecuteOptions.serverTimeoutMs` and
  `ExplainOptions.serverTimeoutMs`, only on a session whose plugin declares `serverTimeout` and whose
  `serverTimeout` is not null. Absent means no server limit.
- The plugin sets a session variable, only when the wanted value differs from the one it last set:
  `max_execution_time` (ms) on MySQL 5.7.8+ and TiDB, `max_statement_time` (s, fractional) on
  MariaDB 10.1.1+, `statement_timeout` on PostgreSQL. Never `GLOBAL`.
- The client never raises the server's own limit. Before the first limited statement the plugin
  reads the session's value once and from then on applies `min(own, requested)`, 0 meaning
  unlimited. With no limit asked for, it puts `own` back.
- What is covered follows the server: MySQL covers reads; TiDB before 6.4 covers everything and
  reads from 6.4; MariaDB and PostgreSQL cover everything. All four count the whole statement,
  including time a streamed result waits to be read.
- A statement the server stops rejects with the plugin error code `timedOut`, whose message names
  the setting ("TiDB stopped the statement at its 120 s limit (max_execution_time)."). The engine
  answers the existing `statementTimedOut` with that message on every route, `result.fetchMore`
  included. MySQL's 3024 and MariaDB's 1969 are `timedOut`. TiDB 4 answers 1317, the errno of
  `KILL QUERY`, and PostgreSQL 57014, the SQLSTATE of `pg_cancel_backend`: each counts as
  `timedOut` only when the plugin did not ask for a cancel, a limit is set and the statement ran at
  least that long.
- Agents always ask for it, with the setting `mcp.statementTimeoutSeconds` (1 to 3,600, default 120)
  or a datasource's `agentTimeoutSeconds`. Consoles opt in per datasource with
  `enforceTimeoutOnServer: true`, which also covers the table editor and Explain.

## Rationale

Decision 054 rejected native timeouts because they fit only some statements and keep counting while
a result waits for the grid. Both are still true, so the native limit does not replace the timer; it
backs it. A `KILL` the engine sends only works while the app can reach the server and the server
honours it: TiDB before 6.1 has no Global Kill, so `cancel` drops the connection and TiDB keeps
running the statement. An agent's `SELECT` on production is exactly the statement that must not
outlive its limit.

A per-statement rewrite (MySQL's `/*+ MAX_EXECUTION_TIME(n) */` hint, MariaDB's
`SET STATEMENT max_statement_time = n FOR`) was rejected. It shifts the error positions decision 082
maps back into the user's text, and each form fits only some statements.

Measured on MySQL 8.4, MariaDB 10.11, TiDB 4.0.14 and PostgreSQL 17 with a 1 s limit:

- MySQL: `SELECT SLEEP(3)` returns 1 after 1 s, no error, since `SLEEP` reports being interrupted
  as its result; `DO SLEEP(3)` runs the full 3 s. A statement that reads rows past the limit fails 3024.
- MariaDB: `SELECT SLEEP(3)` fails 1969; `DO SLEEP(3)` stops at 1 s with a warning only.
- TiDB 4: `SELECT SLEEP(3)` returns 1 and `DO SLEEP(3)` stops at 1 s, silently. A scan past the
  limit fails 1317. `BENCHMARK()` ignores both `max_execution_time` and `KILL TIDB QUERY`.
- A result paused past the limit is cut on all four when the server still has rows to send: 3024,
  1969 and 1317 on the next read, and PostgreSQL 57014, because `pg-cursor`'s `Execute` without a
  `Sync` keeps the statement open. A small result the driver has already buffered ends normally.

## Consequences

- An agent's or opted-in console's statement can fail `statementTimedOut` on a later read of a
  result left open past the limit. Rows already read stay readable; the hint says to narrow the
  statement or raise the limit, and the Data Sources hint under the checkbox says the count runs
  while rows wait.
- The plugin changes session state the user can see: `SELECT @@max_execution_time` shows the limit
  on an opted-in console. A statement naming the setting makes the plugin forget what it set, so it
  sends it again before the next limited statement.
- PostgreSQL's setting is transactional: the plugin forgets it whenever a transaction ends and sends
  it again; inside a failed transaction it skips the `SET` and lets the server's own error stand. The
  engine's own small reads on that session now run under the limit, which is at least 1 s.
- The plugin API moves to 1.6.0, every addition optional (decision 106). Older builds set aside a
  `datasources.json` carrying `enforceTimeoutOnServer` or `agentTimeoutSeconds`.
- A slow read for the contract suite must end by itself on an idle server: `statements.slowRead` is
  a function of seconds, and on TiDB a count over a cross join, never `BENCHMARK()`.
- Oracle and SQL Server do not declare `serverTimeout`; their driver timeouts are client timers that
  add nothing to the engine's own. SQLite and Redis have no server limit.
