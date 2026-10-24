# 014: What v1 ships

Status: Accepted

## Decision

**v1**

- Built-in plugins: PostgreSQL (`pg`), MySQL / MariaDB (`mysql2`), SQLite (`node:sqlite`)
- App shell: tool-window strips, resizable panes, editor tabs, status bar, Find Action and Search
  Everywhere, every command an action in one registry (decision 015); a frameless window whose
  title bar is the main toolbar, with native window controls (decision 034)
- Connections: plugin-generated form, test connection, folders, `safeStorage` secrets, read-only
  and colour flags
- Database explorer: lazy tree, speed search, manual refresh
- SQL console: run statement or selection, cancel, autocomplete, auto/manual commit, multiple
  result sets, Output tab
- Result grid: engine-side result sets, virtualized, paging and fetch-more, sort, value viewer,
  copy and export through extractors (CSV, TSV, JSON, SQL INSERT, Markdown)
- Table data editor: WHERE / ORDER BY bars, edit, insert, duplicate, delete, preview generated
  SQL, submit, revert, foreign-key navigation
- Completion and navigation: schema- and alias-aware completion, go to declaration
- DDL view and SQL generator (CREATE, DROP, INSERT, UPDATE, SELECT)
- Query history per datasource, and a Services window listing sessions and executions with timings
- EXPLAIN plan view
- Settings and appearance: themes, user themes, three font settings, density, data-editor formats
- Packaging: macOS (arm64, x64) first-class; Windows (NSIS) and Linux (AppImage) built in
  [CI](../../.github/workflows/ci.yml), best-effort

**v1.1**: SSH tunnels, saved query files.

**Later**: ER diagrams, schema compare and migrations, data import, a plugin marketplace,
Redis / MongoDB plugins, a CLI, AI assistance, Git integration, a debugger, notebooks,
Docker / Kubernetes integration.

## Rationale

v1 is the loop a DataGrip user runs all day: connect, look, query, read, fix a row. The list was
widened after an inventory of DataGrip (`docs/design/datagrip-inventory.md`, section 11): its
twenty daily workflows depend on the shell, Find Action, extractors and the SQL generator, so
leaving them out would make table-craft feel like a demo. Everything in it exercises the plugin
contract, which is the part that must be right before third parties build on it.

## Consequences

- Features outside this list need this record updated, not just a plan.
- The plans 002 to 014 follow this list in order; see `docs/plans/`.
- Amended by decision 039: the daily-friction release (plans 017 to 026) adds to this list.
- Amended by decision 069: the must-have release (plans 036 to 048) adds to this list.
