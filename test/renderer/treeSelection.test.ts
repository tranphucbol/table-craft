import { describe, expect, it } from "vitest";
import type { DatasourceView } from "@table-craft/desktop/preload/bridge.js";
import { buildTree } from "@table-craft/desktop/renderer/model/datasourceTree.js";
import { explorerRows, type ExplorerRow } from "@table-craft/desktop/renderer/model/explorerTree.js";
import {
  NO_SELECTION,
  nextSelection,
  remapSelection,
  selectedItems,
  type TreeSelectionState,
} from "@table-craft/desktop/renderer/model/treeSelection.js";
import { view } from "./datasourceViews.js";

const DATASOURCES: readonly DatasourceView[] = [
  view({ id: "eu", name: "eu", folder: "Prod" }),
  view({ id: "a", name: "a" }),
  view({ id: "b", name: "b" }),
  view({ id: "c", name: "c" }),
];

function rowsOf(datasources: readonly DatasourceView[], folders: readonly string[]): readonly ExplorerRow[] {
  return explorerRows({
    tree: buildTree(datasources, folders),
    catalogs: {},
    expanded: new Set(),
    collapsedFolders: new Set(),
    showSystem: false,
    canExpand: () => false,
  });
}

const ROWS = rowsOf(DATASOURCES, ["Prod"]);
const indexOf = (key: string) => ROWS.findIndex((row) => row.key === key);

function gesture(state: TreeSelectionState, key: string, kind: Parameters<typeof nextSelection>[3]) {
  return nextSelection(state, ROWS, indexOf(key), kind);
}

describe("tree selection (plan 136)", () => {
  it("givenRows_whenClicked_thenOnlyThatRowIsSelected", () => {
    const state = gesture(gesture(NO_SELECTION, "datasource:a", "click"), "datasource:b", "click");

    expect(selectedItems(state)).toEqual([{ kind: "datasource", id: "b" }]);
    expect(state.multi).toEqual([]);
  });

  it("givenSelection_whenModClicked_thenRowIsAddedAndAgainRemoved", () => {
    const one = gesture(NO_SELECTION, "datasource:a", "click");
    const two = gesture(one, "datasource:c", "toggle");

    expect(selectedItems(two)).toEqual([
      { kind: "datasource", id: "a" },
      { kind: "datasource", id: "c" },
    ]);
    expect(two.lead).toEqual({ kind: "datasource", id: "c" });
    expect(selectedItems(gesture(two, "datasource:c", "toggle"))).toEqual([{ kind: "datasource", id: "a" }]);
  });

  it("givenAnchor_whenShiftClicked_thenRangeIncludesFoldersAndDatasources", () => {
    const state = gesture(gesture(NO_SELECTION, "folder:Prod", "click"), "datasource:b", "range");

    expect(selectedItems(state)).toEqual([
      { kind: "folder", path: "Prod" },
      { kind: "datasource", id: "eu" },
      { kind: "datasource", id: "a" },
      { kind: "datasource", id: "b" },
    ]);
    expect(state.anchor).toEqual({ kind: "folder", path: "Prod" });
  });

  it("givenMultiple_whenMemberPressed_thenSetIsKeptForADrag", () => {
    const range = gesture(gesture(NO_SELECTION, "datasource:a", "click"), "datasource:c", "range");
    const pressed = gesture(range, "datasource:b", "pressKeep");

    expect(selectedItems(pressed)).toHaveLength(3);
    expect(pressed.lead).toEqual({ kind: "datasource", id: "b" });
    expect(selectedItems(gesture(range, "folder:Prod", "pressKeep"))).toEqual([{ kind: "folder", path: "Prod" }]);
  });

  it("givenFolderRenamed_whenRemapped_thenSelectionFollowsAndGoneItemsLeave", () => {
    const state: TreeSelectionState = {
      lead: { kind: "folder", path: "Prod/EU" },
      multi: [
        { kind: "datasource", id: "gone" },
        { kind: "folder", path: "Prod/EU" },
      ],
      anchor: { kind: "folder", path: "Prod/EU" },
    };

    const remapped = remapSelection(state, new Map([["Prod/EU", "EU"]]), (item) => item.kind === "folder");

    expect(remapped).toEqual({
      lead: { kind: "folder", path: "EU" },
      multi: [],
      anchor: { kind: "folder", path: "EU" },
    });
  });
});
