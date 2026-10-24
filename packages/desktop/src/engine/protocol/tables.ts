import type { ColumnMeta, ForeignKey } from "./catalog.js";
import type { SortDirection } from "./results.js";
import type { ExecutedStatement } from "./sessions.js";

/** Mirrors `CellInput` in core: text the database casts, `NULL`, or the column's default. */
export type CellInput =
  { readonly kind: "text"; readonly text: string } | { readonly kind: "null" } | { readonly kind: "default" };

/** Mirrors `RowEdit` in core; `row` indexes the table result's held rows. */
export type RowEdit =
  | {
      readonly kind: "update";
      readonly row: number;
      readonly values: readonly { readonly column: number; readonly value: CellInput }[];
    }
  | { readonly kind: "insert"; readonly values: readonly CellInput[] }
  | { readonly kind: "delete"; readonly row: number };

/** Mirrors `EditableIdentity` in core: the key columns that name a row, or why the table is read-only. */
export type EditableIdentity = { readonly identity: readonly string[] } | { readonly readOnly: string };

/** What `table.query` answers: the rows, the SQL that read them, and how they may be edited (decision 026). */
export interface TableQuery {
  readonly statement: ExecutedStatement;
  readonly sql: string;
  readonly editable: EditableIdentity;
  /** The catalog's view of each result column, in result order. */
  readonly columns: readonly ColumnMeta[];
  /** The table's own foreign keys, for go-to-referenced. */
  readonly foreignKeys: readonly ForeignKey[];
  /** Foreign keys of described tables that point at this one, for show-referencing. */
  readonly referencing: readonly ReferencingKey[];
}

/** Whether a console result may be edited in its grid, and how (decision 056). */
export interface ResultEditable {
  readonly editable: EditableIdentity;
  /** The catalog's view of each result column, or what the driver reported for an expression. */
  readonly columns: readonly ColumnMeta[];
  /** Per result column: a computed, aliased-expression or repeated column no edit may write. */
  readonly readOnlyColumns: readonly boolean[];
}

/** A foreign key of the relation at `path`.`relation` that points at another table. */
export interface ReferencingKey {
  readonly path: readonly string[];
  readonly relation: string;
  readonly foreignKey: ForeignKey;
}

/** Mirrors `SubmittedEdits` in core. */
export interface SubmittedEdits {
  readonly statements: readonly string[];
  readonly rowsAffected: number;
}

/** A column a value condition matches on: the result column whose values it reads, written as `name`. */
export interface ConditionColumn {
  readonly column: number;
  readonly name: string;
}

/** Mirrors `OrderTerm` in core: one ORDER BY term by column name. */
export interface OrderTerm {
  readonly name: string;
  readonly direction: SortDirection;
}
