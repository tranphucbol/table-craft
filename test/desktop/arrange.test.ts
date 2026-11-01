import { describe, expect, it } from "vitest";
import {
  arrange,
  ArrangeError,
  folderKeepingContent,
  normalizeFolders,
  type ArrangeTree,
  type MoveRequest,
  type TreeItemRef,
} from "@table-craft/desktop/datasourceTree/arrange.js";

interface Row {
  readonly id: string;
  readonly folder: string | null;
}

const ds = (id: string): TreeItemRef => ({ kind: "datasource", id });
const dir = (path: string): TreeItemRef => ({ kind: "folder", path });

const TREE: ArrangeTree<Row> = {
  folders: ["Prod", "Prod/EU", "Prod/US", "Dev"],
  datasources: [
    { id: "eu1", folder: "Prod/EU" },
    { id: "eu2", folder: "Prod/EU" },
    { id: "p1", folder: "Prod" },
    { id: "p2", folder: "Prod" },
    { id: "top1", folder: null },
    { id: "top2", folder: null },
    { id: "top3", folder: null },
  ],
};

function move(request: MoveRequest, tree: ArrangeTree<Row> = TREE) {
  return arrange(tree, request);
}

function idsIn(rows: readonly Row[], folder: string | null): string[] {
  return rows.filter((row) => row.folder === folder).map((row) => row.id);
}

describe("arrange", () => {
  it("givenTwoDatasourcesInOneFolder_whenSecondMovedBeforeFirst_thenTheirOrderSwaps", () => {
    const arranged = move({ items: [ds("eu2")], folder: "Prod/EU", before: ds("eu1") });

    expect(idsIn(arranged.datasources, "Prod/EU")).toEqual(["eu2", "eu1"]);
    expect(arranged.changed).toBe(true);
  });

  it("givenDatasourceAtTopLevel_whenMovedIntoFolder_thenItLandsLastInThatFolder", () => {
    const arranged = move({ items: [ds("top1")], folder: "Prod", before: null });

    expect(idsIn(arranged.datasources, "Prod")).toEqual(["p1", "p2", "top1"]);
  });

  it("givenThreeSelected_whenMovedBeforeAnchor_thenTheyKeepTheirRelativeOrder", () => {
    const arranged = move({ items: [ds("top3"), ds("eu1"), ds("p2")], folder: null, before: ds("top1") });

    expect(idsIn(arranged.datasources, null)).toEqual(["eu1", "p2", "top3", "top1", "top2"]);
  });

  it("givenFolder_whenMovedIntoAnotherFolder_thenItAndEveryDescendantPathChange", () => {
    const arranged = move({ items: [dir("Prod")], folder: "Dev", before: null });

    expect(arranged.folders).toEqual(["Dev", "Dev/Prod", "Dev/Prod/EU", "Dev/Prod/US"]);
    expect(idsIn(arranged.datasources, "Dev/Prod/EU")).toEqual(["eu1", "eu2"]);
    expect([...arranged.renamed]).toEqual([
      ["Prod", "Dev/Prod"],
      ["Prod/EU", "Dev/Prod/EU"],
      ["Prod/US", "Dev/Prod/US"],
    ]);
  });

  it("givenFolder_whenMovedBeforeASibling_thenOnlyTheFolderOrderChanges", () => {
    const arranged = move({ items: [dir("Dev")], folder: null, before: dir("Prod") });

    expect(arranged.folders).toEqual(["Dev", "Prod", "Prod/EU", "Prod/US"]);
    expect(arranged.renamed.size).toBe(0);
  });

  it("givenFolder_whenMovedIntoItsOwnDescendant_thenArrangeErrorSaysDropItOutside", () => {
    expect(() => move({ items: [dir("Prod")], folder: "Prod/EU", before: null })).toThrow(
      new ArrangeError('Cannot move "Prod" into itself.', "Drop it outside Prod."),
    );
  });

  it("givenTargetHoldsFolderOfSameName_whenFolderMovedThere_thenArrangeErrorNamesTheClash", () => {
    const tree = { ...TREE, folders: [...TREE.folders, "Dev/EU"] };

    expect(() => move({ items: [dir("Prod/EU")], folder: "Dev", before: null }, tree)).toThrow(
      'Folder "Dev" already has a folder named "EU".',
    );
  });

  it("givenFolderAndOneOfItsDatasourcesSelected_whenMoved_thenTheDatasourceMovesWithItsFolder", () => {
    const arranged = move({ items: [dir("Prod/EU"), ds("eu1")], folder: "Dev", before: null });

    expect(idsIn(arranged.datasources, "Dev/EU")).toEqual(["eu1", "eu2"]);
  });

  it("givenMixedSelection_whenDroppedBeforeAFolder_thenFoldersLandThereAndDatasourcesLeadTheDatasources", () => {
    const arranged = move({ items: [dir("Prod/US"), ds("top2")], folder: "Prod", before: dir("Prod/EU") });

    expect(arranged.folders).toEqual(["Prod", "Prod/US", "Prod/EU", "Dev"]);
    expect(idsIn(arranged.datasources, "Prod")).toEqual(["top2", "p1", "p2"]);
  });

  it("givenDropBeforeOneOfTheMovedItems_whenArranged_thenNothingChanges", () => {
    const arranged = move({ items: [ds("top1"), ds("top2")], folder: null, before: ds("top1") });

    expect(arranged.changed).toBe(false);
    expect(arranged.datasources).toBe(TREE.datasources);
  });

  it("givenUnknownId_whenArranged_thenArrangeErrorSaysItMayHaveBeenDeleted", () => {
    expect(() => move({ items: [ds("gone")], folder: null, before: null })).toThrow('No data source with id "gone".');
  });

  it("givenBeforeOutsideTheDestination_whenArranged_thenArrangeErrorIsThrown", () => {
    expect(() => move({ items: [ds("top1")], folder: "Prod", before: ds("top2") })).toThrow(ArrangeError);
  });
});

describe("normalizeFolders", () => {
  it("givenFolderListMissingAnAncestor_whenNormalized_thenTheAncestorIsAppended", () => {
    expect(normalizeFolders(["Z"], [{ folder: "A/B" }])).toEqual(["Z", "A", "A/B"]);
  });

  it("givenDuplicateOrUntrimmedPaths_whenNormalized_thenEachPathAppearsOnce", () => {
    expect(normalizeFolders([" A / B ", "A", "A/B/"], [])).toEqual(["A", "A/B"]);
  });
});

describe("folderKeepingContent", () => {
  it("givenFolderWithAnUnselectedDatasource_whenChecked_thenTheFolderIsNamed", () => {
    expect(folderKeepingContent(TREE, ["eu1"], ["Prod/EU"])).toBe("Prod/EU");
    expect(folderKeepingContent(TREE, ["eu1", "eu2"], ["Prod/EU"])).toBeNull();
  });
});
