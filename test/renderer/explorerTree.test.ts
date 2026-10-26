import { describe, expect, it } from "vitest";
import {
  datasourceKey,
  namespaceKey,
  objectGroupKey,
  pathKey,
  relationKey,
  revealKeys,
  routineKey,
  shownNamespaceCount,
  type ExplorerRow,
} from "@table-craft/desktop/renderer/model/explorerTree.js";
import type { Namespace } from "@table-craft/desktop/engine/protocol.js";
import { buildTree } from "@table-craft/desktop/renderer/model/datasourceTree.js";
import { AUDIT_PATH, LOADED_PG, outline, PUBLIC_CATALOG, PUBLIC_PATH, rowsOf } from "./catalogFixtures.js";
import { view } from "./datasourceViews.js";

const DATABASE_KEY = namespaceKey("pg", ["table_craft"]);
const PUBLIC_KEY = namespaceKey("pg", PUBLIC_PATH);
const TABLES_KEY = objectGroupKey("pg", PUBLIC_PATH, "tables");
const ORDERS_KEY = relationKey("pg", PUBLIC_PATH, "orders");

function expanded(...keys: readonly string[]): ReadonlySet<string> {
  return new Set([datasourceKey("pg"), ...keys]);
}

function row(rows: readonly ExplorerRow[], label: string): ExplorerRow | undefined {
  return rows.find((candidate) => candidate.label === label);
}

describe("explorer tree", () => {
  it("givenSystemSchemasHidden_whenTreeBuilt_thenSystemNamespacesAreAbsent", () => {
    const hidden = outline(rowsOf({ expanded: expanded(DATABASE_KEY) }));
    const shown = outline(rowsOf({ expanded: expanded(DATABASE_KEY), showSystem: true }));

    expect(hidden).toEqual(["0 pg", "1 table_craft", "2 audit", "2 public"]);
    expect(shown).toEqual(["0 pg", "1 table_craft", "2 audit", "2 information_schema", "2 pg_catalog", "2 public"]);
  });

  it("givenDescribedNamespace_whenExpanded_thenGroupsShowCountsAndOnlyWhenNonEmpty", () => {
    const rows = rowsOf({ expanded: expanded(DATABASE_KEY, PUBLIC_KEY) });

    expect(outline(rows).slice(3)).toEqual(["2 public", "3 tables", "3 views"]);
    expect(
      rows.filter((candidate) => candidate.node.kind === "objectGroup").map((candidate) => candidate.node),
    ).toEqual([
      expect.objectContaining({ group: "tables", count: 2 }),
      expect.objectContaining({ group: "views", count: 1 }),
    ]);
  });

  it("givenNamespaceNeverDescribed_whenExpanded_thenALoadingRowStandsInForItsObjects", () => {
    const rows = rowsOf({ expanded: expanded(DATABASE_KEY, namespaceKey("pg", AUDIT_PATH)) });

    expect(outline(rows)).toEqual(["0 pg", "1 table_craft", "2 audit", "3 loading…", "2 public"]);
  });

  it("givenCollapsedTable_whenTreeBuilt_thenColumnsAreNotRows", () => {
    const rows = rowsOf({ expanded: expanded(DATABASE_KEY, PUBLIC_KEY, TABLES_KEY) });

    expect(outline(rows).slice(5)).toEqual(["4 customers", "4 orders", "3 views"]);
    expect(row(rows, "orders")).toMatchObject({ expandable: true, expanded: false });
    expect(row(rows, "customer_id")).toBeUndefined();
  });

  it("givenExpandedOrders_whenTreeBuilt_thenItsGroupsAndColumnMarkersShow", () => {
    const columnsKey = rowsOf({ expanded: expanded(DATABASE_KEY, PUBLIC_KEY, TABLES_KEY, ORDERS_KEY) }).find(
      (candidate) => candidate.label === "columns",
    )?.key;
    const rows = rowsOf({ expanded: expanded(DATABASE_KEY, PUBLIC_KEY, TABLES_KEY, ORDERS_KEY, columnsKey ?? "") });

    expect(outline(rows).slice(6, 15)).toEqual([
      "4 orders",
      "5 columns",
      "6 id",
      "6 customer_id",
      "6 total",
      "6 placed_at",
      "5 keys",
      "5 foreign keys",
      "5 indexes",
    ]);
    expect(row(rows, "id")?.node).toMatchObject({ kind: "column", primary: true, foreign: false });
    expect(row(rows, "customer_id")?.node).toMatchObject({ kind: "column", primary: false, foreign: true });
  });

  it("givenTableWithNoIndexes_whenTreeBuilt_thenNoIndexesGroup", () => {
    const customers = relationKey("pg", PUBLIC_PATH, "customers");
    const rows = rowsOf({ expanded: expanded(DATABASE_KEY, PUBLIC_KEY, TABLES_KEY, customers) });

    expect(outline(rows).slice(6, 9)).toEqual(["5 columns", "5 keys", "4 orders"]);
  });

  it("givenDatasourceWithoutSchemaTree_whenTreeBuilt_thenItCannotExpand", () => {
    const rows = rowsOf({ canExpand: () => false, expanded: expanded() });

    expect(rows).toEqual([expect.objectContaining({ label: "pg", expandable: false, expanded: false })]);
  });

  it("givenListingFailed_whenDatasourceExpanded_thenAnErrorRowSaysWhy", () => {
    const error = { code: "introspectionFailed" as const, message: "permission denied", hint: "Ask for access." };
    const rows = rowsOf({
      expanded: expanded(),
      catalogs: { pg: { namespaces: null, loading: false, error, namespaceStates: {} } },
    });

    expect(rows[1]?.node).toEqual({ kind: "error", datasourceId: "pg", error });
  });

  it("givenDescribeFailed_whenNamespaceExpanded_thenAnErrorRowSaysWhyAndNoLoadingRow", () => {
    const error = { code: "introspectionFailed" as const, message: "permission denied for schema audit", hint: "Ask." };
    const rows = rowsOf({
      expanded: expanded(DATABASE_KEY, namespaceKey("pg", AUDIT_PATH)),
      catalogs: {
        pg: {
          ...LOADED_PG,
          namespaceStates: { [pathKey(AUDIT_PATH)]: { described: null, loading: false, error } },
        },
      },
    });

    expect(outline(rows)).toEqual([
      "0 pg",
      "1 table_craft",
      "2 audit",
      "3 permission denied for schema audit",
      "2 public",
    ]);
    expect(rows[3]?.node).toEqual({ kind: "error", datasourceId: "pg", error });
  });

  it("givenRelation_whenRevealed_thenEveryAncestorIsExpandedAndTheRelationIsLast", () => {
    const keys = revealKeys("pg", PUBLIC_PATH, { name: "orders", kind: "table" });
    const rows = rowsOf({ expanded: new Set(keys.slice(0, -1)) });

    expect(keys[keys.length - 1]).toBe(ORDERS_KEY);
    expect(rows.some((candidate) => candidate.key === ORDERS_KEY)).toBe(true);
  });

  it("givenOverloads_whenTreeBuilt_thenOneRowEach", () => {
    const parameter = (name: string, type: string) => ({ name, type, mode: "in" as const, hasDefault: false });
    const calcFee = (signature: string, parameters: readonly ReturnType<typeof parameter>[]) => ({
      name: "calc_fee",
      kind: "function" as const,
      signature,
      parameters,
      returns: "numeric",
    });
    const routines = [
      calcFee("amount numeric, currency text", [parameter("amount", "numeric"), parameter("currency", "text")]),
      calcFee("amount numeric", [parameter("amount", "numeric")]),
    ];
    const described = { ...PUBLIC_CATALOG, catalog: { ...PUBLIC_CATALOG.catalog, routines } };
    const catalogs = {
      pg: { ...LOADED_PG, namespaceStates: { [pathKey(PUBLIC_PATH)]: { described, loading: false, error: null } } },
    };
    const routinesKey = objectGroupKey("pg", PUBLIC_PATH, "routines");

    const rows = rowsOf({ catalogs, expanded: expanded(DATABASE_KEY, PUBLIC_KEY, routinesKey) });
    const routineRows = rows.filter((candidate) => candidate.node.kind === "routine");

    expect(routineRows.map((candidate) => candidate.label)).toEqual(["calc_fee", "calc_fee"]);
    expect(new Set(routineRows.map((candidate) => candidate.key)).size).toBe(2);
    expect(routineRows.map((candidate) => candidate.key)).toEqual(
      routines.map((routine) => routineKey("pg", PUBLIC_PATH, routine)),
    );
  });
});

function database(name: string, overrides: Partial<Namespace> = {}): Namespace {
  return { path: [name], name, kind: "schema", system: false, current: false, ...overrides };
}

const SERVER_DATABASES: readonly Namespace[] = [
  database("billing"),
  database("mysql", { system: true }),
  database("shop", { current: true }),
  database("staging"),
];

function serverRows(shownNamespaces?: readonly string[]): readonly ExplorerRow[] {
  return rowsOf({
    tree: buildTree([view({ id: "pg", name: "pg", ...(shownNamespaces === undefined ? {} : { shownNamespaces }) })]),
    catalogs: { pg: { ...LOADED_PG, namespaces: SERVER_DATABASES, namespaceStates: {} } },
    expanded: expanded(),
    showSystem: true,
  });
}

describe("explorer tree shown schemas", () => {
  it("givenNoShownList_whenTreeBuilt_thenEveryNamespaceShows", () => {
    expect(outline(serverRows())).toEqual(["0 pg", "1 billing", "1 mysql", "1 shop", "1 staging"]);
  });

  it("givenShownList_whenTreeBuilt_thenUnlistedTopLevelNamespacesAreHidden", () => {
    expect(outline(serverRows(["shop", "mysql", "gone"]))).toEqual(["0 pg", "1 mysql", "1 shop"]);
  });

  it("givenShownList_whenDatabaseExpanded_thenItsSchemasAreNotFiltered", () => {
    const rows = rowsOf({
      tree: buildTree([view({ id: "pg", name: "pg", shownNamespaces: ["table_craft"] })]),
      expanded: expanded(DATABASE_KEY),
    });

    expect(outline(rows)).toEqual(["0 pg", "1 table_craft", "2 audit", "2 public"]);
  });

  it("givenShownList_whenCounted_thenListedOnesOfTheTopLevelOnes", () => {
    expect(shownNamespaceCount({ shownNamespaces: ["shop", "gone"] }, SERVER_DATABASES, true)).toEqual({
      shown: 1,
      total: 4,
    });
    expect(shownNamespaceCount({ shownNamespaces: ["table_craft"] }, LOADED_PG.namespaces, true)).toEqual({
      shown: 1,
      total: 1,
    });
  });

  it("givenSystemSchemasHidden_whenCounted_thenHiddenSystemOnesCountOnNeitherSide", () => {
    expect(shownNamespaceCount({ shownNamespaces: ["shop", "mysql"] }, SERVER_DATABASES, false)).toEqual({
      shown: 1,
      total: 3,
    });
  });

  it("givenNoShownListOrNothingListed_whenCounted_thenNull", () => {
    expect(shownNamespaceCount({}, SERVER_DATABASES, true)).toBeNull();
    expect(shownNamespaceCount({ shownNamespaces: ["shop"] }, null, true)).toBeNull();
  });
});
