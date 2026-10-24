# 081: SQL scripts stream through the plugin splitter

Status: Accepted.

## Decision

**Run SQL Script…** runs `.sql` files without opening them, as a background task of the engine,
like an import (decision 046).

- The engine reads each file in chunks, decodes them as strict UTF-8 (`utf8Decoder` in core, BOM
  stripped, the first bad byte named) and feeds them to the plugin's `SqlLanguage.splitStream()`,
  executing each statement as soon as it is complete. The text never reaches the renderer and is
  never held whole.
- `splitStream` is optional in the plugin contract. `@table-craft/plugin-api/sql` builds it with
  `sqlStatementStream(options)` from the same scanner as `sqlSplitter`: it scans only whole lines
  and rescans an unfinished statement only once its tail has doubled, so the work is linear in the
  file. Its statements equal `split` on the whole text for any cut of the input; the contract suite
  checks it. A plugin without it gets each file split whole, up to 32 MiB. `API_VERSION` moves to
  `0.23.0`.
- The run has a session of its own in auto-commit, never a console's, honouring a read-only
  datasource. Run on a namespace, it first runs the plugin's namespace switch statement.
- Progress (`script.progress`, at most every 200 ms) carries statements done and bytes read of the
  total. Cancel cancels the statement in flight. The run stops at the first error, which names the
  file, line and column; the renderer's **Go to statement** opens the file there.

## Rationale

A dump or seed file can be gigabytes. Reading it in the renderer, or splitting it whole in the
engine, would hold the whole text and every span in memory, and the console's Run All would draw a
result tab per statement. A stream keeps memory flat and shows progress as it goes.

Splitting must stay the plugin's (decision 008): `DELIMITER`, dollar quotes and `BEGIN … END`
bodies are dialect knowledge, and a second splitter would disagree with the console's. Building the
stream from the same scanner, restarted from the last statement boundary, keeps one source of
truth; the equivalence test pins it.

A dedicated session keeps a long script from blocking the console the user is typing in, and
auto-commit matches running the file with `psql -f` or `mysql < file`.

## Consequences

- A statement's position is reported in UTF-16 offsets plus 1-based line and column, so the editor
  can jump to it.
- Stop at first error is the only mode; plan 042 adds continuing past errors.
- A third-party plugin built against `0.21` must be rebuilt, as every minor is a break while the
  contract is `0.x`.
