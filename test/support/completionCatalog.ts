import type {
  ColumnMeta,
  CompletionCatalog,
  ForeignKey,
  IncomingForeignKey,
  Namespace,
  Relation,
  RelationKind,
} from "@table-craft/plugin-api";

export const PUBLIC = ["table_craft", "public"] as const;
export const ARCHIVE = ["table_craft", "archive"] as const;

function column(name: string, type: string, position: number): ColumnMeta {
  return { name, position, type, nullable: true, default: null, comment: null, autoIncrement: false };
}

export function relation(
  name: string,
  columns: readonly (readonly [string, string])[],
  foreignKeys: readonly ForeignKey[] = [],
  kind: RelationKind = "table",
): Relation {
  return {
    name,
    kind,
    comment: null,
    columns: columns.map(([columnName, type], index) => column(columnName, type, index + 1)),
    primaryKey: { name: `${name}_pkey`, columns: ["id"] },
    uniqueKeys: [],
    foreignKeys,
    indexes: [],
  };
}

export function foreignKey(
  name: string,
  columns: readonly string[],
  target: readonly string[],
  targetRelation: string,
  targetColumns: readonly string[],
): ForeignKey {
  return {
    name,
    columns,
    target: { path: target, relation: targetRelation, columns: targetColumns },
    onDelete: "NO ACTION",
    onUpdate: "NO ACTION",
  };
}

/** The fixture schema's shape: customers, orders → customers, "Line Items", a view, and archive.old_orders → customers. */
export function fixtureRelations(): Map<string, Relation[]> {
  return new Map([
    [
      JSON.stringify(PUBLIC),
      [
        relation("Line Items", [
          ["id", "integer"],
          ["sku", "text"],
        ]),
        relation("customers", [
          ["id", "integer"],
          ["name", "text"],
          ["email", "text"],
        ]),
        relation("order_totals", [["id", "integer"]], [], "view"),
        relation(
          "orders",
          [
            ["id", "integer"],
            ["customer_id", "integer"],
            ["total", "numeric(12,2)"],
          ],
          [foreignKey("orders_customer_id_fkey", ["customer_id"], PUBLIC, "customers", ["id"])],
        ),
      ],
    ],
    [
      JSON.stringify(ARCHIVE),
      [
        relation(
          "old_orders",
          [
            ["id", "integer"],
            ["customer_id", "integer"],
          ],
          [foreignKey("old_orders_customer_id_fkey", ["customer_id"], PUBLIC, "customers", ["id"])],
        ),
      ],
    ],
  ]);
}

export interface FakeCatalog extends CompletionCatalog {
  /** Paths `relations` was asked for, in order. */
  readonly asked: string[][];
}

/** A catalog over `relations` by JSON path; `referencing` reads every namespace, as if all were described. */
export function fakeCatalog(
  relations: Map<string, Relation[]> = fixtureRelations(),
  current: readonly string[] = PUBLIC,
  serverVersion: string | null = null,
): FakeCatalog {
  const namespaces: Namespace[] = [...relations.keys()].map((key) => {
    const path = JSON.parse(key) as string[];
    return {
      path,
      name: path.at(-1) ?? "",
      kind: "schema",
      system: false,
      current: JSON.stringify(path) === JSON.stringify(current),
    };
  });
  const asked: string[][] = [];
  return {
    current,
    server: { version: serverVersion },
    asked,
    namespaces: () => Promise.resolve(namespaces),
    relations: (path) => {
      asked.push([...path]);
      return Promise.resolve(relations.get(JSON.stringify(path)) ?? []);
    },
    referencing: (path, name) => {
      const found: IncomingForeignKey[] = [];
      for (const [key, list] of relations) {
        for (const candidate of list) {
          for (const foreign of candidate.foreignKeys) {
            if (foreign.target.relation === name && JSON.stringify(foreign.target.path) === JSON.stringify(path)) {
              found.push({ path: JSON.parse(key) as string[], relation: candidate.name, foreignKey: foreign });
            }
          }
        }
      }
      return Promise.resolve(found);
    },
  };
}
