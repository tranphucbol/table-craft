# 091: File size budget and module layout of the engine

Status: Accepted. Extends 002 and 015.

## Decision

A source file holds at most 800 code lines. ESLint's `max-lines` (`skipBlankLines`,
`skipComments`) enforces it on every file under `packages/*/src` and `plugins/*/src`
(`MAX_LINES` in `eslint.config.js`). Files that were over it when the budget arrived are listed
in `OVERSIZED_FILES` beside it, each with the split it is waiting for, and the list only shrinks:
`test/desktop/lintBudget.test.ts` fails once a listed file fits, so it must leave the list.

The engine, the largest file before this decision, takes this layout under
`packages/desktop/src/engine/`:

- `protocol.ts` is a barrel of `export * from "./protocol/<area>.js"`. Each area holds one slice
  of the wire contract: `wire` (port messages, result sizes, wire values, capabilities, boot,
  probe, paging), `datasource` (config, SSH, TLS, host keys), `sessions`, `sql` (classification,
  formatting, explain), `catalog` (catalog, completion, navigation), `objects`, `results`,
  `transfer` (export, import, scripts, `EngineEvent`), `tables` (table editor and edits) and
  `calls` (`EngineCalls`, the request and result helpers, the error types). An area imports
  nothing but its siblings, with `import type`; ESLint enforces it. Every importer keeps using
  `@table-craft/desktop/engine/protocol.js`.
- `engine.ts` keeps the public surface (`createEngine`, `Engine`, `EngineOptions`,
  `EngineConnection`, `datasourceConnector`, `probeDatasource`), request parsing, dispatch and
  `close`.
- `failures.ts` holds `EngineFailure`, `toEngineError`, the hints and the helpers that build a
  typed failure. `connect.ts` opens a plugin session with the engine's connect options.
- `context.ts` builds the `EngineContext`, the state one engine shares across its connections
  (logging, the SQL language, the result store, introspection and the catalog), with
  `transfers.ts` (export, import and script tasks) and `objectChanges.ts` (DDL design and apply).
- `connection.ts` builds the `ConnectionContext`, one per port: its sessions, handles and cursors,
  their lifecycle, keep-alive and reconnection. `statements.ts` adds the runners every route
  shares (`runStatement`, `explainStatement`, `queryTable`, `submit`, `transact` and the rest).
- `routes/<prefix>.ts` holds the handlers of one method prefix, as
  `<prefix>Routes(connection): RoutesFor<"<prefix>">`. `routes/index.ts` lists the groups in
  `ROUTE_GROUPS` and merges them into a `Routes` value, a mapped type over `EngineMethod`, so a
  method without a handler, or a handler without a method, does not compile.

Adding an engine method means: its request and result in the right `protocol/<area>.ts` and in
`EngineCalls` (`protocol/calls.ts`), its handler in `routes/<prefix>.ts`, and, for a new prefix,
a new group in `ROUTE_GROUPS`. A new protocol area is a new file under `protocol/` and one more
line in the barrel.

## Rationale

Plan sessions spent most of their tokens re-reading. `engine.ts` (2,400 lines) and `protocol.ts`
(1,468 lines) were touched by nearly every plan, read in 100 to 200-line slices because a whole
read was too large, and read again after every context compression. A median plan session took
418 steps, four of five with a single tool call, at an average context of 108K tokens. Files that
fit one read, named by what they hold, let an agent find a method's handler and its types by
path, read each whole once, and batch reads in one turn.

A budget without enforcement erodes one feature at a time, which is how the engine reached 2,400
lines. `max-lines` measures code, not comments, so the budget never argues against explaining
why. An allowlist that only shrinks lets the budget land now, without splitting every large file
in one change, and keeps a listed file from growing unnoticed into a permanent exception.

The engine is split by what changes together, not by size alone: per-engine state, per-connection
state and per-prefix handlers. Closures over shared state stay closures; the contexts are plain
objects built by functions, so behaviour and the engine suites stay as they were. The protocol
stays one import path, so its 131 importers did not change.

## Consequences

- A change that pushes a file over 800 code lines fails `bun run lint`; split it in that change.
- `OVERSIZED_FILES` starts with `packages/plugin-api/src/testing/index.ts` (2,085 code lines)
  and `packages/desktop/src/renderer/state/consoles.ts` (1,659). Each needs its own split.
- The contexts' types are inferred from the functions that build them, so a new member is
  visible to every route without a hand-written interface; the cost is that a reader finds a
  member's definition by searching `context.ts`, `transfers.ts`, `objectChanges.ts`,
  `connection.ts` or `statements.ts`.
- Protocol areas may reference each other in cycles; they are type-only, so no runtime cycle
  follows.
