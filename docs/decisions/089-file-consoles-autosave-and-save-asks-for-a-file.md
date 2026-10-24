# 089: File consoles autosave, and Save on a scratch console asks for a file

Status: Accepted. Supersedes the explicit-save part of decision 080.

## Decision

The user asked for DataGrip's behaviour, so TableCraft now saves the way DataGrip does.

- A file console writes its file by itself. Once typing pauses for `AUTOSAVE_DELAY_MS` (500 ms,
  the same as scratch consoles), it writes the file. It also writes what is pending when the window
  loses focus, before a tab closes, and before the app quits. The tab's dot means only that a
  write is still pending or failed.
- Before an autosave, the renderer stats the file. If the file changed or went away since it was
  last read or written, the autosave writes nothing and shows the changed-on-disk banner from
  decision 080. **Keep mine** writes the editor's text over the change, and **Reload** takes the
  file's text. Closing or quitting asks Save / Don't Save / Cancel only for a file in that state
  or one whose write failed.
- **Save** (`⌘S`) on a file console writes the file now, over any change on disk. On a scratch
  console it opens the save dialog, like **Save As…** (`⇧⌘S`), and the console becomes a file
  console. **Save As…** always asks for a path.
- A failed autosave shows one notice. The console stays dirty, and each later pause tries the
  write again.

The rest of decision 080 still holds: sources, attachments, recent files, strict UTF-8, line
endings and the focus check.

## Rationale

Decision 080 kept half-typed SQL out of the user's working tree. It did that by making file
consoles the only place in the app that needs `⌘S`. Users coming from DataGrip expected the
opposite. In DataGrip `⌘S` on a scratch console means "keep this as a file", and files save
themselves. They read the silent `⌘S` on a scratch console, and the dirty prompt on close, as the
save shortcuts not working. DataGrip parity is the product's stated aim, so the user's request
decides it.

The stat before each write keeps the safety that mattered most in 080: an autosave never overwrites
a `git checkout` or another editor's change without asking. A pause of a few hundred ms costs one
stat on the main process and is far cheaper than a file watcher (080's rationale).

## Consequences

- Half-typed SQL reaches the file on disk and shows in `git status`, as it does in DataGrip.
- Close and quit prompts for file consoles are rare. They come only from a conflict on disk or a
  failed write.
- `fileConsoles.autosave()` and `flush()` own the file writes. Scratch consoles keep their own
  autosave in `state/consoleFiles.ts`.
- An external change made between the stat and the write can still be overwritten. The window
  between them is one IPC round trip.
