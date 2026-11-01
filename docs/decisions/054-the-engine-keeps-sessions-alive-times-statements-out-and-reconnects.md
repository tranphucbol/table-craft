# 054: The engine keeps sessions alive, times statements out and reconnects

Status: Proposed. Amends 040 and 021. Amended by 129 and 148.

## Decision

Every connection the engine opens (console, introspection, row count, Test Connection, export,
liveness probe) asks the plugin for TCP keepalive with the data source's `keepAliveSeconds` as the
initial delay: 30 by default, 0 turns it off, 1 to 7,200 otherwise. A plugin that declares the
`keepAlive` capability honours `ConnectOptions.keepAliveInitialDelayMs` and implements
`Session.ping()`; one that does not ignores both. Export's own 10 s keepalive (decision 040) gives
way to the data source's.

A console statement has a time limit, enforced by the engine, not by the database: the renderer
sends `timeoutSeconds` on `statement.execute`, `statement.explain` and `table.query`, resolved from
the data source's `statementTimeoutSeconds` (absent follows the setting, 0 waits) and then the
`console.statementTimeoutSeconds` setting (default 0). When the limit passes, the engine cancels
through the `cancel` capability and answers `statementTimedOut`. A cancel the server does not answer
within 5 s drops the session. Without `cancel` the limit is not offered.

The engine keeps a console's session healthy:

- Before running on a session idle for at least the keepalive interval, it pings, bounded by 5 s. A
  ping that fails or times out, or an `execute` that rejects `connectionLost` (the plugin knew before
  sending), opens a new session and runs the statement there: nothing was sent, so nothing runs
  twice.
- While a statement runs, it opens a probe connection once per keepalive interval. A probe that
  neither connects nor fails within 5 s means the route to the server is gone: the statement fails
  `connectionLost`, saying it may have completed, and the next Run reconnects.
- A reconnect restores manual transaction mode and replays the session's last namespace switch
  (`USE db`, `SET search_path`), before manual mode so it opens no transaction, then reads the
  namespace again. The response carries `reconnected` with the new namespace and whether the switch
  was lost because it could not be replayed; the console says so in Output.
- A session lost with a transaction open is never replaced silently: the statement fails
  `connectionLost` naming the lost changes, and the next Run reconnects.

## Rationale

A laptop that sleeps, a VPN that drops, a NAT that forgets an idle flow: the next Run hung until the
OS gave up, minutes later, or failed with a driver message and left the console dead until the user
reopened it. DataGrip keeps sessions alive and reconnects; TableCraft must too.

Native timeouts do not fit. MySQL's `max_execution_time` applies to `SELECT` only and keeps counting
while a streamed result waits for the grid (decision 025). PostgreSQL's `statement_timeout` is
session state that `ROLLBACK` reverts and that would cut the engine's own namespace reads. A timer in
the engine around `execute` covers every statement on every plugin with `cancel` and stops when the
first window arrives.

TCP keepalive alone is blind behind a hop that answers TCP itself: Docker Desktop's port forward, an
SSH tunnel, a proxy. Keepalive probes reach the hop and are answered while the server behind it is
gone. A new connection is the one signal that passes through such a hop: it either reaches the
server or hangs. A probe that fails fast (refused, authentication) is an answer, so a busy server or
a changed password is not mistaken for a lost one.

## Consequences

- The plugin API moves to 0.14.0: `CAPABILITIES` gains `keepAlive`, `Session` gains `ping?()`,
  `PLUGIN_ERROR_CODES` gains `connectionLost`. PostgreSQL and MySQL declare `keepAlive`; SQLite does
  not, and has no `cancel`, so it shows neither field.
- `datasources.json` gains optional `keepAliveSeconds` and `statementTimeoutSeconds`. An older app
  sets aside a file that carries them.
- A long statement costs one extra connection per keepalive interval while it runs; an idle console
  costs one ping per Run after an idle interval and no traffic in between.
- A statement lost in flight may have run. The error says so; the engine never re-runs it.
- Detection after a blackhole takes up to one keepalive interval plus 5 s while a statement runs, and
  the ping's 5 s before the next Run.
