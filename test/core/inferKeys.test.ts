import { describe, expect, it } from "vitest";
import { inferForeignKeys, nameTokens } from "@table-craft/core";
import type { ColumnMeta, ForeignKey, NamespaceCatalog, Relation, RelationKind } from "@table-craft/plugin-api";

interface TableSpec {
  readonly columns: readonly (readonly [string, string])[];
  readonly primaryKey?: readonly string[] | null;
  readonly unique?: readonly (readonly string[])[];
  readonly foreignKeys?: readonly ForeignKey[];
  readonly kind?: RelationKind;
}

function column(name: string, type: string, position: number): ColumnMeta {
  return { name, position, type, nullable: true, default: null, comment: null, autoIncrement: false };
}

function table(name: string, spec: TableSpec): Relation {
  const primary = spec.primaryKey === undefined ? ["id"] : spec.primaryKey;
  return {
    name,
    kind: spec.kind ?? "table",
    comment: null,
    columns: spec.columns.map(([columnName, type], index) => column(columnName, type, index + 1)),
    primaryKey: primary === null ? null : { name: `${name}_pkey`, columns: primary },
    uniqueKeys: (spec.unique ?? []).map((columns, index) => ({ name: `${name}_uq${String(index)}`, columns })),
    foreignKeys: spec.foreignKeys ?? [],
    indexes: [],
  };
}

function catalog(...relations: Relation[]): NamespaceCatalog {
  return { path: ["main"], relations, routines: [], sequences: [] };
}

const CUSTOMERS = table("customers", { columns: [["id", "bigint"]] });

function inferredIds(...relations: Relation[]): string[] {
  return inferForeignKeys(catalog(...relations)).map((key) => key.id);
}

describe("inferred foreign keys", () => {
  it("givenCamelPascalAndSnakeNames_whenTokenised_thenSameTokens", () => {
    expect(nameTokens("customerId")).toEqual(["customer", "id"]);
    expect(nameTokens("CustomerID")).toEqual(["customer", "id"]);
    expect(nameTokens("customer_id")).toEqual(["customer", "id"]);
    expect(nameTokens("Shipping-Address ID")).toEqual(["shipping", "address", "id"]);
  });

  it("givenSnakeCaseIdColumn_whenInferred_thenPointsAtPluralTable", () => {
    const orders = table("orders", {
      columns: [
        ["id", "bigint"],
        ["customer_id", "bigint"],
      ],
    });
    expect(inferForeignKeys(catalog(CUSTOMERS, orders))).toEqual([
      {
        id: "orders(customer_id)->customers(id)",
        relation: "orders",
        columns: ["customer_id"],
        target: { relation: "customers", columns: ["id"] },
      },
    ]);
  });

  it("givenCamelCaseIdColumn_whenInferred_thenPointsAtTable", () => {
    const customers = table("customers", { columns: [["id", "int"]] });
    const orders = table("orders", {
      columns: [
        ["id", "int"],
        ["customerId", "int"],
      ],
    });
    expect(inferredIds(customers, orders)).toEqual(["orders(customerId)->customers(id)"]);
  });

  it("givenSingularTableName_whenInferred_thenMatches", () => {
    const customer = table("customer", { columns: [["id", "int"]] });
    const orders = table("orders", {
      columns: [
        ["id", "int"],
        ["customer_id", "int"],
      ],
    });
    expect(inferredIds(customer, orders)).toEqual(["orders(customer_id)->customer(id)"]);
  });

  it("givenYEndingStem_whenInferred_thenMatchesIesTable", () => {
    const categories = table("categories", { columns: [["id", "int"]] });
    const products = table("products", {
      columns: [
        ["id", "int"],
        ["category_id", "int"],
      ],
    });
    expect(inferredIds(categories, products)).toEqual(["products(category_id)->categories(id)"]);
  });

  it("givenEsPluralTable_whenInferred_thenMatches", () => {
    const addresses = table("addresses", { columns: [["id", "int"]] });
    const people = table("users", {
      columns: [
        ["id", "int"],
        ["address_id", "int"],
      ],
    });
    expect(inferredIds(addresses, people)).toEqual(["users(address_id)->addresses(id)"]);
  });

  it("givenRolePrefixedColumn_whenInferred_thenDropsLeadingTokens", () => {
    const addresses = table("addresses", { columns: [["id", "int"]] });
    const users = table("users", { columns: [["id", "int"]] });
    const orders = table("orders", {
      columns: [
        ["id", "int"],
        ["shipping_address_id", "int"],
        ["created_by_user_id", "int"],
      ],
    });
    expect(inferredIds(addresses, users, orders)).toEqual([
      "orders(created_by_user_id)->users(id)",
      "orders(shipping_address_id)->addresses(id)",
    ]);
  });

  it("givenColumnEqualToTargetPk_whenInferred_thenMatches", () => {
    const customers = table("Customers", { columns: [["CustomerID", "int"]], primaryKey: ["CustomerID"] });
    const orders = table("Orders", {
      columns: [
        ["OrderID", "int"],
        ["CustomerID", "int"],
      ],
      primaryKey: ["OrderID"],
    });
    expect(inferredIds(customers, orders)).toEqual(["Orders(CustomerID)->Customers(CustomerID)"]);
  });

  it("givenStemPlusNonIdPk_whenInferred_thenMatches", () => {
    const customers = table("customers", { columns: [["code", "varchar(20)"]], primaryKey: ["code"] });
    const orders = table("orders", {
      columns: [
        ["id", "int"],
        ["customer_code", "varchar(20)"],
      ],
    });
    expect(inferredIds(customers, orders)).toEqual(["orders(customer_code)->customers(code)"]);
  });

  it("givenParentId_whenInferred_thenSelfEdge", () => {
    const categories = table("categories", {
      columns: [
        ["id", "int"],
        ["parent_id", "int"],
      ],
    });
    expect(inferredIds(categories)).toEqual(["categories(parent_id)->categories(id)"]);
  });

  it("givenTypeClassMismatch_whenInferred_thenNoKey", () => {
    const orders = table("orders", {
      columns: [
        ["id", "int"],
        ["customer_id", "varchar(20)"],
      ],
    });
    expect(inferredIds(CUSTOMERS, orders)).toEqual([]);
  });

  it("givenTwoMatchingTables_whenInferred_thenNoKey", () => {
    const customer = table("customer", { columns: [["id", "int"]] });
    const customers = table("customers", { columns: [["id", "int"]] });
    const orders = table("orders", {
      columns: [
        ["id", "int"],
        ["customer_id", "int"],
      ],
    });
    expect(inferredIds(customer, customers, orders)).toEqual([]);
  });

  it("givenTargetWithoutSingleColumnKey_whenInferred_thenNoKey", () => {
    const customers = table("customers", {
      columns: [
        ["id", "int"],
        ["region", "int"],
      ],
      primaryKey: ["id", "region"],
    });
    const keyless = table("customers", { columns: [["id", "int"]], primaryKey: null });
    const orders = table("orders", {
      columns: [
        ["id", "int"],
        ["customer_id", "int"],
      ],
    });
    expect(inferredIds(customers, orders)).toEqual([]);
    expect(inferredIds(keyless, orders)).toEqual([]);
  });

  it("givenOnlyASingleColumnUniqueKey_whenInferred_thenPointsAtIt", () => {
    const customers = table("customers", { columns: [["id", "int"]], primaryKey: null, unique: [["id"]] });
    const orders = table("orders", {
      columns: [
        ["id", "int"],
        ["customer_id", "int"],
      ],
    });
    expect(inferredIds(customers, orders)).toEqual(["orders(customer_id)->customers(id)"]);
  });

  it("givenIrregularPlural_whenInferred_thenNoKey", () => {
    const people = table("people", { columns: [["id", "int"]] });
    const notes = table("notes", {
      columns: [
        ["id", "int"],
        ["person_id", "int"],
      ],
    });
    expect(inferredIds(people, notes)).toEqual([]);
  });

  it("givenDeclaredKey_whenInferred_thenNoDuplicate", () => {
    const orders = table("orders", {
      columns: [
        ["id", "bigint"],
        ["customer_id", "bigint"],
      ],
      foreignKeys: [
        {
          name: "orders_customer_fk",
          columns: ["customer_id"],
          target: { path: ["main"], relation: "customers", columns: ["id"] },
          onDelete: "NO ACTION",
          onUpdate: "NO ACTION",
        },
      ],
    });
    expect(inferredIds(CUSTOMERS, orders)).toEqual([]);
  });

  it("givenViewColumn_whenInferred_thenNoKey", () => {
    const totals = table("customer_totals", {
      columns: [["customer_id", "bigint"]],
      primaryKey: null,
      kind: "view",
    });
    const archived = table("archives", { columns: [["id", "bigint"]], kind: "materializedView" });
    const notes = table("notes", {
      columns: [
        ["id", "bigint"],
        ["archive_id", "bigint"],
      ],
    });
    expect(inferredIds(CUSTOMERS, totals, archived, notes)).toEqual([]);
  });

  it("givenBareId_whenInferred_thenNoKey", () => {
    const orders = table("orders", { columns: [["id", "bigint"]] });
    expect(inferredIds(CUSTOMERS, orders)).toEqual([]);
  });

  it("givenOwnKeyEqualToAnotherTablesKey_whenInferred_thenNoKeyEitherWay", () => {
    const customers = table("Customers", { columns: [["CustomerID", "int"]], primaryKey: ["CustomerID"] });
    const profiles = table("Profiles", { columns: [["CustomerID", "int"]], primaryKey: ["CustomerID"] });
    expect(inferredIds(customers, profiles)).toEqual([]);
  });

  it("givenSameCatalog_whenInferredTwice_thenSameIdsInSameOrder", () => {
    const relations = [
      table("orders", {
        columns: [
          ["id", "int"],
          ["customer_id", "int"],
          ["address_id", "int"],
        ],
      }),
      table("addresses", { columns: [["id", "int"]] }),
      table("customers", { columns: [["id", "int"]] }),
    ];
    const first = inferredIds(...relations);
    expect(first).toEqual(["orders(address_id)->addresses(id)", "orders(customer_id)->customers(id)"]);
    expect(inferredIds(...[...relations].reverse())).toEqual(first);
  });
});
