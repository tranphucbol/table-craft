# 118: SQL snippets are profile templates

Status: Accepted

Decision 119 supersedes the SQL-only model, scope selection and version-1 storage described here.
This record preserves the original decision; profile ownership, plain-text storage and native
template expansion remain in effect. See [119](119-snippets-are-scoped-text-templates.md) for the
generic model and lossless version-1 migration.

## Decision

SQL snippets are user-authored application templates stored in a versioned
`<userData>/snippets.json` document, separate from preferences in `settings.json`. Main owns the
document and serializes atomic CRUD writes. The renderer reads and changes snippets only through
typed, validated preload IPC. A new profile starts with an empty collection.

Each snippet has `id`, `name`, `prefix`, `body` and `dialect: string | null`. Null means all SQL
dialects; a string matches manifest `highlight` metadata, not a plugin id. Completion is enabled
only for consoles whose plugin declares `sql`. Snippets coexist with engine and keyword
completion and are managed by the **SQL Snippets…** action.

Expansion uses native CodeMirror snippets without a new dependency. `${table}`, `${schema}` and
arbitrary named fields are editable text; repeated names are linked. No field is filled from the
database. `${cursor}` is the final zero-width caret position. Tab and Enter accept a snippet from
completion, and Tab and Shift+Tab navigate its fields. Expansion inserts text, never executes it.

## Rationale

A template is editor content, not knowledge of SQL syntax. Recognizing template markers in the
renderer does not parse SQL or move completion, classification or statement boundaries out of the
plugin (decision 008). Neither the plugin API nor its version needs to change. Asking every plugin
to implement snippets would duplicate a host editing feature and tie personal templates to drivers.

Profile storage makes a template available across data sources and survives engine restarts.
Dialect metadata lets different plugins using the same SQL dialect share templates without
branching on plugin identity (decision 007). The capability check keeps SQL templates out of
non-SQL languages.

A separate document keeps a collection of user-authored bodies out of preferences and gives it
its own validation and versioning lifecycle. Main already owns profile files; atomic replacement
and serialized mutations prevent partial documents and lost updates from overlapping CRUD calls.
CodeMirror already provides linked fields and field navigation, so another template engine is
unnecessary.

## Consequences

- Snippets are local plain-text content, not synchronized, encrypted or a place for secrets.
- A fresh installation offers no snippet completions until the user creates a snippet.
- Validation and I/O errors must be actionable and must not silently replace corrupt content with
  an empty collection. The manager guards unsaved edits and reports failed operations.
- SQL execution, parameter binding and destructive-statement confirmation remain unchanged.
- Catalog-aware field defaults, snippet sharing/import/export and non-SQL templates are outside
  this decision.
