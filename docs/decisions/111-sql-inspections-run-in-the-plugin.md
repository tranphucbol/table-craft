# 111: SQL inspections run in the plugin, live in the editor

Status: Accepted

## Decision

The console checks SQL as the user types. `SqlLanguage` gains an optional
`inspect(request, catalog)` that returns `Problem`s (offsets, severity, inspection id, message)
with `QuickFix`es (text edits and an optional caret). The shared implementation is
`sqlInspector` in `@table-craft/plugin-api/sql`, built on the same lexer, scope reader and name
resolution as `sqlCompleter`; each built-in plugin passes its dialect options and reserved words.

The renderer asks the engine (`inspection.inspect`) 400 ms after the last edit, with the whole
text (capped at 200,000 characters), the console's namespace and the disabled inspections. It
keeps the answer in its own CodeMirror state field, not `@codemirror/lint`, beside the server
error marks of decision 082; where both cover the same text the server mark wins. Alt+Enter
(`editor.showIntentions`) lists the fixes under the caret, then "Suppress for statement"
(a `-- noinspection Id` comment above the statement) and "Disable inspection"
(`editor.inspections.disabled`). `editor.inspections.enabled` turns the whole feature off.

## Rationale

SQL knowledge belongs to the plugin (decision 008), and the completer already resolves names
against the catalog, so inspections reuse it instead of a second parser in the renderer.
Checks run against the cached catalog only: a name is reported unresolved only when the catalog
answered for its namespace, and a column only when every source of its query has known columns,
because a false red underline costs more trust than a missed one. An optional method keeps the
API backward compatible (decision 106); a plugin without it simply gets no live problems.

## Consequences

- Third-party plugins can opt in by spreading `sqlInspector(...)` or writing their own.
- Inspections are heuristic and token-based: some forms (reserved words inside expressions,
  multi-part qualifiers, constant conditions beyond literals) are deliberately not reported.
- New inspection ids extend `INSPECTION_IDS`; the settings reader keeps unknown ids so a newer
  plugin's ids can be disabled too.
