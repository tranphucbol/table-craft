# 097: Function specs with server ranges

Status: Accepted. Plugin API 0.28.0.

## Decision

Completion offers a database's built-in functions as data the plugin owns, not as bare names.

- **`FunctionSpec`** in `@table-craft/plugin-api/sql` is `{ name, signatures, summary, category,
available? }`. `signatures` lists every overload as `{ parameters: { name, optional?, variadic?
}[], returns }`; `summary` is one line on what the function does; `category` groups the list
  (string, numeric, datetime, json, aggregate, window, …). Plugins write entries as tuples
  `[name, "str, len? -> string", summary, available?]` read by `functionSpecs`, where `?` marks an
  optional parameter and `...` a variadic one.
- **`ServerRange`** is `available`: per flavour, `false` or space-separated comparators on a dotted
  version (`">=8.0.4"`, `"<8.0"`, `">=5.0 <7.5"`). A flavour it does not name gets the function in
  every version; a spec without it is everywhere. `isAvailable(spec, server)` answers true for an
  unknown server, so an unread version offers the union of every flavour's functions.
- **The catalog carries the server.** `CompletionCatalog.server` is `{ version }`, the
  introspection session's `serverVersion`, null when not known. `CompleterOptions.server` is the
  plugin's reader from that string to `{ flavour, version }`; MySQL's `serverIdentity` reads
  `8.4.0` as MySQL and `5.7.25-TiDB-v4.0.14` as TiDB 4.0.14.
- **`CompleterOptions.functions`** takes plain names or specs. A spec's item carries `detail` (the
  first overload), `info` (every overload and the summary), `apply` (`name()`) and `caret` (where
  the caret lands in `apply`, inside the parentheses when any overload takes an argument).
  `CompletionItem` gains `info` and `caret`, null for every other item.
- **Keyword-named functions** (`IF`, `LEFT`, `REPLACE`, `VALUES`, …) are offered once, as the
  function, where an expression goes; keyword positions keep the keyword.
- **The lists are the project's own words.** Each data file names the manual pages it follows in
  its header; summaries are written for TableCraft and never copied from a manual.

## Rationale

Completion knew five MySQL functions and nothing about their arguments, so the popup could not
say what `date_format` takes and offered `PASSWORD` to MySQL 8.4, where it no longer exists. A
spec gives the popup a signature and a line of documentation and gives the parameter hint
(decision 098) its overloads from the same data.

The version lives on the catalog because `SqlLanguage` is a module-level value with no session;
the engine already holds the introspection session, so passing its `serverVersion` costs one field.
Ranges are strings per flavour rather than a closed enum so a third-party plugin can name its own
flavours and versions without a contract change.

**TiDB stays a flavour of the MySQL plugin.** A separate TiDB plugin would duplicate the MySQL
driver, introspection and dialect for a list of functions that differs in a few dozen names. The
range's flavour key carries the difference, and the plugin already tells TiDB apart for KILL and
EXPLAIN (`server.ts`).

Alternatives considered: asking the server for its function list (MySQL exposes no catalog of
built-ins; `mysql.help_topic` is often empty and TiDB has none); one list per server version
(unbounded duplication); a `deprecated` flag instead of ranges (cannot say a function arrived in
8.0.4).

## Consequences

- The MySQL plugin knows 356 functions: MySQL 8.4 is offered 327, MySQL 5.7 294, TiDB 4.0.14 248
  and TiDB 8.5 283, the subsets their manuals and a live probe of 8.4.11 and 4.0.14 confirm
  (`plugins/mysql/src/functions/`). TiDB functions the v4.0 manual
  leaves out but the current manual lists are offered from TiDB 5.0 (`TIDB_AFTER_4`), since the
  first release with each is not pinned; a 4.x server past 4.0.14 may lack one we offer or have
  one we hide.
- PostgreSQL and SQLite keep their short lists, wrapped as specs; their full lists are later work.
- A spec's `summary` is shown verbatim; keeping the lists current with new server releases is
  manual work, checked by `test/plugins/mysqlFunctions.test.ts`.
- `CompletionItem` and `CompletionCatalog` changed shape, so the API is 0.28.0.

## Amendment: call shapes (plan 115)

Oracle and SQL Server write functions three ways the first shape could not say, so their lists would
have inserted broken SQL or bolded the wrong parameter:

- **Bare functions.** `FunctionSpec.bare` (written `"= type"`) marks a function called without
  parentheses (`SYSDATE`, `CURRENT_USER`, `@@ROWCOUNT`); its item applies the name alone and it
  has no hint. An entry mixing `"= type"` with called signatures throws: a function with both
  forms (MySQL's `CURRENT_DATE`) is written `"-> type"` and stays called.
- **Keyword-led parameters.** `FunctionParameter.lead` is the keyword before a parameter instead of
  a comma (`EXTRACT(unit FROM date)`, `CAST(expr AS type)`), `|` separating alternatives. An
  upper-case word right after a comma stays part of the argument's name (`date, INTERVAL expr
unit`). `CallAt.separators` lists the call's top-level commas and words, and the shared
  `signatureAt` walks them through the overload whose leads they follow most; a word no parameter
  leads with moves nothing, so `CAST(x AS DECIMAL(10, 2))` stays in `type`.
- **Package members.** A spec named `PKG.MEMBER` is offered after `pkg.` and `callAt` joins `pkg .
member (` into one name; a plain name never matches it, and a relation of that name keeps its
  columns first. A signature returning nothing (`"line ->"`) is a procedure's.

All three are optional, so the API is 1.4.0. `CallAt.separators` is optional in the type though
`callAt` always sets it, since a required member would break a value built against 1.3.0.
