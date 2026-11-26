# Copy Progress and Table Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show live PostgreSQL/MySQL copy progress and let users choose which tables' rows are copied.

**Architecture:** Add a separate copy-progress overlay backed by modal-store state, plus a reusable multi-select picker. Extend both copy coordinators with an optional selected-table set and report schema objects and row batches through their existing progress callbacks. Keep schema creation and data transfer semantics in the coordinators; action handlers only collect selections, show progress, and report completion or failure.

**Tech Stack:** TypeScript, React, Zustand, existing modal components, existing `ProgressBar`, PostgreSQL/MySQL engine clients.

**Spec:** `docs/superpowers/specs/2026-11-26-copy-progress-and-table-selection-design.md`

## Global Constraints

- All tables start selected; schema-only does not show the table picker.
- In schema-and-data mode, create all supported schema objects and copy rows only from selected tables.
- In data-only mode, copy rows only from selected tables; skip all unselected tables in destination checks and writes.
- An omitted selected-table set means all tables, preserving existing callers.
- Progress stays local; do not transmit database content.
- Do not add or run tests unless the user asks. Run typecheck, lint, and build verification.
- Do not add generic cancellation; MySQL DDL commits implicitly.

## Review Focus

- Empty table selection: data-only performs no writes; schema-and-data creates schema but transfers no rows.
- PostgreSQL database copies: qualify table choices by schema so same-named tables remain distinct.
- Data-only preflight: check compatibility and emptiness only for selected tables.
- Progress lifecycle: clear the overlay on success and error, and report the failure after closing it.
- MySQL schema progress: advance after each DDL object, since DDL may commit before the next object.

> Workspace instruction forbids adding or running tests unless requested. Review these cases in code and use typecheck, lint, and build commands instead.

---

### Task 1: Add a reusable multi-table picker

**Files:**
- Modify: `packages/desktop/src/renderer/state/modal.ts`
- Modify: `packages/desktop/src/renderer/dialogs/Modal.tsx`
- Create: `packages/desktop/src/renderer/dialogs/MultiPick.tsx`

**Interfaces:**
- Add `kind: "multiPick"` with a title, search label, `PickItem[]`, initial selected IDs, empty-state copy, and confirm label.
- Resolve answers as a JSON-encoded string array through `multiPickAnswer(ids)` and `parseMultiPickAnswer(answer)`; return `null` for cancellation.

- [ ] Add the `multiPick` request to `ModalRequest`, register it with the picker kinds, and render `MultiPick` from `Modal.tsx`.
- [ ] Implement searchable checkbox selection, select-all, clear-all, and a selected-count summary in `MultiPick.tsx`; confirm returns the chosen IDs and Cancel returns `null`.
- [ ] Run Prettier, targeted ESLint, and `bun run typecheck`; fix any failures.

### Task 2: Add a live copy-progress overlay

**Files:**
- Modify: `packages/desktop/src/renderer/state/modal.ts`
- Modify: `packages/desktop/src/renderer/dialogs/Modal.tsx`
- Create: `packages/desktop/src/renderer/dialogs/CopyProgress.tsx`
- Reuse: `packages/desktop/src/renderer/ui/ProgressBar.tsx`

**Interfaces:**
- `CopyProgressState`: `{ title: string; phase: string; current: string; completed: number; total: number; rowsCopied?: number }`.
- Add `copyProgress`, `showCopyProgress(progress)`, `updateCopyProgress(progress)`, and `clearCopyProgress()` to the modal store.

- [ ] Render a non-dismissable modal overlay while `copyProgress` is set, with phase, current item, completed/total count, row count when available, and determinate or indeterminate `ProgressBar` state.
- [ ] Ensure clearing progress closes only the progress overlay and leaves ordinary confirmation/error prompts working.
- [ ] Run Prettier, targeted ESLint, and `bun run typecheck`; fix any failures.

### Task 3: Add table selection and detailed progress to PostgreSQL copying

**Files:**
- Modify: `packages/desktop/src/renderer/actions/postgresCopy.ts`
- Modify: `packages/desktop/src/renderer/actions/objectActions.ts`

**Interfaces:**
- Extend `PostgresCopyRequest` with optional `selectedTables?: readonly string[]`; table IDs are JSON-encoded tuples (`[tableName]` for schema copy and `[schemaName, tableName]` for database copy) so identifiers containing dots remain unambiguous.
- Continue using `onProgress({ completed, total, current })`; emit `current` updates for each schema DDL statement and each selected table's row batches.

- [ ] In PostgreSQL schema/database copy actions, enumerate source tables, show the multi-pick dialog for modes that copy data, and pass selected IDs to the coordinator.
- [ ] Filter data transfer, destination compatibility checks, and destination emptiness checks to selected tables only. Keep all schema objects in schema-and-data mode.
- [ ] Split PostgreSQL schema DDL into statements and execute statements within the existing transaction, reporting progress per statement; report selected table row batches as rows advance.
- [ ] Handle empty selection according to the spec and include the current schema in database-copy progress.
- [ ] Run Prettier, targeted ESLint, and `bun run typecheck`; fix any failures.

### Task 4: Add table selection and per-object progress to MySQL copying

**Files:**
- Modify: `packages/desktop/src/renderer/actions/mysqlCopy.ts`
- Modify: `packages/desktop/src/renderer/actions/mysqlDatabaseActions.ts`

**Interfaces:**
- Extend `MysqlCopyRequest` with optional `selectedTables?: readonly string[]`; IDs are MySQL table names.
- Preserve `onProgress({ completed, total, current })` and report DDL objects, selected table row batches, and final table completion.

- [ ] Enumerate source tables in the copy action and show the multi-pick dialog for schema-and-data and data-only modes.
- [ ] Keep creating all supported schema objects in schema-and-data mode, but transfer rows only for selected tables.
- [ ] In data-only mode, check table layout and emptiness only for selected tables; empty selection performs no row writes.
- [ ] Emit a progress update after each MySQL DDL statement and each row batch; keep existing rollback and failure behavior for row transactions.
- [x] Allow schema-bearing modes to skip routines, triggers, and events; return omitted-object counts for the completion notice while retaining all other safety checks.
- [ ] Run Prettier, targeted ESLint, and `bun run typecheck`; fix any failures.

### Task 5: Wire progress lifecycle, docs, package, and install

**Files:**
- Modify: `packages/desktop/src/renderer/actions/objectActions.ts`
- Modify: `packages/desktop/src/renderer/actions/mysqlDatabaseActions.ts`
- Modify: `docs/guide/data.md`

- [ ] Start the local progress overlay after the final confirmation and before invoking a copy coordinator; map coordinator progress into overlay state.
- [ ] Clear the overlay in `finally`; show the existing completion/error notice after clearing it, including completed work when the operation stops early.
- [ ] Document table selection and live progress in the copy guide.
- [ ] Run `bun run typecheck`, targeted ESLint, `git diff --check`, and `bun run desktop:package`.
- [ ] Install the newly packaged Windows update and verify its installed `app.asar` matches the packaged artifact and the application opens.
- [ ] Update the open PR #128 description and push the implementation commit to its head branch.

