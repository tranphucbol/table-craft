import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DUCKDB_DATABASE, seededDuckdbFiles } from "../support/duckdbFixture.js";
import { openDuckdb, rowsOf, type DuckdbSession } from "../support/duckdbSession.js";

const ATTACHED = "other";

describe("DuckDB catalog", () => {
  let session: DuckdbSession;

  beforeAll(async () => {
    const files = await seededDuckdbFiles();
    session = await openDuckdb(files.database);
    await rowsOf(session, `ATTACH '${join(files.directory, "other.duckdb")}' AS ${ATTACHED}`);
    await rowsOf(session, `CREATE TABLE ${ATTACHED}.main.shipments (id INTEGER PRIMARY KEY, carrier VARCHAR)`);
  });

  afterAll(async () => {
    await session.close();
  });

  it("givenAttachedDatabase_whenNamespaces_thenDatabaseAndSchemasListed", async () => {
    const namespaces = await session.services.schemaTree.namespaces();
    const paths = namespaces.filter((namespace) => !namespace.system).map((namespace) => namespace.path.join("."));

    expect(paths).toEqual(
      expect.arrayContaining([
        DUCKDB_DATABASE,
        `${DUCKDB_DATABASE}.main`,
        `${DUCKDB_DATABASE}.archive`,
        ATTACHED,
        `${ATTACHED}.main`,
      ]),
    );
    expect(namespaces.filter((namespace) => namespace.current).map((namespace) => namespace.path)).toEqual([
      [DUCKDB_DATABASE, "main"],
    ]);
  });

  it("givenSameSchemaInTwoDatabases_whenDescribe_thenOnlyThatDatabasesTables", async () => {
    const attached = await session.services.schemaTree.describe([ATTACHED, "main"]);
    const fixture = await session.services.schemaTree.describe([DUCKDB_DATABASE, "main"]);

    expect(attached.relations.map((relation) => relation.name)).toEqual(["shipments"]);
    expect(fixture.relations.map((relation) => relation.name)).not.toContain("shipments");
  });

  it("givenSystemCatalogs_whenNamespaces_thenMarkedSystem", async () => {
    const namespaces = await session.services.schemaTree.namespaces();
    const system = namespaces.filter((namespace) => namespace.system).map((namespace) => namespace.path.join("."));

    expect(system).toEqual(
      expect.arrayContaining(["system", "system.information_schema", "system.pg_catalog", "temp"]),
    );
  });

  it("givenAttachedTable_whenQualifiedName_thenThreePart", () => {
    const tree = session.services.schemaTree;

    expect(tree.qualifiedName([ATTACHED, "main"], "shipments")).toBe('"other"."main"."shipments"');
    expect(tree.qualifiedName([DUCKDB_DATABASE, "main"], "orders")).toBe('"main"."orders"');
  });

  it("givenTableWithIndex_whenDefinition_thenCreateTableThenCreateIndex", async () => {
    const definition = await session.services.ddl.definition([DUCKDB_DATABASE, "main"], "orders");

    expect(definition).toMatch(
      /^CREATE TABLE orders\(.*\);\n\nCREATE INDEX orders_placed_at_idx ON orders\(placed_at\);$/su,
    );
  });
});
