import type { Column, Row, WireValue } from "@table-craft/plugin-api";
import { CoreError } from "@table-craft/core/errors.js";
import { cellText } from "@table-craft/core/results/extract/text.js";
import { csvWriter } from "@table-craft/core/results/extract/csv.js";
import { jsonWriter } from "@table-craft/core/results/extract/json.js";
import { markdownWriter } from "@table-craft/core/results/extract/markdown.js";
import { SQL_INSERT_TABLE, sqlInsertWriter, type SqlDialect } from "@table-craft/core/results/extract/sqlInsert.js";
import { tsvWriter } from "@table-craft/core/results/extract/tsv.js";
import type { RowWriter } from "@table-craft/core/results/extract/writer.js";

export const EXTRACTOR_KINDS = ["csv", "tsv", "json", "sqlInsert", "markdown"] as const;

/** The formats Copy and Export write; one is chosen at a time and drives both. */
export type ExtractorKind = (typeof EXTRACTOR_KINDS)[number];

export interface ExtractOptions {
  /** Needed by `sqlInsert`, which quotes and spells values the plugin's way. */
  readonly dialect?: SqlDialect;
  /** The table `sqlInsert` names; `MY_TABLE` by default. */
  readonly table?: string;
}

/** The writer for `kind` over `columns`; rows handed to it hold those columns only, in that order. */
export function rowWriter(kind: ExtractorKind, columns: readonly Column[], options: ExtractOptions = {}): RowWriter {
  switch (kind) {
    case "csv":
      return csvWriter(columns);
    case "tsv":
      return tsvWriter(columns);
    case "json":
      return jsonWriter(columns);
    case "markdown":
      return markdownWriter(columns);
    case "sqlInsert":
      if (options.dialect === undefined) {
        throw new CoreError(
          "invalidRequest",
          "SQL INSERT needs the datasource's SQL language to quote names and values.",
          "Choose another extractor; this datasource's plugin does not declare sql.",
        );
      }
      return sqlInsertWriter(columns, options.dialect, options.table ?? SQL_INSERT_TABLE);
  }
}

/** Keeps the cells at `indices`, in that order. */
export function project(row: Row, indices: readonly number[]): Row {
  return indices.map((index) => row[index] ?? null);
}

/** `rows` written whole as `kind`. */
export function extract(
  kind: ExtractorKind,
  columns: readonly Column[],
  rows: Iterable<Row>,
  options: ExtractOptions = {},
): string {
  const writer = rowWriter(kind, columns, options);
  let text = writer.start();
  let count = 0;
  for (const row of rows) text += writer.row(row, count++);
  return text + writer.end(count);
}

/** One cell as Copy puts it on the clipboard: the bare value, no header or quoting; NULL is empty. */
export function cellClipboardText(value: WireValue): string {
  return value === null ? "" : cellText(value);
}

export { SQL_INSERT_TABLE, type SqlDialect } from "@table-craft/core/results/extract/sqlInsert.js";
export type { RowWriter } from "@table-craft/core/results/extract/writer.js";
