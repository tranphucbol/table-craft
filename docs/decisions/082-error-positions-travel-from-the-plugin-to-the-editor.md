# 082: Error positions travel from the plugin to the editor

Status: Accepted.

## Decision

A failed statement is underlined where the database says it failed, and the position takes one
path from the plugin to the editor.

- `PluginError` gains an optional `position`: `{ offset }` (UTF-16, from 0) or `{ line, column }`
  (from 1), relative to the SQL the plugin was given. `errorPositionOf` reads it structurally and
  `offsetOfPosition` turns either form into an offset, clamped to the text. `API_VERSION` moves to
  `0.25.0`.
- Each built-in plugin parses its own driver's error, because only it knows the shape: PostgreSQL
  reads the server's `position` (code points, converted to UTF-16); MySQL and TiDB read the line and
  the `near '…'` fragment of a syntax error; SQLite reads `near "…"`, `no such column` and
  `no such table`, and gives a position only when the token occurs once as a whole word. The
  contract suite checks one syntax error per dialect.
- The engine forwards it as `EngineError.position`, an offset into the SQL of the request, only for
  `statementFailed`, and only when the SQL it sent is the SQL it received: bound parameters rewrite
  the text, so a run with parameters, Explain and Rerun carry no position. A script failure carries
  `at: { line, column }` in its file.
- The console adds the statement's offset, widens a position on a word to the whole word, and keeps
  the mark in `ConsoleSession.errorMarks` with the statement's span and the message. The editor
  draws marks as a wavy underline, a gutter dot and a hover with message and hint; marks move with
  edits, and an edit inside a mark's statement, or a run of that statement, removes it.
- **Go to Error** beside Show in Log, and **Next Error** (`F2`) and **Previous Error** (`⇧F2`),
  move the caret to a mark.

## Rationale

A message like `syntax error at or near ","` in a 40-line statement makes the user hunt. Every
supported database reports where, in a different shape, and the driver error never leaves the
engine (decision 009 keeps results there; errors cross as `EngineError`), so the plugin is the only
place that can read it (decision 008). A structural position on `PluginError` keeps the contract
additive for third-party plugins: one without positions still runs, unmarked.

Parameters are substituted before the plugin sees the text; mapping a position back through the
substitution would guess, and a wrong underline is worse than none.

The marks are drawn by a small CodeMirror field of our own rather than `@codemirror/lint`: lint
recomputes diagnostics from a source, while these marks come from a past run and must survive and
move with edits until their statement changes.

## Consequences

- Errors without a parsable position (a constraint violation, a runtime error) are not underlined;
  the message still reaches Output and the toolbar.
- MySQL reports only the line and a fragment; when the fragment repeats on the line, the mark lands
  on its last match.
- Plugins built against `0.24` must be rebuilt, as every minor is a break while the contract is
  `0.x`.
