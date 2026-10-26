import type { BytesValue, Row, SqlLanguage, WireValue } from "@table-craft/plugin-api";
import { CoreError } from "@table-craft/core/errors.js";

/**
 * What the user put into a cell: text the database casts, `NULL`, the column's default, a boolean
 * from the boolean editor, or a file's bytes the engine staged under `id` (plan 043), of which the
 * renderer holds only `length` and the first bytes as `preview` hex.
 */
export type CellInput =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "null" }
  | { readonly kind: "default" }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "bytes"; readonly id: string; readonly length: number; readonly preview: string };

/** One pending change; `row` is the row's index in the result store (decision 026). */
export type RowEdit =
  | {
      readonly kind: "update";
      readonly row: number;
      readonly values: readonly { readonly column: number; readonly value: CellInput }[];
    }
  | { readonly kind: "insert"; readonly values: readonly CellInput[] }
  | { readonly kind: "delete"; readonly row: number };

export interface EditColumn {
  readonly name: string;
  /** The column's declared type, handed to `literal`. */
  readonly type: string | null;
  /** The catalog's default expression, for dialects without `SET column = DEFAULT`. */
  readonly default: string | null;
  /** A console result's computed or repeated column, which no edit may write (decision 056). */
  readonly readOnly?: boolean;
}

/** The table a set of edits applies to. */
export interface EditTable {
  /** Qualified and quoted by the plugin, such as `"public"."orders"`. */
  readonly table: string;
  /** In result order, which for `SELECT *` is table order. */
  readonly columns: readonly EditColumn[];
  /** Indexes into `columns` of the key that names one row. */
  readonly identity: readonly number[];
}

export interface GenerateEditsOptions extends EditTable {
  /** The stored row at a result index; undefined when the result never held it. */
  readonly rows: (row: number) => Row | undefined;
  readonly edits: readonly RowEdit[];
  readonly language: SqlLanguage;
  /** The bytes staged under an id; undefined when nothing is staged under it. */
  readonly staged?: (id: string) => BytesValue | undefined;
}

const STALE_HINT = "Reload the table and make the change again.";
const KIND_ORDER: Readonly<Record<RowEdit["kind"], number>> = { delete: 0, update: 1, insert: 2 };

function refuse(message: string, hint = STALE_HINT): never {
  throw new CoreError("invalidRequest", message, hint);
}

function isBytes(value: WireValue): boolean {
  return typeof value === "object" && value !== null && value.kind === "bytes";
}

/**
 * The statements that apply `edits`, deletes first, then updates, then inserts (decision 026).
 * Every value is a literal written by the plugin, so the preview is exactly what runs. Refuses with
 * `invalidRequest` an edit it cannot key: a row the result never held, or a key value that is
 * `NULL` or bytes, whose wire value is only a preview (decision 017).
 */
export function generateEdits(options: GenerateEditsOptions): string[] {
  const { table, columns, identity, language } = options;
  if (identity.length === 0) refuse("This table has no key to identify rows by.", "Open a table with a primary key.");

  function columnAt(index: number): EditColumn {
    return columns[index] ?? refuse(`Column ${String(index)} is not in the table.`);
  }

  function quoted(index: number): string {
    return language.quoteIdentifier(columnAt(index).name);
  }

  function keyOf(rowIndex: number): string {
    const row = options.rows(rowIndex) ?? refuse(`Row ${String(rowIndex + 1)} is no longer held.`);
    return identity
      .map((index) => {
        const column = columnAt(index);
        const value = row[index] ?? null;
        if (value === null) refuse(`Row ${String(rowIndex + 1)} has no value in key column ${column.name}.`);
        if (isBytes(value))
          refuse(`Row ${String(rowIndex + 1)} is keyed by bytes column ${column.name}, which cannot be matched.`);
        return `${quoted(index)} = ${language.literal(value, column.type)}`;
      })
      .join(" AND ");
  }

  function writable(index: number): void {
    const column = columnAt(index);
    if (column.readOnly === true) {
      refuse(`Column ${column.name} is read-only in this result.`, "Edit only the columns read from the table.");
    }
  }

  function input(value: CellInput, column: EditColumn): string {
    switch (value.kind) {
      case "text":
        return language.literal(value.text, column.type);
      case "null":
        return "NULL";
      case "default":
        return language.updateDefault(column.default);
      case "boolean":
        return language.literal(value.value, column.type);
      case "bytes":
        return language.literal(
          options.staged?.(value.id) ?? refuse("The loaded file is no longer staged.", "Load the file again."),
          column.type,
        );
    }
  }

  const seen = new Map<number, RowEdit["kind"]>();
  for (const edit of options.edits) {
    if (edit.kind === "insert") continue;
    const before = seen.get(edit.row);
    if (before !== undefined) refuse(`Row ${String(edit.row + 1)} has both a ${before} and a ${edit.kind}.`);
    seen.set(edit.row, edit.kind);
  }

  const ordered = [...options.edits].sort((left, right) => KIND_ORDER[left.kind] - KIND_ORDER[right.kind]);
  return ordered.map((edit) => {
    switch (edit.kind) {
      case "delete":
        return `DELETE FROM ${table} WHERE ${keyOf(edit.row)}`;
      case "update": {
        if (edit.values.length === 0) refuse(`Row ${String(edit.row + 1)} has an update with no values.`);
        const assignments = edit.values.map(({ column, value }) => {
          writable(column);
          return `${quoted(column)} = ${input(value, columnAt(column))}`;
        });
        return `UPDATE ${table} SET ${assignments.join(", ")} WHERE ${keyOf(edit.row)}`;
      }
      case "insert": {
        if (edit.values.length !== columns.length) {
          refuse(`An inserted row has ${String(edit.values.length)} values for ${String(columns.length)} columns.`);
        }
        const given = edit.values.flatMap((value, index) => (value.kind === "default" ? [] : [index]));
        given.forEach(writable);
        if (given.length === 0) return language.emptyInsert(table);
        const names = given.map(quoted).join(", ");
        const values = given.map((index) => input(edit.values[index] ?? { kind: "null" }, columnAt(index))).join(", ");
        return `INSERT INTO ${table} (${names}) VALUES (${values})`;
      }
    }
  });
}
