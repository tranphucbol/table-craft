# 038: Main writes one redacted, structured app log

Status: Accepted. Amended by 152.

## Decision

TableCraft keeps one app log, `<userData>/logs/table-craft.log`, and only the main process writes
it (plan 017).

- **Records** are JSON lines: `{ ts, level, process, scope, msg, ...fields, err? }`. `process` is
  `main`, `engine:<datasourceId>`, `probe:<datasourceId>` or `renderer`; `err` is the thrown value
  with its name, message, driver `code`, stack and up to five `cause`s. The shape and the logger
  live in `packages/desktop/src/log/record.ts`, shared by all three processes.
- **Transport**: the engine posts `engine.log` messages over its `parentPort`; its stdout and stderr
  are piped and logged under scope `stdio`. The renderer batches records (500 ms or 100 records)
  over `log.write`, checked by Zod; main sets `process: "renderer"` itself.
- **Levels** are `error`, `warn`, `info`, `debug`. `info` is the default; Settings → Advanced →
  Debug logging (`log.level`) switches to `debug` live. Main filters, so the other processes send
  everything and need no level of their own.
- **Rotation**: 5 MB per file, the current file plus `table-craft.1.log` to `table-craft.4.log`, so at most 25 MB.
- **Never logged**: passwords and other secrets, row values, SQL text (decision 152 logs the SQL an
  agent sent), the connection URL's user
  information. A statement is its request id, kind, duration, row count and outcome. Main redacts
  every record before it is written: keys that name a secret, URL user information, and the
  values of every secret it has handed to an engine, wherever they appear.
- **Main API**: `logHub.logger("main").child(scope, fields)` returns a `Logger` with `error`,
  `warn`, `info`, `debug` and `child`; new main-side subsystems, the in-app update first, take a
  child logger.
- **Export**: Help → Export Diagnostics… writes `table-craft-diagnostics-<yyyyMMdd-HHmmss>.zip`
  with the log files, `about.json`, `settings.json`, `datasources.json` without secrets and
  `history.json` with the last 50 runs' metadata only. The zip writer is in-house
  (`node:zlib` deflate and `crc32`), so no dependency is added.

## Rationale

The user asked for a log that is "useful for debug" and that they "can export if needed". A
single writer gives one file in one order to read, with no interleaving between processes and one
place to redact. JSON lines can be filtered by the Log tool window and by `jq` alike. Electron's
`utilityProcess` and the renderer cannot safely share a file handle, and the renderer may not touch
the file system at all (decision 002), so main is the only process that could write.

Libraries such as `electron-log` and `pino` were considered. Both write from each process or need
a transport of their own, neither redacts by the values main knows to be secret, and the in-house
logger, writer and zip are each under two hundred lines.

## Consequences

- A record is capped at 16 KB; a larger one keeps its envelope and is marked `truncated`.
- Error messages from a database are logged as the driver wrote them, and some quote values from
  the statement. Diagnostics say so in the export confirmation.
- A failed write disables the log for the session instead of failing the app; the failure goes to
  stderr.
- Plans that add a main-side subsystem log through a child logger and add a scope, not a file.
