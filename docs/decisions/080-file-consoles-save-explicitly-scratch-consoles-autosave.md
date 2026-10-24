# 080: File consoles save explicitly, scratch consoles autosave

Status: Accepted.

## Decision

A console has a source: `scratch`, the profile-owned file under
`<userData>/consoles/<datasourceId>/` that autosaves (plan 011), or `file`, a `.sql` file the user
chose anywhere on disk. Both are the same console: the same editor, toolbar, session, datasource
and namespace. Only the source differs.

- A file console saves only when asked (`⌘S`). It is dirty while its text differs from what was
  last read or written; the tab shows a dot, and closing or quitting asks Save / Don't Save /
  Cancel. Scratch consoles keep autosaving and never ask.
- **Save As…** turns any console into a file console at the chosen path; **Rename Console…**
  renames a scratch console within the name pattern, or the file on disk within its folder.
- Main reads and writes the files, over `sql-files.*` channels; the renderer never touches the
  disk. Reads are strict UTF-8 with the BOM stripped; writes keep the file's line endings, never
  add a BOM, and go beside the file then rename over it.
- Main remembers each file's datasource and namespace and the last ten files in
  `<userData>/fileAttachments.json`. A file console opens on its remembered datasource when it
  still exists, else the one in focus, else detached (datasource id `""`): its first Run asks for
  one. Removing a datasource detaches its file consoles rather than closing them.
- On window focus main stats the open files: a clean console reloads, a dirty one shows a
  changed-on-disk banner with Reload and Keep mine.

## Rationale

Users keep migrations and reports in their project, often under Git. Autosaving into a file they
own would write half-typed SQL into a working tree, and every keystroke would show in `git status`;
an editor that saves on `⌘S` is what DataGrip and every IDE does for project files. Scratch
consoles are the opposite: nobody wants to name or save a quick query, so they keep autosaving.

One console type with a source keeps run, results, transactions, completion and the namespace
switcher identical for both, instead of a second editor that drifts. A detached state, rather than
refusing to open a file without a datasource, lets a user open a file first and choose where to run
it later.

Checking on window focus instead of a file watcher catches the common case, a `git checkout` or an
editor in another window, without holding watchers on files in network folders or across sleep.

## Consequences

- The layout's `openConsoles` entries carry a `path` for file consoles; a missing file is skipped
  with one notice.
- A change made on disk while the window stays focused is noticed only on the next focus.
- Files above 32 MiB do not open in the editor; they run with Run SQL Script (decision 081).
- Non-UTF-8 encodings are refused, naming the first bad byte, rather than guessed.
