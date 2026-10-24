import { describe, expect, it } from "vitest";
import type { ImportRow, ImportSummary } from "@table-craft/desktop/preload/bridge.js";
import {
  allSelected,
  asksKeychain,
  initialSelection,
  selectedKeys,
  sourceDetail,
  summaryNotes,
  summaryText,
  toggled,
} from "@table-craft/desktop/renderer/model/importDataSources.js";

function row(key: string, overrides: Partial<ImportRow> = {}): ImportRow {
  return {
    key,
    app: "datagrip",
    name: key,
    pluginId: "mysql",
    pluginName: "MySQL",
    target: "localhost:3306",
    user: "root",
    folder: null,
    password: "keychain",
    warnings: [],
    status: "ready",
    selected: true,
    ...overrides,
  };
}

const ROWS = [
  row("a"),
  row("b", { status: "duplicate", selected: false, password: "found" }),
  row("c", { status: "unsupported", selected: false, pluginId: null }),
];

describe("import dialog model", () => {
  it("givenPreview_whenOpened_thenOnlyReadyRowsTicked", () => {
    expect([...initialSelection(ROWS)]).toEqual(["a"]);
  });

  it("givenSelectAll_whenChosen_thenUnsupportedStaysUnticked", () => {
    expect([...allSelected(ROWS)]).toEqual(["a", "b"]);
    expect(selectedKeys(ROWS, new Set(["c", "b", "a"]))).toEqual(["a", "b"]);
  });

  it("givenDuplicateTicked_whenToggled_thenSelectionFollows", () => {
    const on = toggled(initialSelection(ROWS), "b", true);

    expect([...on]).toEqual(["a", "b"]);
    expect([...toggled(on, "a", false)]).toEqual(["b"]);
  });

  it("givenKeychainRowTicked_whenPasswordsOn_thenWarnsOfPrompt", () => {
    expect(asksKeychain(ROWS, new Set(["a"]), true)).toBe(true);
    expect(asksKeychain(ROWS, new Set(["a"]), false)).toBe(false);
    expect(asksKeychain(ROWS, new Set(["b"]), true)).toBe(false);
  });

  it("givenSources_whenDescribed_thenCountsOrNotFound", () => {
    const source = { app: "tablepro", label: "TablePro", locations: [], passwords: "" } as const;

    expect(sourceDetail({ ...source, found: false, count: 0 })).toBe("Not found");
    expect(sourceDetail({ ...source, found: true, count: 1 })).toBe("1 connection");
    expect(sourceDetail({ ...source, found: true, count: 14 })).toBe("14 connections");
  });

  it("givenDeniedKeychain_whenSummarised_thenSaysTheRestAskOnConnect", () => {
    const summary: ImportSummary = {
      imported: 14,
      withPasswords: 3,
      skipped: 1,
      ids: [],
      cancelled: false,
      keychainDenied: true,
    };

    expect(summaryText(summary)).toBe("Imported 14, with passwords 3, skipped 1.");
    expect(summaryNotes(summary)).toEqual([expect.stringContaining("asks on connect")]);
  });
});
