import { describe, expect, it } from "vitest";
import {
  DEFAULT_DIAGRAM_STATE,
  virtualKeyId,
  type DiagramState,
  type VirtualKey,
} from "@table-craft/desktop/diagrams/state.js";
import type { DescribedCatalog, InferredKey, Relation } from "@table-craft/desktop/engine/protocol.js";
import {
  DIAGRAM_AUTO_SHOW_TABLES,
  DIAGRAM_FULL_COLUMNS_TABLES,
  diagramGraph,
  ghostTableId,
  openingLayout,
  shownGraph,
  visibleColumns,
} from "@table-craft/desktop/renderer/model/diagram.js";
import {
  DIAGRAM_NEW_TABLES_GAP_PX,
  elkGraph,
  placeNew,
  tableSizes,
  type DiagramMetrics,
} from "@table-craft/desktop/renderer/model/diagramLayout.js";
import { AUDIT_PATH, CUSTOMERS, ORDERS, PUBLIC_CATALOG, PUBLIC_PATH } from "./catalogFixtures.js";

const ROW_HEIGHT = 20;
const METRICS: DiagramMetrics = { rowHeight: ROW_HEIGHT, padding: 4, icon: 16, measure: (text) => text.length * 7 };

function relation(name: string, columns: readonly [string, string, boolean][], primaryKey: string | null): Relation {
  return {
    name,
    kind: "table",
    comment: null,
    columns: columns.map(([column, type, nullable], index) => ({
      name: column,
      position: index + 1,
      type,
      nullable,
      default: null,
      comment: null,
      autoIncrement: false,
    })),
    primaryKey: primaryKey === null ? null : { name: `${name}_pkey`, columns: [primaryKey] },
    uniqueKeys: [],
    foreignKeys: [],
    indexes: [],
  };
}

const PEOPLE = relation("people", [["id", "integer", false]], "id");
const NOTES = relation(
  "notes",
  [
    ["id", "integer", false],
    ["person_id", "integer", true],
    ["author_id", "integer", false],
  ],
  "id",
);

function catalogOf(...relations: Relation[]): DescribedCatalog {
  return { catalog: { path: PUBLIC_PATH, relations, routines: [], sequences: [] }, introspectedAt: 1, elapsedMs: 1 };
}

const NOTES_CATALOG = catalogOf(PEOPLE, NOTES);
const PERSON_KEY: InferredKey = {
  id: "notes(person_id)->people(id)",
  relation: "notes",
  columns: ["person_id"],
  target: { relation: "people", columns: ["id"] },
};

function virtual(relationName: string, column: string, target: string): VirtualKey {
  const key = {
    path: PUBLIC_PATH,
    relation: relationName,
    columns: [column],
    target: { path: PUBLIC_PATH, relation: target, columns: ["id"] },
  };
  return { id: virtualKeyId(key), ...key };
}

function state(overrides: Partial<DiagramState> = {}): DiagramState {
  return { ...DEFAULT_DIAGRAM_STATE, ...overrides };
}

describe("diagram graph", () => {
  it("givenInferredKey_whenGraphBuilt_thenOneInferredEdgeAndMarkedColumns", () => {
    const graph = diagramGraph({ catalog: NOTES_CATALOG, inferred: [PERSON_KEY], state: state() });

    expect(graph.edges.map((edge) => [edge.origin, edge.source, edge.target])).toEqual([
      ["inferred", "notes", "people"],
    ]);
    const notes = graph.tables.find((table) => table.id === "notes");
    expect(notes?.columns.find((column) => column.name === "person_id")?.foreignKey).toBe(true);
    expect(graph.tables.find((table) => table.id === "people")?.columns[0]?.referenced).toBe(true);
  });

  it("givenHiddenInferredKey_whenGraphBuilt_thenEdgeAbsent", () => {
    const graph = diagramGraph({
      catalog: NOTES_CATALOG,
      inferred: [PERSON_KEY],
      state: state({ hiddenKeys: [PERSON_KEY.id] }),
    });

    expect(graph.edges).toEqual([]);
  });

  it("givenVirtualKeyOnInferredColumns_whenGraphBuilt_thenOneVirtualEdge", () => {
    const key = virtual("notes", "person_id", "people");
    const graph = diagramGraph({
      catalog: NOTES_CATALOG,
      inferred: [PERSON_KEY],
      state: state({ virtualKeys: [key] }),
    });

    expect(graph.edges.map((edge) => [edge.origin, edge.keyId])).toEqual([["virtual", key.id]]);
  });

  it("givenDeclaredKeyOnInferredColumns_whenGraphBuilt_thenOnlyTheDeclaredEdge", () => {
    const inferred: InferredKey = {
      id: "orders(customer_id)->customers(id)",
      relation: "orders",
      columns: ["customer_id"],
      target: { relation: "customers", columns: ["id"] },
    };
    const graph = diagramGraph({ catalog: PUBLIC_CATALOG, inferred: [inferred], state: state() });

    expect(graph.edges.map((edge) => edge.origin)).toEqual(["declared"]);
  });

  it("givenCrossNamespaceDeclaredKey_whenGraphBuilt_thenGhostTable", () => {
    const archived: Relation = {
      ...ORDERS,
      foreignKeys: [
        {
          name: "orders_archive_fkey",
          columns: ["customer_id"],
          target: { path: AUDIT_PATH, relation: "customers_archive", columns: ["id"] },
          onDelete: "NO ACTION",
          onUpdate: "NO ACTION",
        },
      ],
    };
    const graph = diagramGraph({ catalog: catalogOf(CUSTOMERS, archived), inferred: [], state: state() });

    const ghostId = ghostTableId(AUDIT_PATH, "customers_archive");
    const ghost = graph.tables.find((table) => table.id === ghostId);
    expect(ghost).toMatchObject({ kind: "external", name: "audit.customers_archive", columns: [] });
    expect(graph.edges[0]?.target).toBe(ghostId);
  });

  it("givenNullableSourceColumn_whenGraphBuilt_thenEdgeOptional", () => {
    const author = virtual("notes", "author_id", "people");
    const graph = diagramGraph({
      catalog: NOTES_CATALOG,
      inferred: [PERSON_KEY],
      state: state({ virtualKeys: [author] }),
    });

    const optional = Object.fromEntries(
      graph.edges.map((edge): [string, boolean] => [edge.from.columns.join(), edge.optional]),
    );
    expect(optional).toEqual({ person_id: true, author_id: false });
  });

  it("givenInferenceOff_whenGraphBuilt_thenOnlyDeclaredAndVirtual", () => {
    const author = virtual("notes", "author_id", "people");
    const graph = diagramGraph({
      catalog: catalogOf(PEOPLE, NOTES, CUSTOMERS, ORDERS),
      inferred: [PERSON_KEY],
      state: state({ inferKeys: false, virtualKeys: [author] }),
    });

    expect(graph.edges.map((edge) => edge.origin).sort()).toEqual(["declared", "virtual"]);
  });

  it("givenVirtualKeyToADroppedTable_whenGraphBuilt_thenNotDrawn", () => {
    const gone = virtual("notes", "person_id", "persons_old");
    const graph = diagramGraph({ catalog: NOTES_CATALOG, inferred: [], state: state({ virtualKeys: [gone] }) });

    expect(graph.edges).toEqual([]);
  });

  it("givenHiddenTable_whenShown_thenItAndItsEdgesDrop", () => {
    const graph = diagramGraph({ catalog: NOTES_CATALOG, inferred: [PERSON_KEY], state: state() });

    const shown = shownGraph(graph, ["people"]);
    expect(shown.tables.map((table) => table.id)).toEqual(["notes"]);
    expect(shown.edges).toEqual([]);
  });

  it("givenKeysOnlyMode_whenColumnsListed_thenOnlyKeyColumns", () => {
    const graph = diagramGraph({ catalog: NOTES_CATALOG, inferred: [PERSON_KEY], state: state() });
    const notes = graph.tables.find((table) => table.id === "notes");

    expect(notes === undefined ? [] : visibleColumns(notes, "keys").map((column) => column.name)).toEqual([
      "id",
      "person_id",
    ]);
  });
});

describe("diagram opening", () => {
  const ids = (count: number): string[] => Array.from({ length: count }, (_, index) => `t${String(index)}`);

  it("givenFewTables_whenOpened_thenAllShownWithEveryColumn", () => {
    expect(openingLayout(ids(DIAGRAM_FULL_COLUMNS_TABLES))).toEqual({
      layout: { positions: {}, hiddenTables: [], columns: "all" },
      pickerOpen: false,
    });
  });

  it("givenMoreThanFullColumnTables_whenOpened_thenKeysOnly", () => {
    expect(openingLayout(ids(DIAGRAM_FULL_COLUMNS_TABLES + 1)).layout.columns).toBe("keys");
  });

  it("givenMoreThanAutoShowTables_whenOpened_thenNoTableShownAndPickerOpen", () => {
    const tables = ids(DIAGRAM_AUTO_SHOW_TABLES + 1);
    const opening = openingLayout(tables);

    expect(opening.pickerOpen).toBe(true);
    expect(opening.layout.hiddenTables).toEqual(tables);
  });
});

describe("diagram layout", () => {
  it("givenSavedPositions_whenLaidOut_thenSavedTablesStayAndNewOnesPlaced", () => {
    const saved = { customers: { x: 10, y: 20 } };
    const laidOut = { customers: { x: 0, y: 0 }, orders: { x: 200, y: 0 } };
    const sizes = new Map([["customers", { width: 100, height: 60 }]]);

    const placed = placeNew(saved, laidOut, sizes);

    expect(placed.customers).toEqual({ x: 10, y: 20 });
    expect(placed.orders).toBeDefined();
  });

  it("givenSavedAndNewTables_whenPlaced_thenNewOnesRightOfSavedBounds", () => {
    const saved = { a: { x: 0, y: 50 }, b: { x: 300, y: 10 } };
    const laidOut = { c: { x: 40, y: 40 }, d: { x: 240, y: 90 } };
    const sizes = new Map([
      ["a", { width: 100, height: 60 }],
      ["b", { width: 150, height: 60 }],
    ]);

    const placed = placeNew(saved, laidOut, sizes);

    const right = 300 + 150 + DIAGRAM_NEW_TABLES_GAP_PX;
    expect(placed).toEqual({ ...saved, c: { x: right, y: 10 }, d: { x: right + 200, y: 60 } });
  });

  it("givenNothingSaved_whenPlaced_thenTheLayoutAsIs", () => {
    const laidOut = { a: { x: 12, y: 8 } };

    expect(placeNew({}, laidOut, new Map())).toEqual(laidOut);
  });

  it("givenKeyedColumns_whenElkGraphBuilt_thenOnePortPerColumnInRowOrder", () => {
    const author = virtual("notes", "author_id", "people");
    const graph = diagramGraph({
      catalog: NOTES_CATALOG,
      inferred: [PERSON_KEY],
      state: state({ virtualKeys: [author] }),
    });

    const elk = elkGraph(graph, tableSizes(graph.tables, "all", METRICS), "all", ROW_HEIGHT);

    expect(elk.layoutOptions).toMatchObject({ "elk.algorithm": "layered", "elk.direction": "RIGHT" });
    const notes = elk.children.find((child) => child.id === "notes");
    expect(notes?.layoutOptions).toMatchObject({ "elk.portConstraints": "FIXED_ORDER" });
    expect(
      notes?.ports?.map((port) => [JSON.parse(port.id) as unknown, port.layoutOptions?.["elk.port.side"], port.y]),
    ).toEqual([
      [["notes", "person_id"], "EAST", ROW_HEIGHT * 2.5],
      [["notes", "author_id"], "EAST", ROW_HEIGHT * 3.5],
    ]);
    const people = elk.children.find((child) => child.id === "people");
    expect(people?.ports?.map((port) => port.layoutOptions?.["elk.port.side"])).toEqual(["WEST"]);
    expect(elk.edges.map((edge) => [edge.sources[0], edge.targets[0]])).toEqual([
      [JSON.stringify(["notes", "person_id"]), JSON.stringify(["people", "id"])],
      [JSON.stringify(["notes", "author_id"]), JSON.stringify(["people", "id"])],
    ]);
  });

  it("givenGhostTable_whenSized_thenHeaderOnly", () => {
    const graph = diagramGraph({
      catalog: catalogOf({
        ...NOTES,
        foreignKeys: [
          {
            name: "fk",
            columns: ["person_id"],
            target: { path: AUDIT_PATH, relation: "people", columns: ["id"] },
            onDelete: "",
            onUpdate: "",
          },
        ],
      }),
      inferred: [],
      state: state(),
    });

    const sizes = tableSizes(graph.tables, "all", METRICS);
    expect(sizes.get(ghostTableId(AUDIT_PATH, "people"))?.height).toBe(ROW_HEIGHT);
    expect(sizes.get("notes")?.height).toBe(ROW_HEIGHT * 4);
  });
});
