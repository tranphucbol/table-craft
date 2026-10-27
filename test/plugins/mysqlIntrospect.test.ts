import { mysqlIntrospector } from "@table-craft/plugin-mysql/introspect";
import { describe, expect, it } from "vitest";

type Answer = readonly Record<string, unknown>[] | Error;
type Connection = Parameters<typeof mysqlIntrospector>[0];

const DATABASE = "shop";

/** Answers each `information_schema` query by the table it reads; anything unlisted returns no rows. */
function connectionAnswering(answers: Readonly<Record<string, Answer>>): Connection {
  const query = (sql: string, _values: unknown, done: (error: Error | null, rows?: unknown) => void): void => {
    const table = /FROM information_schema\.(\w+)/.exec(sql)?.[1] ?? "";
    const answer = answers[table] ?? [];
    if (answer instanceof Error) done(answer);
    else done(null, answer);
  };
  return { query } as unknown as Connection;
}

const SCHEMATA = [{ name: DATABASE }];
const TABLES = [{ name: "orders", kind: "BASE TABLE", comment: "" }];
const COLUMNS = [{ relation: "orders", name: "id", type: "int", nullable: "NO", dflt: null, comment: "", extra: "" }];
const BROKEN_PROC = new Error("Column count of mysql.proc is wrong. Expected 21, found 20.");

describe("mysql introspection", () => {
  it("givenUnreadableRoutines_whenDescribe_thenRelationsWithoutRoutines", async () => {
    const catalog = await mysqlIntrospector(
      connectionAnswering({
        SCHEMATA,
        TABLES,
        COLUMNS,
        ROUTINES: BROKEN_PROC,
        PARAMETERS: BROKEN_PROC,
      }),
    ).describe([DATABASE]);

    expect(catalog.relations.map((relation) => relation.name)).toEqual(["orders"]);
    expect(catalog.routines).toEqual([]);
  });

  it("givenStatisticsWithoutExpression_whenDescribe_thenIndexColumnsFromColumnName", async () => {
    const catalog = await mysqlIntrospector(
      connectionAnswering({
        SCHEMATA,
        TABLES,
        COLUMNS,
        STATISTICS: [{ relation: "orders", name: "PRIMARY", non_unique: 0, COLUMN_NAME: "id" }],
      }),
    ).describe([DATABASE]);

    expect(catalog.relations[0]?.indexes).toEqual([{ name: "PRIMARY", columns: ["id"], unique: true, primary: true }]);
  });

  it("givenFunctionalIndexPart_whenDescribe_thenExpressionStandsForColumn", async () => {
    const catalog = await mysqlIntrospector(
      connectionAnswering({
        SCHEMATA,
        TABLES,
        COLUMNS,
        STATISTICS: [
          { relation: "orders", name: "by_lower", non_unique: 1, COLUMN_NAME: null, EXPRESSION: "lower(`id`)" },
        ],
      }),
    ).describe([DATABASE]);

    expect(catalog.relations[0]?.indexes).toEqual([
      { name: "by_lower", columns: ["lower(`id`)"], unique: false, primary: false },
    ]);
  });
});
