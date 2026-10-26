# 118: Grid helpers compute and touch files in the engine

Status: Accepted

## Decision

The selection aggregates, Save Value to File, Load File into Cell and the image preview of a
binary value all run in the engine, beside the rows they read (decision 009):

1. `result.aggregate` computes Count, Distinct, Sum, Avg, Min and Max over the selected shown rows
   and visible columns. Integers and decimals add as scaled big integers, exactly; a `float` cell
   makes the whole answer float arithmetic. The renderer only formats the answer.
2. Main's dialogs pick a path and nothing more (`dialog.saveFile`, the new `dialog.openAnyFile`).
   The engine writes the value (`result.saveBytes`) or reads the file (`result.loadBytes`); the
   renderer never holds a path's contents.
3. A loaded file stays in the engine, keyed by an id, for the result that loaded it; the edit
   buffer holds `{ kind: "bytes", id, length, preview }`. Preview Pending Changes writes the
   clipped literal with its `/* 32 of N bytes */` comment, Submit the whole value. Releasing the
   result drops what it staged.
4. When the grid holds only a value's 32-byte preview, the engine re-reads the whole value by the
   table's key on a read-only session, with `fullBytes`. A result with no table identity says to
   open the table instead.
5. One setting, `data.blobLimitMb` (1–128 MiB, default 16), bounds both directions.

## Rationale

A selection may span many thousands of fetched rows that only the engine holds; shipping them to
the renderer to sum would undo decision 009, and summing decimals as JavaScript numbers would
show `0.30000000000000004` to a user checking money. Exact scaled arithmetic costs little.

Files follow the export precedent (decision 040): main is not in the request path (decision 002)
and the renderer is sandboxed, so the process that owns the data owns the file. Staging the file
in the engine keeps a 16 MiB value from crossing the MessagePort twice and from sitting in the
undo-free edit buffer as hex. No plugin contract change is needed: `fullBytes` (contract 0.12.0)
and `language.literal` already cover reading and writing whole values.

The limit stops at 128 MiB because a value travels as hex text and V8 strings cap near 512 MiB;
anything larger belongs in a real file workflow, not a cell.

## Consequences

- A console result that is not editable cannot re-read a clipped value; a short one (whole in the
  preview) still saves and previews.
- A staged file is lost if the result is released (Rerun, Reload, closing the tab); Submit then
  refuses it and says to load the file again.
- The image preview needs the whole value, so a large image on a non-editable result shows hex
  only.
