import { describe, expect, it } from "vitest";
import type { DatasourceView } from "@table-craft/desktop/preload/bridge.js";
import {
  buildTree,
  folderPaths,
  visibleRows,
  type TreeNode,
} from "@table-craft/desktop/renderer/model/datasourceTree.js";
import { view } from "./datasourceViews.js";

function outline(nodes: readonly TreeNode[], depth = 0): string[] {
  return nodes.flatMap((node) => {
    const indent = "  ".repeat(depth);
    if (node.kind === "datasource") return [`${indent}${node.datasource.name}`];
    return [`${indent}${node.name}/`, ...outline(node.children, depth + 1)];
  });
}

const DATASOURCES: readonly DatasourceView[] = [
  view({ id: "1", name: "zeta" }),
  view({ id: "2", name: "pg", folder: "Docker/Main" }),
  view({ id: "3", name: "Alpha" }),
  view({ id: "4", name: "mysql", folder: "Docker/Main" }),
  view({ id: "5", name: "sqlite", folder: "Local" }),
  view({ id: "6", name: "legacy", folder: "Docker" }),
];

describe("datasource tree", () => {
  it("givenFolderPaths_whenTreeBuilt_thenNestsWithFoldersFirst", () => {
    expect(outline(buildTree(DATASOURCES))).toEqual([
      "Docker/",
      "  Main/",
      "    pg",
      "    mysql",
      "  legacy",
      "Local/",
      "  sqlite",
      "zeta",
      "Alpha",
    ]);
  });

  it("givenStoredOrder_whenBuilt_thenEachLevelShowsFoldersThenDatasourcesInStoredOrder", () => {
    const tree = buildTree(DATASOURCES, ["Local", "Docker", "Docker/Main", "Archive"]);

    expect(outline(tree)).toEqual([
      "Local/",
      "  sqlite",
      "Docker/",
      "  Main/",
      "    pg",
      "    mysql",
      "  legacy",
      "Archive/",
      "zeta",
      "Alpha",
    ]);
  });

  it("givenEmptyFolder_whenTreeBuilt_thenShownAmongFolders", () => {
    expect(outline(buildTree([view({ id: "1", name: "a" })], ["Archive/Old"]))).toEqual(["Archive/", "  Old/", "a"]);
  });

  it("givenCollapsedFolder_whenRowsListed_thenItsChildrenAreSkipped", () => {
    const rows = visibleRows(buildTree(DATASOURCES), new Set(["Docker"]));

    expect(rows.map((row) => row.key)).toEqual([
      "folder:Docker",
      "folder:Local",
      "datasource:5",
      "datasource:1",
      "datasource:3",
    ]);
    expect(rows.map((row) => row.depth)).toEqual([0, 0, 1, 0, 0]);
  });

  it("givenNestedFolders_whenPathsListed_thenEveryAncestorIsOffered", () => {
    expect(folderPaths(DATASOURCES, ["Archive"])).toEqual(["Archive", "Docker", "Docker/Main", "Local"]);
  });
});
