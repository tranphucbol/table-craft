# 103: Oracle schemas are namespaces, and packages are routine owners

Status: Accepted. Plan 054. Plugin API 1.5.0.

## Decision

- The Oracle plugin's namespaces are schemas, one level deep: every user owning an object, plus
  the current schema, with the current one first and `ORACLE_MAINTAINED` ones marked system. A
  database is a connection, not a tree level.
- A package is not a namespace. Its members are routines of the owning schema named
  `PACKAGE.MEMBER`, one row per overload, told apart by `SUBPROGRAM_ID` and their signatures.
  Execute Routine calls `PACKAGE.MEMBER` like any other routine.
- `ALTER SESSION SET CURRENT_SCHEMA = x` is Oracle's switching statement. The shared kit gains a
  third `NamespaceStatementForm`, `alterSessionSchema`, next to `use` and `searchPath`:
  `classify` marks it `setsNamespace`, completion offers schemas in its slot, and
  `namespaceSwitcher("alterSessionSchema")` writes it. It does not commit, so it is not
  transactional; `currentNamespace()` reads `SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA')`.
- DataGrip stores Oracle connections as JDBC URLs (`jdbc:oracle:thin:@//host:1521/service`,
  `@host:1521:SID`). The importer rewrites them to the plugin's `oracle://` form, with
  `connect_by=sid` for the SID form, before matching a plugin; a TNS descriptor stays as it is
  and is reported unsupported.

## Rationale

Oracle's schema is its user, and a package is a compilation unit, not a scope a session can be
in: no statement makes a package current, and its members are called through the package name.
Listing members under their schema keeps the Routines folder and Execute Routine unchanged, and
the dotted name is what the user types. A new namespace form in the kit, rather than Oracle code
in the plugin, keeps the script step of decision 048 (the nearest switching statement before the
caret) working the same for every dialect.

## Consequences

- `NamespaceStatementForm` gains a value. It is a type a plugin passes to the kit, never one the
  host sends to a plugin, so it is an addition (decision 106); `compatibility.json` records it.
- A package with hundreds of members lists them all under Routines; the tree's filter finds one.
- Packaged function data (`DBMS_OUTPUT.PUT_LINE`) is offered only after the package prefix, as
  plan 115 made `PKG.MEMBER` specs behave.
