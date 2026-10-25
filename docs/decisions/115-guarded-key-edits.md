# 115: Key edits are guarded, applied as one MULTI, and not undoable

Status: Accepted

## Decision

Key tab edits collect in the edit buffer with the table editor's tints. Preview lists the
commands `keyspace.preview` derives from the pending changes. Submit sends `keyspace.apply`,
which `WATCH`es the key, checks its type and re-reads the original of every element the changes
touch (the string, field, list index or member score), and fails with the new `conflict` error
code when any differs. Otherwise it runs the commands in `MULTI … EXEC`; an `EXEC` aborted by the
watch is a conflict too. On a conflict the key tab offers Reload (drop my changes) and Overwrite
(apply again without the guard). The footer reads "Submit runs as one MULTI · not undoable"
where SQL shows `Tx: Auto`.

A list element is deleted by `LSET` to a unique tombstone and one `LREM` of the tombstone at
the end, so indexes stay valid while the changes run. A string set keeps its TTL (`KEEPTTL`).

## Rationale

Redis has no row identity or transaction log to diff against, and other clients write the same
keys all the time; a blind write would silently overwrite their changes. `WATCH` plus a re-read
of only the touched elements is cheap, needs no server-side script, and works on every supported version.
`MULTI … EXEC` is atomic but does not roll back a command that fails inside it, so the result
cannot be presented as a transaction the user can undo.

## Consequences

- A failing command inside `EXEC` (an index out of range, say) leaves the others applied; the
  error names the command and asks the user to reload.
- Read-only datasources refuse every keyspace write in the plugin as well as in the UI.
- When a key disappears while open, its tab offers Recreate, which writes back the rows read
  last as pending inserts (streams get new ids).
