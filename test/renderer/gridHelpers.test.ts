import { describe, expect, it } from "vitest";
import type { ExecutedStatement, SelectionAggregates } from "@table-craft/desktop/engine/protocol.js";
import { RAW_FORMATS } from "@table-craft/desktop/renderer/grid/format.js";
import {
  aggregateParts,
  aggregateRequest,
  aggregateText,
  toggledAggregate,
} from "@table-craft/desktop/renderer/model/aggregates.js";
import {
  focusedBinaryCell,
  imageDataUrl,
  imageOf,
  suggestedFileName,
} from "@table-craft/desktop/renderer/model/binaryCells.js";
import { EMPTY_BUFFER, addRow, setCell } from "@table-craft/desktop/renderer/model/editBuffer.js";
import { extendTo, selectCell } from "@table-craft/desktop/renderer/model/gridSelection.js";
import {
  canEditCell,
  canWriteCell,
  committedInput,
  editCellText,
  toggledBoolean,
  type EditTarget,
} from "@table-craft/desktop/renderer/model/resultEdits.js";
import {
  pickedText,
  pickerKindOf,
  pickerValueAt,
  pickerValueOf,
} from "@table-craft/desktop/renderer/model/temporalPicker.js";
import { resultTabOf, type ResultTab } from "@table-craft/desktop/renderer/state/resultTab.js";
import { AGGREGATE_NAMES } from "@table-craft/desktop/settings/settings.js";

const PNG_HEX = "89504e470d0a1a0a0000000d49484452";
const PAGING = { pageRows: 500, fetchAllCap: 100_000 };

/** A result of `id integer, flag boolean, payload bytes` over three rows. */
function probe(): ResultTab {
  const executed: Omit<ExecutedStatement, "transactionOpen"> = {
    handle: "h1",
    columns: [
      { name: "id", type: "int4" },
      { name: "flag", type: "bool" },
      { name: "payload", type: "bytea" },
    ],
    typeClasses: ["integer", "boolean", "bytes"],
    rowCount: 3,
    complete: true,
    cursorOpen: false,
    rowsAffected: null,
    firstWindow: {
      offset: 0,
      rows: [
        [1, true, { kind: "bytes", preview: PNG_HEX, length: PNG_HEX.length / 2 }],
        [2, false, { kind: "bytes", preview: "dead", length: 4096 }],
        [3, null, null],
      ],
    },
  };
  return resultTabOf(executed, { id: "r1", title: "Result" }, "SELECT", PAGING, RAW_FORMATS);
}

function target(result: ResultTab, buffer = EMPTY_BUFFER): EditTarget {
  return { result, buffer, editable: { identity: ["id"] }, columns: [] };
}

describe("selection aggregates", () => {
  it("givenOneCell_whenAggregateRequested_thenNone", () => {
    expect(aggregateRequest({ ...probe(), selection: selectCell({ row: 0, column: 0 }) })).toBeNull();
  });

  it("givenBlockOverAddedRow_whenAggregateRequested_thenOnlyHeldRows", () => {
    const selection = extendTo(selectCell({ row: 1, column: 0 }), { row: 5, column: 1 });

    expect(aggregateRequest({ ...probe(), selection })).toEqual({ rows: [{ from: 1, to: 3 }], columns: [0, 1] });
    expect(aggregateRequest({ ...probe(), selection, stale: true })).toBeNull();
  });

  it("givenNumericAggregates_whenChosenSubset_thenStatusTextInSettingsOrder", () => {
    const aggregates: SelectionAggregates = {
      cells: 3,
      distinct: 3,
      kind: "numeric",
      sum: "6.50",
      avg: "2.166667",
      min: 1,
      max: 3,
    };

    const parts = aggregateParts(aggregates, ["count", "sum", "max"], RAW_FORMATS);

    expect(aggregateText(parts)).toBe("Count: 3, Sum: 6.50, Max: 3");
  });

  it("givenTextAggregates_whenAllChosen_thenCountAndDistinctOnly", () => {
    const aggregates: SelectionAggregates = {
      cells: 4,
      distinct: 2,
      kind: "other",
      sum: null,
      avg: null,
      min: null,
      max: null,
    };

    expect(aggregateText(aggregateParts(aggregates, AGGREGATE_NAMES, RAW_FORMATS))).toBe("Count: 4, Distinct: 2");
  });

  it("givenChosenAggregates_whenToggled_thenKeptInCanonicalOrder", () => {
    expect(toggledAggregate(["max", "count"], "sum")).toEqual(["count", "sum", "max"]);
    expect(toggledAggregate(["count", "sum"], "sum")).toEqual(["count"]);
  });
});

describe("boolean cells", () => {
  it("givenBooleanCell_whenSpace_thenToggles", () => {
    const result = probe();
    const flag = { row: 0, column: 1 };
    const toggled = setCell(EMPTY_BUFFER, { kind: "held", row: 0 }, 1, {
      kind: "boolean",
      value: toggledBoolean(target(result), flag),
    });

    expect(toggledBoolean(target(result), flag)).toBe(false);
    expect(editCellText(target(result, toggled), flag)).toBe("false");
    expect(toggledBoolean(target(result, toggled), flag)).toBe(true);
    expect(toggledBoolean(target(result), { row: 2, column: 1 })).toBe(true);
  });

  it("givenBooleanColumn_whenEditorCommits_thenBooleanLiteralOrNull", () => {
    expect(committedInput("boolean", "TRUE")).toEqual({ kind: "boolean", value: true });
    expect(committedInput("boolean", "0")).toEqual({ kind: "boolean", value: false });
    expect(committedInput("boolean", "")).toEqual({ kind: "null" });
    expect(committedInput("boolean", "maybe")).toEqual({ kind: "text", text: "maybe" });
    expect(committedInput("text", "true")).toEqual({ kind: "text", text: "true" });
  });
});

describe("binary cells", () => {
  it("givenBytesCell_whenEditChecked_thenNoTypedEditButWritable", () => {
    const cell = { row: 1, column: 2 };

    expect(canEditCell(target(probe()), cell)).toBe(false);
    expect(canWriteCell(target(probe()), cell)).toBe(true);
  });

  it("givenPng_whenValuePanel_thenImagePreview", () => {
    const binaryAt = (row: number) => {
      const cell = focusedBinaryCell({ ...probe(), selection: selectCell({ row, column: 2 }) });
      if (cell === null) throw new Error("no binary cell");
      return cell.value;
    };

    expect(imageOf(PNG_HEX)?.mime).toBe("image/png");
    expect(imageDataUrl(binaryAt(0))).toBe(`data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==`);
    expect(imageDataUrl(binaryAt(1))).toBeNull();
    expect(suggestedFileName("payload", PNG_HEX)).toBe("payload.png");
    expect(suggestedFileName("my col", "dead")).toBe("my_col.bin");
  });

  it("givenAddedRow_whenFocused_thenNoBinaryCell", () => {
    const result = { ...probe(), selection: selectCell({ row: 3, column: 2 }) };

    expect(focusedBinaryCell(result, addRow(EMPTY_BUFFER, 3))).toBeNull();
  });
});

describe("temporal picker", () => {
  it("givenColumnTypes_whenPickerChosen_thenKindPerType", () => {
    expect(pickerKindOf("DATE")).toBe("date");
    expect(pickerKindOf("timestamp(3) with time zone")).toBe("datetime");
    expect(pickerKindOf("DATETIME")).toBe("datetime");
    expect(pickerKindOf("time")).toBe("time");
    expect(pickerKindOf("interval")).toBeNull();
    expect(pickerKindOf(null)).toBeNull();
  });

  it("givenTemporalCell_whenPickDate_thenWrittenInTheCellsShape", () => {
    expect(pickerValueOf("datetime", "2024-01-15 10:30:00")).toEqual({
      day: "2024-01-15",
      time: { hour: 10, minute: 30, second: 0 },
    });
    expect(pickerValueOf("date", "2024-01-15T00:00:00.000Z")).toEqual({ day: "2024-01-15", time: null });
    expect(pickerValueOf("datetime", "2024-01-15")).toEqual({
      day: "2024-01-15",
      time: { hour: 0, minute: 0, second: 0 },
    });

    expect(pickedText("date", { day: "2024-02-29", time: null }, "2024-01-15")).toBe("2024-02-29");
    expect(pickedText("datetime", { day: "2024-02-29", time: at(8, 5, 0) }, "2024-01-15 10:30:00")).toBe(
      "2024-02-29 08:05:00",
    );
    expect(pickedText("datetime", { day: "2024-02-29", time: null }, "")).toBe("2024-02-29 00:00:00");
    expect(pickedText("time", { day: null, time: at(8, 5, 0) }, "10:30:00+02")).toBe("08:05:00+02");
    expect(pickedText("date", { day: null, time: null }, "2024-01-15")).toBe("2024-01-15");
    expect(pickedText("date", { day: "2024-03-15", time: null }, "garbage")).toBe("2024-03-15");
  });

  it("givenMicroseconds_whenPickDay_thenFractionKept", () => {
    const current = "2026-02-25 16:54:26.742623";
    const picked = { ...pickerValueOf("datetime", current), day: "2026-02-10" };
    expect(pickedText("datetime", picked, current)).toBe("2026-02-10 16:54:26.742623");
  });

  it("givenFractionAndZone_whenPickTime_thenBothKept", () => {
    expect(pickedText("datetime", { day: "2024-01-15", time: at(8, 5, 7) }, "2024-01-15T10:30:00.000Z")).toBe(
      "2024-01-15T08:05:07.000Z",
    );
    expect(pickedText("time", { day: null, time: at(8, 5, 7) }, "10:30:00.25+02:00")).toBe("08:05:07.25+02:00");
  });

  it("givenNow_whenKeepFractionFalse_thenFractionDropped", () => {
    const now = pickerValueAt(new Date(2026, 9, 27, 9, 8, 7, 654));
    expect(now).toEqual({ day: "2026-10-27", time: at(9, 8, 7) });
    expect(pickedText("datetime", now, "2026-02-25T16:54:26.742623Z", { keepFraction: false })).toBe(
      "2026-10-27T09:08:07Z",
    );
  });

  it("givenUnparsableText_whenPickerValueOf_thenNoDayNoTime", () => {
    expect(pickerValueOf("time", "garbage")).toEqual({ day: null, time: null });
    expect(pickerValueOf("datetime", "")).toEqual({ day: null, time: null });
    expect(pickerValueOf("date", "soon")).toEqual({ day: null, time: null });
  });
});

function at(hour: number, minute: number, second: number): { hour: number; minute: number; second: number } {
  return { hour, minute, second };
}
