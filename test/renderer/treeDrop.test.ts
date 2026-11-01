import { describe, expect, it } from "vitest";
import type { TreeItemRef } from "@table-craft/desktop/datasourceTree/arrange.js";
import type { DatasourceView } from "@table-craft/desktop/preload/bridge.js";
import { buildTree } from "@table-craft/desktop/renderer/model/datasourceTree.js";
import { explorerRows, type ExplorerRow } from "@table-craft/desktop/renderer/model/explorerTree.js";
import { arrangeTreeOf, dropTarget, stepRequest } from "@table-craft/desktop/renderer/model/treeDrop.js";
import { view } from "./datasourceViews.js";

const FOLDERS = ["Prod", "Prod/EU", "Dev"];
const DATASOURCES: readonly DatasourceView[] = [
  view({ id: "env", name: "env", ephemeral: true }),
  view({ id: "eu1", name: "eu1", folder: "Prod/EU" }),
  view({ id: "p1", name: "p1", folder: "Prod" }),
  view({ id: "a", name: "a" }),
  view({ id: "b", name: "b" }),
  view({ id: "c", name: "c" }),
];
const TREE = arrangeTreeOf(DATASOURCES, FOLDERS);

function rowsOf(collapsed: readonly string[] = []): readonly ExplorerRow[] {
  return explorerRows({
    tree: buildTree(DATASOURCES, FOLDERS),
    catalogs: {},
    expanded: new Set(),
    collapsedFolders: new Set(collapsed),
    showSystem: false,
    canExpand: () => false,
  });
}

const ROWS = rowsOf();
const at = (key: string) => ROWS.findIndex((row) => row.key === key);
const datasource = (id: string): TreeItemRef => ({ kind: "datasource", id });
const folder = (path: string): TreeItemRef => ({ kind: "folder", path });

describe("drop targets (plan 136)", () => {
  it("givenDatasourceRow_whenTopHalf_thenDropsBeforeItAndBottomHalfAfter", () => {
    expect(dropTarget(ROWS, at("datasource:b"), 0.2, [datasource("c")], TREE)?.request).toEqual({
      items: [datasource("c")],
      folder: null,
      before: datasource("b"),
    });
    expect(dropTarget(ROWS, at("datasource:a"), 0.8, [datasource("c")], TREE)?.request.before).toEqual(datasource("b"));
  });

  it("givenFolderRow_whenMiddle_thenDropsIntoItAtTheEnd", () => {
    const target = dropTarget(ROWS, at("folder:Dev"), 0.5, [datasource("a")], TREE);

    expect(target?.request).toEqual({ items: [datasource("a")], folder: "Dev", before: null });
    expect(target?.indicator).toEqual({ kind: "into", index: at("folder:Dev") });
  });

  it("givenExpandedFolder_whenBottomQuarter_thenDropsFirstInside", () => {
    const target = dropTarget(ROWS, at("folder:Prod"), 0.9, [folder("Dev")], TREE);

    expect(target?.request).toEqual({ items: [folder("Dev")], folder: "Prod", before: folder("Prod/EU") });
    expect(target?.indicator).toEqual({ kind: "line", index: at("folder:Prod") + 1, depth: 1 });
  });

  it("givenDatasourceAimedBetweenFolders_whenHovered_thenTheLineSitsAboveTheLevelsFirstDatasource", () => {
    expect(dropTarget(ROWS, at("folder:Dev"), 0.1, [datasource("c")], TREE)?.indicator).toEqual({
      kind: "line",
      index: at("datasource:a"),
      depth: 0,
    });
    expect(dropTarget(ROWS, at("folder:Prod"), 0.9, [datasource("a")], TREE)?.indicator).toEqual({
      kind: "line",
      index: at("datasource:p1"),
      depth: 1,
    });
  });

  it("givenFolderAimedAmongDatasources_whenHovered_thenTheLineSitsBelowTheLevelsLastFolder", () => {
    const target = dropTarget(ROWS, at("datasource:b"), 0.2, [folder("Prod")], TREE);

    expect(target?.request).toEqual({ items: [folder("Prod")], folder: null, before: datasource("b") });
    expect(target?.indicator).toEqual({ kind: "line", index: at("datasource:a"), depth: 0 });
  });

  it("givenFolderOntoItsOwnChild_whenDropped_thenNoTarget", () => {
    expect(dropTarget(ROWS, at("folder:Prod/EU"), 0.5, [folder("Prod")], TREE)).toBeNull();
  });

  it("givenDropThatChangesNothing_whenChecked_thenNoTarget", () => {
    expect(dropTarget(ROWS, at("datasource:b"), 0.2, [datasource("a")], TREE)).toBeNull();
  });

  it("givenEmptySpaceBelow_whenDropped_thenEndOfTopLevel", () => {
    const target = dropTarget(ROWS, ROWS.length, 0, [datasource("eu1")], TREE);

    expect(target?.request).toEqual({ items: [datasource("eu1")], folder: null, before: null });
    expect(target?.indicator).toEqual({ kind: "line", index: ROWS.length, depth: 0 });
  });

  it("givenEphemeralRow_whenDroppedOn_thenLandsBelowIt", () => {
    expect(dropTarget(ROWS, at("datasource:env"), 0.1, [datasource("c")], TREE)?.request).toEqual({
      items: [datasource("c")],
      folder: null,
      before: datasource("a"),
    });
  });
});

describe("Move Up and Move Down (plan 136)", () => {
  it("givenMiddleDatasource_whenSteppedUp_thenGoesBeforeItsNeighbour", () => {
    expect(stepRequest(TREE, [datasource("b")], "up")).toEqual({
      items: [datasource("b")],
      folder: null,
      before: datasource("a"),
    });
  });

  it("givenMiddleDatasource_whenSteppedDown_thenGoesAfterItsNeighbour", () => {
    expect(stepRequest(TREE, [datasource("a")], "down")).toEqual({
      items: [datasource("a")],
      folder: null,
      before: datasource("c"),
    });
  });

  it("givenFirstOrLast_whenStepped_thenNothing", () => {
    expect(stepRequest(TREE, [datasource("a")], "up")).toBeNull();
    expect(stepRequest(TREE, [datasource("c")], "down")).toBeNull();
  });

  it("givenSelectionInTwoParents_whenStepped_thenNothing", () => {
    expect(stepRequest(TREE, [datasource("a"), datasource("p1")], "down")).toBeNull();
  });

  it("givenFolder_whenSteppedDown_thenPassesTheNextFolder", () => {
    const arranged = stepRequest(TREE, [folder("Prod")], "down");

    expect(arranged).toEqual({ items: [folder("Prod")], folder: null, before: datasource("a") });
  });
});
