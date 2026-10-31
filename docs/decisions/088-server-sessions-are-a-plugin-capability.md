# 088: Server sessions are a plugin capability

Status: Accepted. Plugin API 0.24.0.

## Decision

Listing, cancelling and terminating a server's sessions is the `sessions` capability. It requires
`sql` and `schemaTree`, because the engine lists on its introspection session, which only a
`schemaTree` plugin opens. A plugin that declares it gives every `Session` a `sessions` monitor and
a `serverSessionId`, the server's id of that connection, and, where ids repeat across a cluster's
servers, a way to name the server it landed on: a `serverInstance` when the plugin knows it for
free, or a `findServerInstance()` the host asks on demand when finding it costs a round trip (TiDB
before Global Kill, plugin API 1.9.0). The MySQL plugin does not look at connect:
`CLUSTER_PROCESSLIST` asks every TiDB server, and a cluster with one silent server held each
connect for 40 s (plan 131).

- `SessionMonitor.list()` returns a `SessionListing`: typed `ServerSession` rows (`id`, `instance`,
  `state` of `active | idle | idleInTransaction | blocked | other` with the server's `rawState`,
  `user`, `database`, `client`, `application`, `queryMs`, `transactionMs`, `waitEvent`,
  `blockedBy`, `query`, `system`) and `notes`, one sentence per thing the account cannot see,
  naming the grant to ask for.
- Each row carries `cancel` and `terminate`: the exact statement the plugin will run, or `null`
  when the server cannot do it or the session is a server process. The plugin builds them with the
  id as a checked digit literal, so the statement shown is the statement run.
  `cancelSession(target)` and `terminateSession(target)` run them on a fresh connection, and reject
  with `statementFailed` when the session is gone.
- **PostgreSQL** reads `pg_stat_activity` and `pg_blocking_pids`, and runs `pg_cancel_backend` and
  `pg_terminate_backend`. **MySQL** reads `information_schema.PROCESSLIST`, `INNODB_TRX` and
  `performance_schema.data_lock_waits` (falling back to `sys.innodb_lock_waits`), and runs
  `KILL QUERY` and `KILL`. **TiDB** reads `CLUSTER_PROCESSLIST` and runs `KILL TIDB QUERY` and
  `KILL TIDB`. Before 6.1, where a kill is local to one TiDB instance, it offers no cancel and
  runs a terminate only on a connection that has reached the row's instance. **SQLite** does not
  declare it.
- The engine tags the rows that are its own sessions with their engine session id, by
  `serverSessionId` and, when the session knows it, its instance, never by application name. It
  calls `findServerInstance` only for a session whose id the listing shows on more than one
  instance, only while nothing runs on it and no transaction is open, and remembers the answer
  for that connection; without an answer it matches by id alone. It refuses cancel and terminate on a read-only data
  source. The request log records the session id and the data source, never the statement or the
  query text.
- The renderer asks before a terminate and shows the statement. On a data source coloured red the
  user types the session id first. Terminating one of TableCraft's own sessions adds a warning.

## Rationale

Every dialect lists sessions from a different catalog, under different privileges, and kills them
with different statements, so the SQL belongs to the plugin (decision 008). Typed rows let the UI
filter, tint and sort the same way on every server. The plan's `ownSessionMarker` would have
matched sessions by application name, which tags every TableCraft user on a shared server as
"you"; the connection's own server id is exact. Returning the statement on the row, instead of
asking for it in a second call, keeps what the confirmation shows and what runs in one place.

## Consequences

- `API_VERSION` is 0.24.0. While the major is 0 a plugin must match the minor, so plugins built for
  0.23 are unavailable until rebuilt.
- Engine messages `sessions.list`, `sessions.cancel` and `sessions.terminate`; the listing reuses the
  introspection session and its retry on a broken connection, the kills never retry.
- A plugin that cannot see lock waits leaves `blockedBy` `null` and says why in `notes`.
- TiDB 4 ends a terminated idle connection only when it next sends a statement, so the row stays
  listed until then.
