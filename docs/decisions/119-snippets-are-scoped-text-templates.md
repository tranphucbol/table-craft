# 119: Snippets are scoped text templates

Status: Accepted

## Decision

Generalize decision 118's SQL-only templates to desktop-owned `TextSnippet { id, name, prefix,
body, scope }`. Eligibility requires the existing `sql` or `commands` capability. Scope selects
all eligible text consoles, all SQL consoles, or one plugin by manifest identity. A legacy SQL
scope retaining a highlight restriction exists only to preserve migrated SQL snippets.

The **Snippets…** manager uses **Applies to** and **Snippet body**. Installed eligible plugin
metadata supplies type choices dynamically by id/name, without hardcoded plugin ids. New drafts
default to the active datasource's plugin, otherwise all consoles. Per-plugin matching is by id,
not datasource identity or highlighter. Missing plugin scopes remain saved without broadening.

Store a strict version-2 document in `<userData>/snippets.json`, still owned by main with typed,
validated IPC and serialized atomic mutations. Accept strict version-1 documents in memory:
`dialect: null` maps to all SQL; a dialect string maps to SQL restricted by that legacy highlight.
Reads never rewrite the file. The next successful create, update or delete writes version 2
atomically, preserving records and restrictions. Invalid documents and failed operations report
actionable errors without losing or silently widening existing content.

Native CodeMirror text templating works offline. Named fields are editable and repeated names
linked; `${cursor}` is a final zero-width caret stop. Expansion neither fetches database values
nor executes text. Highlight metadata is syntax metadata, not the identity of a new scope. An
unknown command highlighter uses plain text, with no fallback SQL keyword suggestions.

## Rationale

Reusable text is not specific to SQL: Redis commands need `${key}` just as SQL needs `${table}`.
The host already has SQL and command console hooks. Reusing those hooks avoids adding a snippet
method to every driver, a public plugin API change, or a dependency for generic templating.

Capability checks still decide whether a console participates (decision 007). Plugin identity
then filters personal content, not supported UI behavior. Two command languages may share a
highlighter but not commands, so highlight-based scoping is insufficient. Dynamic installed
metadata allows future plugins to participate without a hardcoded list.

Migration must not turn an old all-SQL template into a suggestion in every command language.
Retaining legacy highlight restrictions also avoids guessing which plugin an old dialect meant.
Read-only migration preserves the original file until a user mutation succeeds and avoids hidden
writes merely from opening the manager or editor.

## Managed native snippet mapping patch

Characterwise editing of linked fields exposed a native CodeMirror bug: an inactive zero-width
stop can grow into a range when its two endpoints map with opposite affinities. The final caret
then selects text instead of remaining collapsed. Patch inactive empty fields as single points,
using textual order relative to the enclosing active occurrence to choose affinity; keep active
fields expandable and retain deletion cancellation. Field numbers cannot determine affinity
because `${0}` may appear before, between or after other fields in the template.

Keep this correction in `patches/@codemirror%2Fautocomplete@6.20.4.patch`, registered for exactly
`@codemirror/autocomplete@6.20.4` in root `package.json` `patchedDependencies`. Bun applies the
managed patch on install to both ESM `dist/index.js` and CJS `dist/index.cjs`; no new dependency is
added. A narrow dependency patch preserves native selection, linked-field navigation, undo and
cancellation rather than introducing a second application-owned snippet tracker.

The upstream source is
[`src/snippet.ts`](https://code.haverbeke.berlin/codemirror/autocomplete/src/branch/main/src/snippet.ts).
`test/renderer/nativeSnippetMapping.test.ts` covers characterwise linked edits, Shift+Tab
retyping, ordinary completion acceptance, cursor affinity around repeated fields, coincident
empty fields, active-empty growth, cancellation/deletion, undo and indentation fallthrough.
Remove the patch and its registration when an unpatched upstream release passes this regression
matrix and the real Redis linked-field scenario. No upstream issue or submission is claimed.

## Consequences

- This supersedes decision 118's SQL-only model and selector, not its profile ownership, native
  expansion, linked fields or plain-text/no-secrets guarantees. New profiles still start empty.
- New plugin-specific templates use plugin identity; legacy SQL highlight scopes remain readable
  and restricted rather than being rewritten as an arbitrary plugin or a broader scope.
- Version 2 is not promised readable by older SQL-only app builds. Preserve the original document
  on failed validation or writes; reads alone never upgrade it.
- SQL and command execution, parameter binding, inspections and destructive guards remain in
  their existing paths. No plugin API changes, driver changes or new dependencies are required.
- A future etcd, Kafka or MongoDB plugin can gain snippets if it implements the existing eligible
  text-console hooks. This feature neither implements those plugins nor promises their execution
  support. Sharing, synchronization and database-autofilled fields remain outside scope.
