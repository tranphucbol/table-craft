# 098: Signature help is answered by the plugin

Status: Accepted. Plugin API 0.28.0.

## Decision

The parameter hint asks the engine which call the caret is in; the renderer parses no SQL.

- **`SqlLanguage.signatureAt?(request, catalog)`** answers `SignatureHelp | null`: `{ name,
summary, signatures, argument, from, to }`, where `argument` is the zero-based argument the caret
  is in and `from`/`to` span the call from its name to its `)` (or the caret when unclosed).
  `sqlCompleter` supplies it from the same specs and server range as completion (decision 097).
- **One shared scanner.** `callAt` in `@table-craft/plugin-api/sql/signature.ts` reads the tokens
  of the statement around the caret (`statementTokens`, the lexer completion already uses), so
  strings, comments and quoted names are whole tokens and their commas never count. It keeps a
  stack of open parentheses before the caret: a `(` after a known, available function name opens
  a call; a grouping `(` (after an operator or `AND`, `WHEN`, …) is looked through; a subquery,
  a name that is not a function (`IN (`, `t (`, `TABLE x (`) or a caret in a literal ends with
  null. A function spelled like a keyword (`VALUES`, `LEFT`) is a call only where an operand fits.
- **The engine method is `completion.signature`** with `text`, `offset` and the bars' `scope`; a
  plugin without `signatureAt` answers null.
- **The renderer shows a CodeMirror tooltip** (`renderer/console/signatureHint.ts`) above the call:
  each overload on a line with the active parameter bold, an outgrown overload dimmed, the summary
  under them. It asks when `(` or `,` is typed, on every edit or caret move while it shows, and on
  Parameter Info (`⌘P`, `editor.parameterInfo`, in the console and the table editor's bars). It
  closes when the answer is null, on Escape after the completion popup's, and on blur. A response
  a newer request has overtaken is dropped.

## Rationale

DataGrip shows a call's parameters as you type its arguments; with the specs in place the only
missing piece is knowing which call and which argument the caret is in. That is SQL knowledge, so
by decision 008 it belongs to the plugin, and the shared tokenizer already knows each dialect's
strings, comments, quoting and delimiters. A second scanner in the renderer would disagree with the
plugin on MySQL's `#` comments or backslash escapes.

Asking on `(` and `,` rather than on every keystroke keeps idle typing free of engine calls; once
the hint shows, re-asking on each change keeps the bold parameter right and closes it when the
caret leaves the call, with no renderer-side bookkeeping of parentheses.

Alternatives considered: computing the hint in the renderer from the completion item it accepted
(breaks on a call typed by hand or reopened later); hover documentation (out of scope, plan 052).

## Consequences

- The hint is an engine round trip per keystroke while open; stale answers are dropped, and a
  disconnected datasource shows none.
- A plugin can supply `signatureAt` without `sqlCompleter`; the renderer only reads the answer.
- User-defined functions get no hint until completion knows them (later work).
