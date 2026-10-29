# 131: A datasource remembers how its timeout is enforced

Status: Accepted. Amends 129.

## Decision

The same agent statement limit does different things on different servers, so TableCraft keeps
what each server last said and explains it beside the limit.

- A plugin says how its `cancel` reaches the server through the optional
  `Session.cancelReach?: CancelReach`, read once at connect: the `method` it sends, for people
  (`KILL QUERY`, `pg_cancel_backend`, `CLIENT UNBLOCK`), and what it `reaches`: `statement` (the
  server stops the work), `connection` (the plugin drops its connection and the server may keep
  going, a TiDB without Global Kill) or `blockingCommands` (Redis: only commands waiting for data
  stop). Absent means unknown, and the host claims only that it cancels. `session.open` and the
  probe carry it as `cancelReach: CancelReach | null`.
- A datasource remembers the last server it saw in the optional `lastServer` key of
  `datasources.json`: `{ version, timeout?, cancel?, seenAt }`. A key left out means the plugin did
  not report it; `timeout: null` means the server has no limit of its own. A form save keeps the
  stored value and never takes one from the form.
- Three paths write it: a console connect, Test Connection of a saved datasource, and an agent
  session opening (the MCP process posts `mcp.server-seen` to main, which drops it for a datasource
  agents may not see). The ephemeral datasource never writes.
- One invoke channel, `datasources.remember-server`, carries the brand and `lastServer` together
  and replaces `datasources.set-brand`, so one connect makes at most one write. Main writes only
  when the brand or the facts changed, or the stored `seenAt` is a day old (`SEEN_REFRESH_MS`).
- The explanation is a pure function of the plugin's capabilities, `lastServer`, the brand's
  display name and the effective seconds. It never branches on a plugin or brand id (decision 007).

## Rationale

A 30 s limit on a TiDB 5 stops an `UPDATE` only because TiDB's own `max_execution_time` does;
TableCraft can only drop the connection. On Redis nothing stops `KEYS *`. Decision 129 put these
facts on the session, but the renderer kept them only for a moment, and nothing said how strong a
plugin's `cancel` is. Reading them live when Settings opens would connect to every row; remembering
them costs one small write per changed server or per day, and the footer says when they were seen.

## Consequences

- A build before this one sets a `datasources.json` with `lastServer` aside as corrupt, as it does
  for `brand`; the set-aside copy sits beside it.
- Remembered is not current: a server upgraded since the last connect shows stale facts until the
  next console, test or agent session.
- The plugin API gains `CancelReach` and `Session.cancelReach` (API 1.7.0); a plugin without them
  loads and passes the contract.
