# 112: A `commands` capability for non-SQL consoles

Status: Accepted

## Decision

A plugin whose language is not SQL declares `commands` instead of `sql` and exports
`commandLanguage` in place of `language`. The two capabilities are exclusive, and the loader
refuses a plugin that declares `commands` without a `commandLanguage` holding `split`,
`classify` and `complete`. `signatureAt` and `inspect` are optional, as they are for SQL.

The engine keeps one console path. `script.split`, `statement.execute`, completion, signature
help and inspections dispatch to whichever language the plugin has (`consoleLanguage()` in
`engine/context.ts`). A command language binds no parameters, and its completion and inspections
run on a helper session the engine opens on demand, since a command console has no catalog
cache. `Session.execute` takes one command; its `ExecuteResult` may carry a `reply`
(`{ value, text }`) for a scalar answer, which the console writes to Output as
`HGET user:42:profile name → "Ann" · 0.4 ms` instead of opening a result tab.

`StatementClass` gains two optional members: `costly` (a reason the editor underlines as a
warning, never a block) and `confirmByName` (the run confirmation asks the user to type the
datasource name instead of pressing OK). The manifest's `highlight` names the editor's
highlighter; `redis` is a CodeMirror stream language with no SQL keywords.

Redis (plan 058) is the first `commands` plugin: one command per line, `redis-cli` quoting,
`#` comments. MongoDB (plan 059) is the second.

## Rationale

A second console for non-SQL datasources would duplicate run, cancel, history, Output, result
tabs, timeouts and the reconnect logic. Everything the console needs from a language is already
behind the plugin boundary (decision 008): where statements start and end, what they do, how to
complete them. Splitting the capability rather than making `language` polymorphic keeps every
SQL-only path (catalog, table editor, DDL, EXPLAIN, parameters) gated on `sql` as before.

## Consequences

- SQL consoles are unchanged; no SQL plugin sets `confirmByName`.
- A plugin cannot mix both languages in one datasource.
- Features that need SQL text (EXPLAIN, parameters, the formatter, `setsNamespace` replay) stay
  SQL-only unless a command language opts into an equivalent; Redis classifies `SELECT` as
  `setsNamespace` so a reconnect replays it.
