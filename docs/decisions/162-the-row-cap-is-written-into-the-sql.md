# 162: The row cap is written into the SQL

Status: Proposed. Amends 025 and 148.

## Decision

A plain `SELECT` run from a console, the table data editor or an agent's `run_query` carries its
row cap in its own text, so the server stops after one page instead of leaving a cursor open.

- **Plugin API.** A new optional language service, `rowLimit: RowLimiter`, declared by the
  `rowLimit` capability (requires `sql`). `limit(sql, rows)` returns the statement with the limit
  written in and the one span it inserted, or `null` when the statement cannot take one safely.
  The SQL kit's `sqlRowLimiter(dialect, style)` builds it in three styles: `limit` (` LIMIT n`:
  MySQL, MariaDB, TiDB, PostgreSQL, SQLite, DuckDB), `fetchFirst` (` FETCH FIRST n ROWS ONLY`:
  Oracle 12.1+) and `top` (` TOP (n)` after `SELECT [ALL | DISTINCT]`: SQL Server). It declines
  anything but a top-level `SELECT` (a `WITH` whose main verb is `SELECT` counts), a statement that
  already has a top-level `LIMIT`, `OFFSET`, `FETCH` or `TOP`, one with `INTO`, `FOR`, `LOCK` or
  `PROCEDURE` at the top level, one that writes anywhere (`INSERT`, `UPDATE`, `DELETE`, `MERGE`),
  more than one statement, and, for `top`, a set operation. `API_VERSION` moves to 2.2.0.
- **Engine.** `runStatement` asks for a limit only for a statement the language classifies `read`,
  when the plugin has `rowLimit` and the request's `paging.limitInSql` is not `false`. The limit
  is one row more than the first page, so the store still knows whether more rows exist. A full
  first page leaves the result `500+` with `refetch: true` and no open cursor.
- **Fetching more.** Fetch Next Page runs the statement again on the session that ran it, with a
  limit of the rows held plus a page plus one; Fetch All with the Fetch All limit plus one. The new
  rows replace the old ones under the same handle; sort keys stay. If the statement now returns
  other columns, `result.fetchMore` fails with `resultChanged` and the old rows stay. A table tab
  with pending edits cannot fetch until they are submitted or reverted. Run Settings → All sends
  `all: true`, so the first run asks for the Fetch All limit at once.
- **Export.** Exporting a result cut short by its limit runs the statement without the limit:
  on a fresh connection when it may (decision 025's rerun), else on the owning session (origin
  `session`). It never writes only the rows held.
- **What the user sees.** Output, the query history, editability and an agent's `sent` keep the
  user's text; a plugin's own `sent` loses the inserted span. An error position past the limit is
  moved back by its length, and one inside it is dropped (decision 082).
- **Turning it off.** `data.limitInSql` (default `true`, Settings → Data Editor → Row limit)
  travels on every request as `ResultPaging.limitInSql`; `false` keeps decision 025's open
  cursor. A plugin without `rowLimit`, a statement the limiter declines, Redis and etcd keep it too.

## Rationale

An open cursor holds server resources for as long as the tab lives: MySQL streams the whole result
into the socket buffer, PostgreSQL keeps a portal and its snapshot, SQL Server keeps the batch
paused mid-read. A `SELECT * FROM big_table` asked for 500 rows makes the server produce millions.
Writing the cap into the SQL lets the planner stop early and frees the connection at once.

Decision 025 rejected re-running with `LIMIT`/`OFFSET` because results may differ between runs,
side effects repeat and arbitrary SQL would need parsing. This decision accepts the first for plain
`SELECT`s, which DataGrip also does; avoids the second by declining any statement that writes; and
puts the parsing in the plugin's language, where decision 008 puts SQL knowledge. Decision 148
rejected a renderer rewrite for the same reason; the rewrite here lives in the engine and plugin.

Paging by `OFFSET` was rejected: rows shift between runs, and a re-run from the start with a larger
limit returns a consistent prefix of one execution.

## Consequences

- A statement without `ORDER BY` may return other rows on Fetch Next Page; volatile functions run
  again; a fetch after a transaction ends sees new data; Fetch All costs one full run.
- Plugins without `rowLimit`, including the frozen SQLite plugin at API 1.0.0, keep cursor paging.
- `ResultPaging` gains `limitInSql`, `statement.execute` gains `all`, `ResultState` gains
  `refetch`, the export origin gains `session`, and engine errors gain `resultChanged`.
