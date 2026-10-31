import { mysqlIntrospector } from "@table-craft/plugin-mysql/introspect";
import { isPluginError } from "@table-craft/plugin-api";
import { describe, expect, it } from "vitest";

type Answer = readonly Record<string, unknown>[] | Error;
type Connection = Parameters<typeof mysqlIntrospector>[0];

const DATABASE = "shop";
const SHOW_DATABASES = /^SHOW DATABASES(?: LIKE \?)?$/;
const CURRENT_DATABASE = /^SELECT DATABASE\(\)/;
/** The header `SHOW DATABASES LIKE` names its one column with. */
const LIKE_HEADER = (pattern: string): string => `Database (${pattern})`;

interface Server {
  /** What `SHOW DATABASES` lists, which on TiDB differs from `information_schema.SCHEMATA`. */
  readonly databases?: readonly string[];
  readonly current?: string | null;
  readonly answers?: Readonly<Record<string, Answer>>;
}

/** The `LIKE` patterns the introspector sent, in order. */
type Patterns = string[];

/**
 * Answers `SHOW DATABASES` from `databases`, `LIKE` matching one name exactly once its escapes are
 * read, and each `information_schema` query by the table it reads; anything unlisted returns no rows.
 */
function connectionAnswering(server: Server, patterns: Patterns = []): Connection {
  const { databases = [DATABASE], current = DATABASE, answers = {} } = server;
  const query = (sql: string, values: unknown, done: (error: Error | null, rows?: unknown) => void): void => {
    const statement = sql.trim();
    if (SHOW_DATABASES.test(statement)) {
      const [pattern] = Array.isArray(values) ? (values as string[]) : [];
      if (pattern === undefined) {
        done(
          null,
          databases.map((name) => ({ Database: name })),
        );
        return;
      }
      patterns.push(pattern);
      const name = pattern.replace(/\\(.)/g, "$1");
      done(
        null,
        databases.filter((found) => found === name).map((found) => ({ [LIKE_HEADER(pattern)]: found })),
      );
      return;
    }
    if (CURRENT_DATABASE.test(statement)) {
      done(null, [{ current }]);
      return;
    }
    const table = /FROM information_schema\.(\w+)/.exec(sql)?.[1] ?? "";
    const answer = answers[table] ?? [];
    if (answer instanceof Error) done(answer);
    else done(null, answer);
  };
  return { query } as unknown as Connection;
}

const TABLES = [{ name: "orders", kind: "BASE TABLE", comment: "" }];
const COLUMNS = [{ relation: "orders", name: "id", type: "int", nullable: "NO", dflt: null, comment: "", extra: "" }];
const BROKEN_PROC = new Error("Column count of mysql.proc is wrong. Expected 21, found 20.");

describe("mysql introspection", () => {
  it("givenUnreadableRoutines_whenDescribe_thenRelationsWithoutRoutines", async () => {
    const catalog = await mysqlIntrospector(
      connectionAnswering({
        answers: {
          TABLES,
          COLUMNS,
          ROUTINES: BROKEN_PROC,
          PARAMETERS: BROKEN_PROC,
        },
      }),
    ).describe([DATABASE]);

    expect(catalog.relations.map((relation) => relation.name)).toEqual(["orders"]);
    expect(catalog.routines).toEqual([]);
  });

  it("givenStatisticsWithoutExpression_whenDescribe_thenIndexColumnsFromColumnName", async () => {
    const catalog = await mysqlIntrospector(
      connectionAnswering({
        answers: {
          TABLES,
          COLUMNS,
          STATISTICS: [{ relation: "orders", name: "PRIMARY", non_unique: 0, COLUMN_NAME: "id" }],
        },
      }),
    ).describe([DATABASE]);

    expect(catalog.relations[0]?.indexes).toEqual([{ name: "PRIMARY", columns: ["id"], unique: true, primary: true }]);
  });

  it("givenFunctionalIndexPart_whenDescribe_thenExpressionStandsForColumn", async () => {
    const catalog = await mysqlIntrospector(
      connectionAnswering({
        answers: {
          TABLES,
          COLUMNS,
          STATISTICS: [
            { relation: "orders", name: "by_lower", non_unique: 1, COLUMN_NAME: null, EXPRESSION: "lower(`id`)" },
          ],
        },
      }),
    ).describe([DATABASE]);

    expect(catalog.relations[0]?.indexes).toEqual([
      { name: "by_lower", columns: ["lower(`id`)"], unique: false, primary: false },
    ]);
  });

  /** TiDB leaves a database reached only through table grants out of `SCHEMATA`, not out of `SHOW DATABASES`. */
  const TIDB_TABLE_GRANTS: Server = {
    databases: ["INFORMATION_SCHEMA", "zas"],
    current: "zas",
    answers: { SCHEMATA: [{ name: "INFORMATION_SCHEMA", current: "zas" }], TABLES, COLUMNS },
  };

  it("givenDatabaseOnlyInShowDatabases_whenNamespaces_thenListed", async () => {
    const namespaces = await mysqlIntrospector(connectionAnswering(TIDB_TABLE_GRANTS)).namespaces();

    expect(namespaces).toEqual([
      { path: ["INFORMATION_SCHEMA"], name: "INFORMATION_SCHEMA", kind: "schema", system: true, current: false },
      { path: ["zas"], name: "zas", kind: "schema", system: false, current: true },
    ]);
  });

  it("givenNoCurrentDatabase_whenNamespaces_thenNoneCurrent", async () => {
    const namespaces = await mysqlIntrospector(
      connectionAnswering({ databases: ["a", "b"], current: null }),
    ).namespaces();

    expect(namespaces.map((namespace) => [namespace.name, namespace.current])).toEqual([
      ["a", false],
      ["b", false],
    ]);
  });

  it("givenMetricsSchema_whenNamespaces_thenSystem", async () => {
    const namespaces = await mysqlIntrospector(
      connectionAnswering({ databases: ["METRICS_SCHEMA", "mysql", "PERFORMANCE_SCHEMA", "shop"] }),
    ).namespaces();

    expect(namespaces.map((namespace) => [namespace.name, namespace.system])).toEqual([
      ["METRICS_SCHEMA", true],
      ["mysql", true],
      ["PERFORMANCE_SCHEMA", true],
      ["shop", false],
    ]);
  });

  it("givenDatabaseOnlyInShowDatabases_whenDescribe_thenRelations", async () => {
    const catalog = await mysqlIntrospector(connectionAnswering(TIDB_TABLE_GRANTS)).describe(["zas"]);

    expect(catalog.relations.map((relation) => relation.name)).toEqual(["orders"]);
  });

  it("givenNameWithLikeWildcards_whenDescribe_thenPatternEscaped", async () => {
    const patterns: Patterns = [];
    const name = "a_b%c\\d";
    await mysqlIntrospector(connectionAnswering({ databases: [name], answers: { TABLES } }, patterns)).describe([name]);

    expect(patterns).toEqual(["a\\_b\\%c\\\\d"]);
  });

  it("givenNoMatchingDatabase_whenDescribe_thenIntrospectionFailed", async () => {
    const failure: unknown = await mysqlIntrospector(connectionAnswering({ databases: ["a_b"] }))
      .describe(["aXb"])
      .catch((error: unknown) => error);

    expect(isPluginError(failure) && failure.code).toBe("introspectionFailed");
    expect(failure).toHaveProperty("message", 'Database "aXb" does not exist, or this user has no privileges on it.');
  });
});
