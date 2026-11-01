# 146: Console find runs in the renderer on CodeMirror's search

Status: Accepted.

## Decision

The SQL console's find and replace bar (plan 139) searches the editor's own document in the
renderer, with `@codemirror/search` as its engine: its `SearchQuery`, cursors, match highlighting,
`findNext`, `replaceNext`, `replaceAll` and `selectMatches`. TableCraft draws the bar itself, in
React, through the `createPanel` hook `search()` takes, and keeps what CodeMirror lacks in one
state field beside the query (`console/find/findState.ts`): the replace row, Preserve Case, the In
Selection ranges and the excluded matches. In Selection and Exclude reach CodeMirror through the
query's `test` callback, so finding, highlighting, counting and Replace All all honour them.

Every console query is literal (`literal: true`): `\n` is a backslash and an `n` until Regex is on,
as in DataGrip. The find chords are actions (decision 015) that reach the view through `editorOf`;
`Escape`, `F3` and `Shift+F3` stay in CodeMirror's keymap and are reserved in the editor and the
bar's fields.

## Rationale

The grid's find runs in the engine on display text (decision 050) because the rows live there
(decision 009). The console's text is the opposite case: the document is already in the renderer,
in CodeMirror, and every edit, the undo history and the selections are CodeMirror's. Sending the
text to the engine to search it would copy up to tens of megabytes per keystroke and still need
CodeMirror to apply the replacement and select the matches.

Finding text is not SQL knowledge (decision 008): the bar matches characters, never statements,
comments or literals, so nothing here parses SQL. A filter by comments or string literals, as
DataGrip offers, would need the plugin's tokens and is left out for that reason.

CodeMirror's stock panel was the other choice. Restyling it cannot give DataGrip's layout (the
toggles inside the field, the counter, the replace row's own toggle, the history), and its inputs
are plain DOM outside the action registry. Keeping its search engine and replacing only the panel
keeps the matching, highlighting and undo behaviour CodeMirror already gets right.

## Consequences

- The bar's state lives in the `EditorState`; a console's bar, query and scope survive a tab
  switch because the saved editor keeps them beside the undo history.
- Counting is capped at 10,000 matches so a pattern matching every character of a large paste
  still answers at once; Select All Occurrences keeps CodeMirror's limit of 1,000 cursors.
- Preserve Case is TableCraft's own replacement, off while Regex is on, where CodeMirror expands
  `$1`.
- The history of queries and replacements is in memory for the session only.
