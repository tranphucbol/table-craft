import { describe, expect, it } from "vitest";
import { closedConsoleOf, duplicateSeed } from "@table-craft/desktop/renderer/model/consoleTabs.js";
import { SCRATCH, type ConsoleSource } from "@table-craft/desktop/renderer/state/consoles.js";

const FILE_SOURCE: ConsoleSource = {
  kind: "file",
  path: "/work/migrations/001.sql",
  savedSql: "select 1",
  lineEnding: "lf",
  modifiedAt: 0,
};

describe("console tabs", () => {
  it("givenConsoleInASchema_whenDuplicated_thenSeedKeepsTextAndNamespace", () => {
    expect(duplicateSeed({ sql: "select 1", namespace: ["shop", "public"], pendingNamespace: null })).toEqual({
      sql: "select 1",
      namespace: ["shop", "public"],
    });
  });

  it("givenConsoleNotYetConnected_whenDuplicated_thenSeedTakesTheNamespaceItIsAboutToSwitchTo", () => {
    expect(duplicateSeed({ sql: "", namespace: null, pendingNamespace: ["sales"] }).namespace).toEqual(["sales"]);
  });

  it("givenPinnedFileConsole_whenClosed_thenEntryKeepsPathAndPin", () => {
    const session = { datasourceId: "pg", name: "001.sql", sql: "select 2", source: FILE_SOURCE };

    expect(closedConsoleOf({ pinned: true }, session)).toEqual({
      datasourceId: "pg",
      name: "001.sql",
      sql: "select 2",
      path: FILE_SOURCE.path,
      pinned: true,
    });
  });

  it("givenScratchConsole_whenClosed_thenEntryHasNoPath", () => {
    const session = { datasourceId: "pg", name: "console_1", sql: "select 3", source: SCRATCH };

    expect(closedConsoleOf({}, session)).toEqual({ datasourceId: "pg", name: "console_1", sql: "select 3" });
  });
});
