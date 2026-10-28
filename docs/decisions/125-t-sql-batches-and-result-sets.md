# 125: T-SQL batches and result sets

Status: Accepted

## Decision

A SQL Server console statement is a T-SQL batch. The shared splitter cuts at `;` and at `GO` lines
(decision 100); a routine definition runs to the next `GO`. Each span is sent with
`execSqlBatch`, so `USE`, `SET` and `DECLARE` keep their effect for what follows, or with
`sp_executesql` when it has parameters (`@p1`, `@p2`, …).

- `GO n` runs the batch n times: the host passes the span's `repeat` as `ExecuteOptions.repeat`,
  a new optional field, and the plugin answers with the last run, with every run's messages.
- A batch that returns several result sets shows the first and drains the rest, adding an info
  message `N more result sets in this batch; separate statements with ; to see each.`.
- `PRINT` is an info message without a code; `RAISERROR` up to severity 10 is a note with its
  number. Row count messages are not echoed.
- An error's line number underlines that line of the batch from its first non-blank character,
  unless the error comes from inside a module, whose lines are not the console's.
- Explain wraps the statement in `SET SHOWPLAN_XML ON`/`OFF`, and Explain Analyse in
  `SET STATISTICS XML ON`/`OFF`, reading the XML showplan with a small parser in the plugin.

## Rationale

One result per statement is how every console in the app works: one grid, one cursor, one row
count. A batch without `;` between its statements is valid T-SQL, and splitting inside it would
change what `DECLARE` and `SET` see, so the batch stays whole and the extra result sets are named
instead of shown. The message says how to see them.

`GO` is a client convention, not T-SQL; DataGrip and SSMS both repeat on `GO n`, and only the
client can.

## Consequences

- Plugins that split scripts with `batchSeparator: "go"` must honour `ExecuteOptions.repeat`; a
  plugin that ignores it runs the batch once.
- A batch whose second result set is the one the user wanted needs a `;` between its statements.
- `IF … BEGIN …; …; END` at the top level is still cut at its `;`, since the splitter opens
  `BEGIN … END` bodies only inside routine definitions; such a script needs `GO` around it or no
  inner `;`.
