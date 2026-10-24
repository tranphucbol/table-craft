# 090: Routine calls are written by the plugin

Status: Accepted. Plugin API 0.26.0.

## Decision

Calling a function or procedure with arguments is the `routineCall` capability. It requires `sql`
and `schemaTree`, because the call runs in a console and is built from the routine the
introspector describes.

- **Introspection describes parameters.** `Routine` gains `signature` (the argument list as the
  database prints it), `parameters` (`name` or null, `type`, `mode` `in | out | inout | variadic`,
  `hasDefault`, in declaration order) and `returns` (a function's result as the database prints
  it, null for a procedure). Name, kind and signature are unique in a namespace, so each PostgreSQL
  overload is its own routine and MySQL lists a function and a procedure of one name both.
  PostgreSQL reads `pg_proc` and `pg_get_function_identity_arguments`; a `RETURNS TABLE` column is
  part of `returns`, not a parameter. MySQL reads `information_schema.PARAMETERS`.
- **The plugin writes the call.** `SqlLanguage.routineCall(routine, qualifiedName, args)` takes one
  `RoutineArgument` per parameter (`{ kind: "value", value }` or `{ kind: "default" }`; an `out`
  entry is ignored) and returns `RoutineCall { sql, params }`: console text, one statement per
  line, with a named `:marker` for every value, and the value of each marker. The marker is the
  parameter's name when it is a plain identifier, else `:arg<position>`, made unique
  (`routineSlots` in `@table-craft/plugin-api/sql`). Arguments that do not fit (wrong count,
  DEFAULT without one, an unnamed parameter after a skipped default) throw `statementFailed`.
- **PostgreSQL** writes `SELECT * FROM f(CAST(:a AS numeric), …);` for a function and
  `CALL p(CAST(:a AS integer), CAST(NULL AS numeric));` for a procedure, whose OUT values come back
  as the CALL's row. Each value is cast to its declared type except pseudo-types; a skipped default
  leaves its argument out and the arguments after it switch to named notation. **MySQL** writes
  `SELECT f(:a) AS f;`, or for a procedure `SET @outN = :b;` per INOUT value, `CALL p(:a, @out2, …);`
  and `SELECT @out2 AS total, …;`. **SQLite** has no routines and does not declare it.
- The engine answers `routine.call { path, name, kind, signature, args }` from the cached catalog,
  describing the namespace afresh once when the routine is missing, and the renderer's Execute
  Routine dialog runs the text in a new console with the values bound by the driver (decision 043).

## Rationale

The SQL that calls a routine is dialect knowledge: PostgreSQL needs `SELECT * FROM` for set results,
`CALL` for procedures, casts to pick an overload and named notation past a skipped default; MySQL
needs session variables for OUT and INOUT. Decision 008 puts that in the plugin, as it put the SQL
Generator there. Returning console text with markers, rather than running the call in the engine,
lets the result, OUT values, messages and history flow through the console exactly as for any
parameterised statement, and the user can open the same text without running it. Values stay
bound, never interpolated, so a value cannot change what runs.

Introspection had to grow anyway: the dialog needs each parameter's mode, type and default, and a
routine keyed by name alone could not tell PostgreSQL overloads apart.

## Consequences

- The plugin contract changes; API 0.26.0. A plugin declaring `routineCall` needs the contract
  fixture's `routines` (the described routines and four calls).
- PostgreSQL overloads list once each under Routines, and MySQL lists a procedure that shares a
  function's name. Rename and Drop of an overloaded PostgreSQL function still name it without its
  signature.
- A call runs in a new console each time, so it never replaces the user's text, transaction or
  MySQL session variables.
