# 066: Server messages reach the user

Status: Accepted.

## Decision

The warnings and notices a server leaves about a statement are part of its result. A plugin that
declares the `serverMessages` capability returns them on `ExecuteResult.messages` as
`ServerMessage { level: "error" | "warning" | "notice" | "info", code, text }`, and on
`ExplainedPlan.messages` for an Explain.

- **MySQL and TiDB** read the warning count from the OK or EOF packet and, only when it is above
  zero, run `SHOW WARNINGS` on the same connection before the session takes its next statement.
  Level `Warning` is a warning, `Note` a notice, `Error` an error; the code is the server's error
  number. TiDB 4 rejects `SHOW WARNINGS LIMIT`, so the plugin reads them all and keeps the first
  `SERVER_MESSAGE_LIMIT` (100).
- **PostgreSQL** collects the client's `notice` events while the user's statement runs: `WARNING`
  is a warning, `NOTICE` a notice, the rest info; the code is the SQLSTATE.
- **SQLite** has none and does not declare the capability.
- Above the limit the plugin adds one `info` message saying how many more were left out
  (`omittedMessages`).
- A streamed result's messages are complete once its rows are exhausted. A cancelled or abandoned
  result has none, and the plugin does not ask.

The engine carries them on `ResultState` once the result is complete. The console prints one Output
line per message under the statement, in the level's tone; the result tab and the Services
execution node show a warning badge with the count and the messages as its tooltip. A statement
with warnings is still a success. History stores the count, never the text; the request log
records the count and the codes, never the text (decision 020's rule for statement text).

## Rationale

TiDB answered `/*+ USE_INDEX(order_events_shop_id) */` with warning 1815, "use_index is
inapplicable", and a full table scan. The console showed only "10 rows", so the user saw the hint
fail without the reason the server gave. Every client the user knows (the `mysql` CLI's
"1 warning", DataGrip's Output) shows these.

`SHOW WARNINGS` only when the count is above zero keeps the cost at one round trip on the
statements that have something to say. Asking on the same connection before the session is free is
the only correct place: the next statement resets the list.

## Consequences

- One extra round trip on a statement with warnings. It runs inside the statement's work, so a
  statement timeout covers it; it never ends or opens a transaction. A failure to read the warnings
  is ignored: the statement already succeeded.
- The engine's own statements (introspection, table editor queries) never surface messages.
- A streamed result's messages arrive with the page that completes it, so the Output lines and badge
  may appear after the first rows, and the request log's "statement finished" line does not count
  them.
- History schema version 3 adds a nullable `warnings` column.
