# Oracle

The Oracle plugin connects to Oracle Database 12.1 or later in thin mode: nothing else to install,
no Instant Client. Connect by **Service name** or **SID**, optionally as SYSDBA, SYSOPER or
SYSBACKUP, or paste `oracle://user@host:1521/FREEPDB1`. SSL is _Verify CA_ or _Verify full_ over
TCPS with the server's CA file; thin mode always checks the certificate, so there is no _Require_.

- **Schemas** are the tree's namespaces, yours first and Oracle-maintained ones under System.
  Packages list their members as `PACKAGE.MEMBER`, one row per overload. `ALTER SESSION SET
CURRENT_SCHEMA` moves the console and its completion to that schema.
- **Values.** `NUMBER` keeps every digit; a `NUMBER(p)` column is an integer and `NUMBER(p,s)` a
  decimal padded to its scale. `DATE` shows its time, `CLOB` reads as text (JSON when it has an
  `IS JSON` check) and `BLOB` and `RAW` as bytes. Oracle stores `''` as NULL, so an empty cell you
  submit reads back as NULL.
- **Scripts.** A PL/SQL block ends at a `/` line and keeps its `;`; a plain statement loses its
  trailing `;` before it is sent. `DBMS_OUTPUT.PUT_LINE` lines show in Output after each statement,
  and a procedure that compiles with errors lists them, with line and column, as warnings.
- **Transactions.** Oracle commits each DDL statement on its own, so `CREATE TABLE` in a manual
  transaction commits what came before it; the table designer says so before it runs.
- **Completion** offers every function of the _SQL Functions_ chapter for the server's version
  (`SYSDATE` without parentheses, `EXTRACT(YEAR FROM …)` with its argument in bold) and the members
  of `DBMS_OUTPUT`, `DBMS_LOB`, `DBMS_STATS`, `UTL_RAW` and other supplied packages after `pkg.`.
- **Sessions** need `SELECT_CATALOG_ROLE` to list other sessions and `ALTER SYSTEM` to cancel or
  kill them; without it the tab lists your own session and says what to ask for.

See [Oracle](../design/specification.md#oracle).
