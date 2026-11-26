Plan: docs/superpowers/plans/2026-11-26-copy-progress-and-table-selection.md
BASE: a1261b6a9e6beccca737d53e9905f10889fa4863
Ruling: Use JSON-encoded table identity tuples for PostgreSQL selections — schema/table names may contain dots, so concatenation is ambiguous — cost if wrong: picker IDs could collide or fail to match a valid table.
Constraint: No tests added or run; workspace instructions forbid them unless requested. Use typecheck, lint, build, packaging/install checks.
Task 1: complete (searchable checkbox picker, JSON-safe answer parsing; targeted ESLint and bun run typecheck passed)
Task 2: complete (local live overlay with cumulative steps, phase, current object, and row count; targeted ESLint and bun run typecheck passed)
Task 3: complete (PostgreSQL schema/database table selection, per-statement and per-batch progress, selected-only data-only layout/emptiness checks; targeted ESLint and bun run typecheck passed)
Task 4: complete (MySQL table selection, selected-only metadata/layout/emptiness checks, per-object and per-batch progress; targeted ESLint and bun run typecheck passed)
Task 5: implementation/docs complete; final commit, package/install, PR update pending
Final review: self-review (no subagent tool per tool-use restriction); no remaining Critical or Important findings. Tests not added/run per workspace instruction.
Ruling: MySQL schema-bearing copies may skip routines, triggers, and events and proceed with supported table/view DDL and selected rows; report omission counts — the user's follow-up made clear that a total preflight stop prevents the requested copy — cost if wrong: the destination schema is intentionally partial, clearly disclosed before and after copying.
