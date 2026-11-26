# Copy Progress and Table Selection Design

## Intent

Make PostgreSQL and MySQL copy operations observable while they run and let users limit which table rows are copied. The current coordinators already report some row progress, but the actions do not display it and always transfer every table.

## Approaches

1. **Live progress dialog (chosen):** Add a table checklist to the existing copy flow and show the operation's current progress in a modal dialog. This fits the current action flow and uses the coordinators' progress callbacks.
2. **Non-blocking task panel:** Keep progress visible while the user works elsewhere. This needs a task lifecycle and cancellation behavior beyond the copy flow requested here.

## Behavior

- Apply table selection to PostgreSQL schema copies, PostgreSQL database copies, and MySQL database copies.
- Show a searchable checklist of source tables before starting any mode that copies rows. All tables start selected. Schema-only skips this step.
- In data-only mode, transfer rows only from checked tables. In schema-and-data mode, create all supported schema objects and transfer rows only from checked tables.
- MySQL schema-bearing modes copy supported tables and views even when routines, triggers, or events exist; disclose the omission up front and report counts after success. Data-only mode does not inspect or copy them.
- A selection may be empty; the operation then performs schema-only work for schema-and-data mode, or no row writes for data-only mode.
- Check destination compatibility and emptiness only for selected tables in data-only mode. Never touch skipped destination tables.
- During execution, show preparation, schema, and data phases; the current object/table; completed versus total work; and rows transferred for the active table. Split PostgreSQL schema DDL into statements and report each statement while retaining its existing transaction. Report MySQL schema objects individually between DDL statements.
- Close the progress dialog when the operation settles, then show the existing success or error notice with completed work details.
- Do not offer cancellation in this change. PostgreSQL transactions can roll back, but MySQL DDL commits implicitly, so a generic cancel action could leave a partially copied schema.

## Constraints and non-goals

- Progress stays local in the app and does not transmit database content.
- Keep the existing source/destination rules, collision protections, and unsupported-object checks for generated columns, non-InnoDB tables, and unsupported foreign keys.
- Do not add a background task manager or resumable copy system.
- Follow the workspace instruction not to add or run tests unless asked; use typecheck, lint, and build verification.

## Implementation notes

- Add a multi-select table picker to the existing modal flow, retaining full table names and schema names where needed to disambiguate PostgreSQL database copies.
- Extend PostgreSQL and MySQL copy requests with an optional selected-table set; omission means all tables for existing callers.
- Make progress updates replace the active progress request without resolving its promise. Completion and failure return control to the existing notice flow.
- Keep progress counters scoped to the active schema during PostgreSQL database copies, while displaying the schema name as part of the current item.
