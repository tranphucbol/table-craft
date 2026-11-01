# 040: Exports stream in the engine as background tasks, and never leave a file that looks complete

Status: Accepted

## Decision

An export is a task the engine owns, not a request the renderer waits on. `export.start` answers
at once with the task; the engine then pushes `export.progress` (at most every 250 ms) and one
final `export.done`, `export.failed` or `export.cancelled` on every port it serves, each carrying
the whole task. `export.cancel`, `export.retry` and `export.list` act on tasks by id. Tasks belong
to the engine, not to the port that started them, so closing a console does not stop an export;
the engine waits for running exports before it exits when idle, and a shutdown or disconnect
cancels them.

Where the rows come from:

- A read statement (the plugin's `classify` says `read`) whose console has no open transaction is
  run again on a session of the export's own, opened read-only with TCP keepalive and asked for
  whole binary values (`ExecuteOptions.fullBytes`, plugin API 0.12.0). The console stays free. A
  plugin whose sessions cannot see each other's data (`Session.privateDatabase`, SQLite's
  `:memory:`) is never re-run elsewhere.
- Otherwise a result that has read every row exports what the engine holds, and one with an open
  cursor drains it; the grid shows the task's rows, clock and Cancel until it ends.
- A table or view from the explorer reads `SELECT <chosen columns> FROM <relation>` on its own
  session, the same way as a re-run.

A single statement reads one snapshot in PostgreSQL (the portal lives in one implicit transaction
until Sync, `pg-cursor/index.js:75,157`) and in InnoDB, so the export opens no transaction of its
own.

The file is written as `<path>.<taskId>.part`, created exclusively, in 1 MiB writes awaited one
after another, so the database is read only as fast as the disk takes it. On success the file is
fsynced, renamed over `path` and its folder fsynced. On any failure, cancel or shutdown the part
file is removed and an existing `path` is left untouched. There is no resume: Retry starts a new
task from the first row, and only for re-run and table sources, whose rows can be read again.

A network can fail without an error. Three guards make a dead link end the task instead of
hanging it: TCP keepalive on the export session (`ConnectOptions.keepAliveInitialDelayMs`, 10 s),
a stall watchdog that fails the task when no row arrives for `data.exportStallSeconds` (120 s by
default, 10–3,600, sent with each `export.start` because the engine keeps no preferences,
decision 032), and a `Session.close()` that settles within a grace period even when the peer never
answers, destroying the socket after it. Every failure message says how many rows were written
before it stopped and what to do next; a full disk (`ENOSPC`, `EDQUOT`) says so and names the
folder, and less than 1 GiB free when the task starts is a warning on the task.

## Rationale

The previous `result.export` held one request open for the whole file, drained the console's own
cursor (so the console was busy and binary values were clipped to their 32-byte preview), wrote
`<path>.tmp` without fsync, and had no answer for a link that went quiet: a stalled socket left
the request pending forever. Users export multi-gigabyte results over VPNs and flaky Wi-Fi, so
the export has to survive a slow link, fail cleanly on a dead one, and never leave a truncated
file under the final name.

Re-running a read is the only way to export binary values in full without making every grid
fetch carry them, and it frees the console. A resumable export was rejected: a re-run can return
rows in a different order unless the statement orders them, so stitching a file from two runs
could duplicate or lose rows silently. Pushing events from the engine is the first push channel;
polling `export.list` would have kept the request/response protocol pure, but at the cost of a
timer per open window and late cancels.

## Consequences

- Export no longer runs in the console's session and no longer applies the grid's local sort
  when it re-runs; the statement's own `ORDER BY` decides the order.
- The engine has push events; the renderer's engine client dispatches messages with no `id` to
  listeners, and the Services tree shows them under an Exports node, with the status bar's
  Exports chip (plan 138): name, rows or percent, a clock from `ExportTask.startedAt`, Cancel and a
  popover of the session's exports.
- The plugin contract is 0.12.0: `Session.execute(sql, params?, options?)` with `fullBytes`,
  `ConnectOptions.keepAliveInitialDelayMs`, `Session.privateDatabase` and a bounded `close()`. A
  plugin that ignores `fullBytes` still exports, with previews counted on the task.
- The chaos suite (`test/db/export.chaos.test.ts`) proves stalls, resets, slow links and cancel
  through a TCP proxy, and the gated `TABLE_CRAFT_LARGE_EXPORT=1` suite proves a 3 GB file with a
  matching SHA-256 at flat memory.
