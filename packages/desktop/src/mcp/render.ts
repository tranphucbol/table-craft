import type { Column, Row, WireValue } from "@table-craft/desktop/engine/protocol.js";

/** Longer cells are cut so one wide row cannot fill the agent's context. */
export const MCP_CELL_CHARS = 1_000;
/** A column in the text table is never drawn wider than this; the JSON keeps the whole cell. */
const TEXT_COLUMN_CHARS = 60;
const ELLIPSIS = "…";
const NULL_TEXT = "NULL";

export type JsonCell = string | number | boolean | null;

function cut(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - ELLIPSIS.length)}${ELLIPSIS}` : text;
}

/** A cell as JSON: numbers and booleans stay, everything the wire wraps becomes text. */
export function jsonCell(value: WireValue): JsonCell {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return cut(value, MCP_CELL_CHARS);
  switch (value.kind) {
    case "bigint":
      return value.value;
    case "bytes":
      return `<${String(value.length)} bytes> ${cut(value.preview, MCP_CELL_CHARS)}`;
    case "json":
      return cut(value.text, MCP_CELL_CHARS);
    case "date":
      return value.iso;
  }
}

function textCell(value: WireValue): string {
  const cell = jsonCell(value);
  const text = cell === null ? NULL_TEXT : String(cell);
  return cut(text.replace(/\s+/g, " "), TEXT_COLUMN_CHARS);
}

export function jsonRows(columns: readonly Column[], rows: readonly Row[]): Readonly<Record<string, JsonCell>>[] {
  return rows.map((row) =>
    Object.fromEntries(columns.map((column, index) => [column.name, jsonCell(row[index] ?? null)])),
  );
}

/** A fixed-width table, header first, as `mysql` prints one. */
export function textTable(columns: readonly Column[], rows: readonly Row[]): string {
  const cells = [
    columns.map((column) => cut(column.name, TEXT_COLUMN_CHARS)),
    ...rows.map((row) => columns.map((_, index) => textCell(row[index] ?? null))),
  ];
  const widths = columns.map((_, index) => Math.max(...cells.map((line) => line[index]?.length ?? 0)));
  const rule = `+${widths.map((width) => "-".repeat(width + 2)).join("+")}+`;
  const line = (values: readonly string[]): string =>
    `| ${values.map((value, index) => value.padEnd(widths[index] ?? 0)).join(" | ")} |`;
  const [header = [], ...body] = cells;
  return [rule, line(header), rule, ...body.map(line), rule].join("\n");
}
