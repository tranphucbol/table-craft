import { describe, expect, it } from "vitest";
import {
  countIn,
  dataSourceCount,
  everything,
  isEmptySelection,
  passphraseProblem,
  selectionOf,
} from "@table-craft/desktop/renderer/model/exportDataSources.js";
import { view } from "./datasourceViews.js";

const DATASOURCES = [
  view({ id: "shop", name: "Shop", folder: "Work/Shop" }),
  view({ id: "notes", name: "Notes", folder: null }),
  view({ id: "env", name: "env", folder: null, ephemeral: true }),
];

describe("export data sources", () => {
  it("givenTreeItems_whenSelected_thenSavedDataSourcesAndFoldersOnly", () => {
    const selection = selectionOf(
      [
        { kind: "datasource", id: "notes" },
        { kind: "datasource", id: "env" },
        { kind: "folder", path: "Work" },
      ],
      DATASOURCES,
    );

    expect(selection).toEqual({ ids: ["notes"], folders: ["Work"] });
    expect(countIn(selection, DATASOURCES)).toBe(2);
    expect(dataSourceCount(countIn(selection, DATASOURCES))).toBe("2 data sources");
  });

  it("givenEphemeralDatasource_whenExportAll_thenLeftOut", () => {
    const all = everything(DATASOURCES, ["Work", "Work/Shop"]);

    expect(all.ids).toEqual(["shop", "notes"]);
    expect(countIn(all, DATASOURCES)).toBe(2);
    expect(isEmptySelection({ ids: [], folders: [] })).toBe(true);
    expect(dataSourceCount(1)).toBe("1 data source");
  });

  it("givenShortOrMismatchedPassphrase_whenChecked_thenSaysWhy", () => {
    expect(passphraseProblem("short", "short")).toBe("Use a passphrase of at least 8 characters.");
    expect(passphraseProblem("long enough", "long enougH")).toBe("The passphrases do not match.");
    expect(passphraseProblem("long enough", "long enough")).toBeNull();
  });
});
