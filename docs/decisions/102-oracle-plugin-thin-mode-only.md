# 102: The Oracle plugin runs node-oracledb in thin mode only

Status: Accepted. Plan 054.

## Decision

The optional `oracle` plugin (decision 108) connects with node-oracledb in thin mode, pure
JavaScript, and never calls `initOracleClient`, so no Instant Client is loaded or looked for. A
server older than 12.1 fails with `TableCraft connects to Oracle 12.1 or later; this server is
11.x or older.` instead of the driver's `NJS-138`.

What thin mode cannot do decides how the plugin works:

- **Cancel.** `connection.break()` resolves, but the server keeps running a PL/SQL call such as
  `DBMS_SESSION.SLEEP` to its end. Cancel therefore opens a second connection and runs
  `ALTER SYSTEM CANCEL SQL 'sid,serial#'` against the session's own id, which stops it within a
  second (`ORA-01013`, reported as cancelled); `break()` is the fallback when that statement
  fails, for an account without `ALTER SYSTEM`.
- **TLS.** Thin mode always checks the server's certificate chain, so the SSL modes are
  `disable`, `verify-ca` and `verify-full` (`sslServerDNMatch`); there is no `require`. The CA
  file is read on every connect and passed as wallet content over TCPS. The socket is hidden, so
  the session reports `TCPS` with the cipher "negotiated by the server".
- **Values.** Thin mode decodes `DATE` and `TIMESTAMP` into a JavaScript `Date`, so they are shown
  to the millisecond; `TIMESTAMP WITH TIME ZONE` arrives as an instant and is shown in UTC.
  `NUMBER` is fetched as text so no digit is lost; `NUMBER(p)` is a wire integer and
  `NUMBER(p,s)` a decimal padded to its scale. An unconstrained `NUMBER` (an expression, a PL/SQL
  variable) is an integer when its text is integral and a decimal otherwise.
- **Error positions.** The driver's `offset` counts UTF-8 bytes of the statement; the plugin turns
  it into a UTF-16 offset before the editor underlines it.

## Rationale

The thick client is a native download per platform and architecture, licensed separately, that
the user would have to install and point TableCraft at; it would also make the plugin's tarball
platform-specific, which decision 109's one package per plugin does not allow. Thin mode covers
12.1 and later, which is every release Oracle still supports. What it lacks (native network
encryption, `require` without verification, sub-millisecond `DATE` decoding) costs less than
asking every user to install a client.

## Consequences

- No 11g support. Advanced Networking Option encryption (native, not TLS) is not offered.
- Cancel needs `ALTER SYSTEM` to interrupt a PL/SQL call; without it a `break()` interrupts a
  plain SQL fetch only.
- Temporal values lose digits below the millisecond and a time zone region; the grid shows what
  the driver gave.
