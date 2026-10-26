# 119: Console replies name the key they read, and whole-key replies edit like the key tab

Status: Accepted (plan 060, Redis console results; amends plan 058 decision 7 and decision 112)

## Decision

A command console on a `keyValue` datasource shows and edits what a command read the way the key
tab does.

- **Value replies open a result.** `CommandReply` gains `read?: boolean`: the plugin sets it for a
  bulk-string reply, and for nil when the command reads exactly one key. The engine holds every
  `reply` as a one-row result with one `value` column; a `read` reply opens it as a result tab and
  keeps its Output line (`GET k → "…" · 0.4 ms`). Status, integer, double, boolean and error
  replies stay Output-only, and their line carries **Show as Result**, which opens the same held
  one-row result. This amends plan 058 decision 7 and decision 112 for bulk strings only.
- **Replies name their source.** `ExecuteResult` gains `source?: KeySource` in
  `@table-craft/plugin-api`: `{ database, key, type, whole }`. Redis fills it when the command's flags include
  `readonly` and its key positions name exactly one key (not `movablekeys`, not fanned out, not
  `QUEUED` inside `MULTI`), reading the type with one `TYPE` on the key's node. `whole` is true
  for `GET`, `HGETALL`, `SMEMBERS`, `LRANGE k 0 -1`, `ZRANGE k 0 -1 [WITHSCORES]` and
  `XRANGE k - +` with nothing else. A whole-key reply uses the key tab's columns (hash `field`,
  `value`; list `#` from 0, `value`; set `member`; sorted set `member`, `score`) and whole bytes.
- **Open Key and formats.** A sourced result shows **Open Key** (`key.openFromResult`, ⌘B in the
  grid) on its toolbar and Output line. The console value panel of a `keyValue` datasource has the
  key tab's Format picker, Auto first, remembered per key pattern; without a source, per result
  tab.
- **Whole keys edit through the key tab's path.** `result.editable` on a command console answers
  editable, with identity `[]` and `key: KeySource`, for a whole string, hash, list, set, or sorted
  set read with scores, on a writable datasource. The renderer turns the buffer into `KeyChange`s
  with the key tab's code, previews with `keyspace.preview` and submits with a guarded
  `keyspace.apply` (decision 115), then runs the command again. Every other command result is
  read-only with its reason.

## Rationale

The plan 058 console printed `GET`'s answer only in Output, so the JSON and gzip values the key
tab decodes were unreadable there, and nothing a console read could be edited. Keeping
`ExecuteResult.reply`'s meaning (columns and rows empty) and adding `read` keeps the contract
additive (decision 106): an older host still prints the Output line, and the engine, not every
plugin, builds the one-row result. The source comes from the command table rather than a list of
command names, so module and future read commands get Open Key without plugin changes; `whole`
stays a short list, because only those forms provably return the entire key. Editing reuses
`keyspace.apply` and its guard instead of a console path of its own, so a console edit and a key
tab edit cannot disagree on conflicts or on the commands they send.

## Consequences

- `HGETALL` now reads `field`, `value` (was `key`, `value`), `SMEMBERS` reads `member`, and a whole
  `LRANGE` numbers from 0; partial reads keep the generic `#`, `value` from 1.
- A single-key read costs one extra `TYPE` round trip, and ships whole bytes.
- A console conflict keeps the edits and points to Refresh or Open Key; the console has no
  Overwrite of its own.
- `API_VERSION` 1.3.0: `CommandReply.read`, `ExecuteResult.source`, `KeySource`,
  `KeySourceFixture` and `KeyspaceFixture.sources`, with a contract test gated on `keyValue`.
- Multi-key edits, partial ranges and live feeds remain out of scope.
