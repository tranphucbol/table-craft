import { describe, expect, it } from "vitest";
import type { Column } from "@table-craft/desktop/engine/protocol.js";
import { jsonCell, jsonRows, MCP_CELL_CHARS, textTable } from "@table-craft/desktop/mcp/render.js";

const COLUMNS: Column[] = [
  { name: "id", type: "INTEGER" },
  { name: "note", type: "TEXT" },
];

describe("MCP render", () => {
  it("givenWireValues_whenJsonCells_thenWrappedValuesBecomeText", () => {
    expect(jsonCell(null)).toBeNull();
    expect(jsonCell(true)).toBe(true);
    expect(jsonCell({ kind: "bigint", value: "9007199254740993" })).toBe("9007199254740993");
    expect(jsonCell({ kind: "bytes", preview: "DEADBEEF", length: 4 })).toBe("<4 bytes> DEADBEEF");
    expect(jsonCell({ kind: "date", iso: "2024-02-29" })).toBe("2024-02-29");
  });

  it("givenLongCell_whenJsonCell_thenCutWithEllipsis", () => {
    const cell = jsonCell("x".repeat(MCP_CELL_CHARS + 50)) as string;

    expect(cell).toHaveLength(MCP_CELL_CHARS);
    expect(cell.endsWith("…")).toBe(true);
  });

  it("givenRows_whenRendered_thenJsonByColumnAndAlignedText", () => {
    const rows = [
      [1, "line one\nline two"],
      [22, null],
    ];

    expect(jsonRows(COLUMNS, rows)).toEqual([
      { id: 1, note: "line one\nline two" },
      { id: 22, note: null },
    ]);
    expect(textTable(COLUMNS, rows)).toBe(
      [
        "+----+-------------------+",
        "| id | note              |",
        "+----+-------------------+",
        "| 1  | line one line two |",
        "| 22 | NULL              |",
        "+----+-------------------+",
      ].join("\n"),
    );
  });
});
