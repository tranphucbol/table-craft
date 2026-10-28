# 124: SQL Server plugin on tedious

Status: Accepted

## Decision

The SQL Server plugin (`plugins/mssql`, optional, downloaded on demand as decision 108 says) talks
to the server through `tedious` alone, the pure-JavaScript TDS driver, with no `mssql` wrapper and
no native code. It connects with SQL logins, NTLM and the two Microsoft Entra flows tedious offers,
over TLS `optional`, `mandatory` (the default) or `strict` (TDS 8.0).

Where tedious loses information the plugin works below it:

- **Values.** tedious turns `decimal`, `numeric` and `money` into JavaScript numbers, and every
  date and time type into a `Date` that drops `datetime2(7)`'s last digits and `datetimeoffset`'s
  offset. The plugin wraps tedious's `readValue` once per process and decodes those types from
  the wire bytes into exact text (decision 017): `1234567890123456789.123456789`, `2024-02-29
13:45:30.1234567`, `2024-02-29 13:45:30.1234567 +05:30`. `useUTC` stays at its default, since
  no `Date` is read. `bit` columns carry `typeClass: "boolean"`.
- **Transaction state.** Whether a transaction is open comes from the server's begin, commit and
  rollback notices (tedious's `transactionDescriptors`), not from querying `@@TRANCOUNT` after each
  statement: `BEGIN TRAN`, a `COMMIT` inside a batch, a failed statement that rolled everything
  back and implicit transactions are all seen with no extra round trip. Manual mode is
  `SET IMPLICIT_TRANSACTIONS ON`.
- **Bulk insert.** Import writes parameterized multi-row `INSERT`s (at most 1,000 rows and 2,100
  parameters each), not tedious's `BulkLoad`, guarded by `TRY_CONVERT` checks that raise a
  readable error before the insert. SQL Server rolls back the whole transaction on a conversion
  error, which would close the transaction a savepoint was meant to keep.
- **Read-only.** SQL Server has no read-only session; `ApplicationIntent=ReadOnly` only routes to
  a readable secondary. A read-only datasource sets the intent and refuses writes and DDL in the
  plugin, as the MySQL plugin does for TiDB.

Sessions come from `sys.dm_exec_sessions` and its neighbours, with the input buffer as the query
text; a login without `VIEW SERVER STATE` (`VIEW SERVER PERFORMANCE STATE` from 2022) sees its own
sessions and a note. `KILL` ends a session; there is no statement-only cancel, so `cancel` is null.

## Rationale

`tedious` is the driver the `mssql` package and most Node SQL Server clients build on, and it
bundles without native parts, which an on-demand plugin needs. The `mssql` wrapper
adds pooling and a second API the plugin would not use. ODBC and `msnodesqlv8` need native drivers
on the user's machine.

Decoding values ourselves costs one patched function and a byte-format module with tests against
SQL Server 2022; the alternative is wrong numbers in the grid and in exports.

## Consequences

- A tedious upgrade that renames `readValue` makes connecting fail (the plugin checks that the
  wrap took) rather than return lossy values silently; the contract suite's type probe catches it
  first.
- Strict (TDS 8.0) TLS is passed through to tedious but not live-tested: SQL Server 2022 on Linux
  refuses strict logins without extra server setup.
- The test server runs `READ_COMMITTED_SNAPSHOT ON`, as Azure SQL Database does, so the contract's
  readers do not wait on an uncommitted row; writers still block, which the lock-wait test needs.
