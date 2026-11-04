import {
  byName,
  DefinitionNotFoundError,
  PluginError,
  type ColumnMeta,
  type DefinitionReader,
  type ForeignKey,
  type Index,
  type Introspector,
  type Key,
  type Namespace,
  type NamespaceCatalog,
  type Relation,
} from "@table-craft/plugin-api";

/** One catalog row, as `getRowObjectsJson` reads it: lists are arrays, wide integers strings. */
export type CatalogRow = Readonly<Record<string, unknown>>;

/** Runs one catalog query with `$1`, `$2` … bound to `params`. */
export type CatalogQuery = (sql: string, params?: readonly string[]) => Promise<readonly CatalogRow[]>;

const SYSTEM_SCHEMAS: ReadonlySet<string> = new Set(["information_schema", "pg_catalog"]);
const AUTO_INCREMENT_DEFAULT = /^nextval\(/iu;
const NO_ACTION = "NO ACTION";

/**
 * Every query reads DuckDB's own `duckdb_*()` functions filtered on the database name, never
 * `information_schema`: an attached database may hold a schema of the same name, and
 * `information_schema` merges them.
 */
const NAMESPACES_SQL = `SELECT
  (SELECT current_database()) AS current_database,
  (SELECT current_schema()) AS current_schema,
  d.database_name, d.internal, s.schema_name
FROM duckdb_databases() d
LEFT JOIN duckdb_schemas() s ON s.database_name = d.database_name
ORDER BY d.database_name, s.schema_name`;

const SCHEMA_SQL = "SELECT 1 AS found FROM duckdb_schemas() WHERE database_name = $1 AND schema_name = $2";

const RELATIONS_SQL = `SELECT table_name AS name, 'table' AS kind, comment FROM duckdb_tables()
  WHERE database_name = $1 AND schema_name = $2
UNION ALL
SELECT view_name, 'view', comment FROM duckdb_views()
  WHERE database_name = $1 AND schema_name = $2 AND NOT internal`;

const COLUMNS_SQL = `SELECT table_name, column_name, column_index, data_type, is_nullable, column_default, comment
FROM duckdb_columns() WHERE database_name = $1 AND schema_name = $2
ORDER BY table_name, column_index`;

const CONSTRAINTS_SQL = `SELECT table_name, constraint_type, constraint_name, constraint_column_names,
  referenced_table, referenced_column_names
FROM duckdb_constraints()
WHERE database_name = $1 AND schema_name = $2 AND constraint_type IN ('PRIMARY KEY', 'UNIQUE', 'FOREIGN KEY')
ORDER BY table_name, constraint_index`;

const INDEXES_SQL = `SELECT table_name, index_name, is_unique, is_primary, expressions, sql
FROM duckdb_indexes() WHERE database_name = $1 AND schema_name = $2`;

const SEQUENCES_SQL =
  "SELECT sequence_name AS name FROM duckdb_sequences() WHERE database_name = $1 AND schema_name = $2";

const TABLE_SQL = `SELECT sql, comment FROM duckdb_tables()
  WHERE database_name = $1 AND schema_name = $2 AND table_name = $3`;
const VIEW_SQL = `SELECT sql, comment FROM duckdb_views()
  WHERE database_name = $1 AND schema_name = $2 AND view_name = $3 AND NOT internal`;
const TABLE_INDEXES_SQL = `SELECT sql FROM duckdb_indexes()
  WHERE database_name = $1 AND schema_name = $2 AND table_name = $3 AND sql IS NOT NULL ORDER BY index_name`;
const COLUMN_COMMENTS_SQL = `SELECT column_name, comment FROM duckdb_columns()
  WHERE database_name = $1 AND schema_name = $2 AND table_name = $3 AND comment IS NOT NULL ORDER BY column_index`;

export interface IntrospectorOptions {
  readonly quoteIdentifier: (name: string) => string;
  /** A string literal in the dialect, for comments. */
  readonly literal: (text: string) => string;
  /** The database the connection opened, whose names need no database part. */
  readonly openedDatabase: string;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}

function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

function texts(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text) : [];
}

const LIST_ITEM_QUOTES = /^'(.*)'$/su;
const IDENTIFIER_QUOTES = /^"(.*)"$/su;

/** `duckdb_indexes().expressions` is DuckDB's text of a list, such as `['"label"', n]`. */
export function indexColumns(expressions: string): string[] {
  const inner = expressions.trim().replace(/^\[/u, "").replace(/\]$/u, "");
  if (inner === "") return [];
  return inner.split(", ").map((item) => {
    const unlisted = LIST_ITEM_QUOTES.exec(item)?.[1]?.replaceAll("''", "'") ?? item;
    return IDENTIFIER_QUOTES.exec(unlisted)?.[1]?.replaceAll('""', '"') ?? unlisted;
  });
}

function groupBy(rows: readonly CatalogRow[]): Map<string, CatalogRow[]> {
  const groups = new Map<string, CatalogRow[]>();
  for (const row of rows) {
    const table = text(row.table_name);
    const group = groups.get(table);
    if (group === undefined) groups.set(table, [row]);
    else group.push(row);
  }
  return groups;
}

/**
 * The `schemaTree` and `ddl` services over `query`, which runs on a connection of its own so that
 * a result the console is still reading does not block the explorer. A namespace is a database or
 * a database and a schema.
 */
export function duckdbIntrospector(
  query: CatalogQuery,
  { quoteIdentifier, literal, openedDatabase }: IntrospectorOptions,
): Introspector & DefinitionReader {
  async function rows(sql: string, params: readonly string[] = []): Promise<readonly CatalogRow[]> {
    try {
      return await query(sql, params);
    } catch (cause) {
      if (cause instanceof PluginError) throw cause;
      throw new PluginError("introspectionFailed", cause instanceof Error ? cause.message : String(cause), { cause });
    }
  }

  function schemaPath(path: readonly string[]): [string, string] {
    const [database, schema] = path;
    if (path.length !== 2 || database === undefined || schema === undefined) {
      throw new PluginError(
        "introspectionFailed",
        `A DuckDB namespace is a database and a schema, not "${path.join(".")}".`,
      );
    }
    return [database, schema];
  }

  function qualifiedName(path: readonly string[], name: string): string {
    const parts = path[0] === openedDatabase ? path.slice(1) : path;
    return [...parts, name].map(quoteIdentifier).join(".");
  }

  async function describe(path: readonly string[]): Promise<NamespaceCatalog> {
    const [database, schema] = schemaPath(path);
    const params = [database, schema];
    if ((await rows(SCHEMA_SQL, params)).length === 0) {
      throw new PluginError("introspectionFailed", `Schema "${schema}" does not exist in database "${database}".`);
    }
    const [relationRows, columnRows, constraintRows, indexRows, sequenceRows] = await Promise.all([
      rows(RELATIONS_SQL, params),
      rows(COLUMNS_SQL, params),
      rows(CONSTRAINTS_SQL, params),
      rows(INDEXES_SQL, params),
      rows(SEQUENCES_SQL, params),
    ]);
    const columns = groupBy(columnRows);
    const constraints = groupBy(constraintRows);
    const indexes = groupBy(indexRows);
    const relations = relationRows.map((row): Relation => {
      const name = text(row.name);
      const own = constraints.get(name) ?? [];
      const keyOf = (constraint: CatalogRow): Key => ({
        name: text(constraint.constraint_name),
        columns: texts(constraint.constraint_column_names),
      });
      const primary = own.find((constraint) => constraint.constraint_type === "PRIMARY KEY");
      return {
        name,
        kind: row.kind === "view" ? "view" : "table",
        comment: textOrNull(row.comment),
        columns: (columns.get(name) ?? []).map((column, index): ColumnMeta => ({
          name: text(column.column_name),
          position: index + 1,
          type: text(column.data_type),
          nullable: column.is_nullable === true,
          default: textOrNull(column.column_default),
          comment: textOrNull(column.comment),
          autoIncrement: AUTO_INCREMENT_DEFAULT.test(textOrNull(column.column_default) ?? ""),
        })),
        primaryKey: primary === undefined ? null : keyOf(primary),
        uniqueKeys: byName(own.filter((constraint) => constraint.constraint_type === "UNIQUE").map(keyOf)),
        foreignKeys: byName(
          own
            .filter((constraint) => constraint.constraint_type === "FOREIGN KEY")
            .map((constraint): ForeignKey => ({
              ...keyOf(constraint),
              // DuckDB refuses a foreign key into another schema, so the target shares the path.
              target: {
                path: [database, schema],
                relation: text(constraint.referenced_table),
                columns: texts(constraint.referenced_column_names),
              },
              onDelete: NO_ACTION,
              onUpdate: NO_ACTION,
            })),
        ),
        indexes: byName(
          (indexes.get(name) ?? []).map((index): Index => ({
            name: text(index.index_name),
            columns: indexColumns(text(index.expressions)),
            unique: index.is_unique === true,
            primary: index.is_primary === true,
          })),
        ),
      };
    });
    return {
      path: [database, schema],
      relations: byName(relations),
      routines: [],
      sequences: byName(sequenceRows.map((row) => ({ name: text(row.name) }))),
    };
  }

  async function definition(path: readonly string[], name: string): Promise<string> {
    const [database, schema] = schemaPath(path);
    const params = [database, schema, name];
    const [table] = await rows(TABLE_SQL, params);
    if (table === undefined) {
      const [view] = await rows(VIEW_SQL, params);
      const body = textOrNull(view?.sql)?.trim() ?? "";
      if (body === "") throw new DefinitionNotFoundError(path, name);
      return body.endsWith(";") ? body : `${body};`;
    }
    const qualified = qualifiedName(path, name);
    const statements = [text(table.sql).trim()];
    for (const index of await rows(TABLE_INDEXES_SQL, params)) statements.push(text(index.sql).trim());
    const comment = textOrNull(table.comment);
    if (comment !== null) statements.push(`COMMENT ON TABLE ${qualified} IS ${literal(comment)};`);
    for (const column of await rows(COLUMN_COMMENTS_SQL, params)) {
      statements.push(
        `COMMENT ON COLUMN ${qualified}.${quoteIdentifier(text(column.column_name))} IS ${literal(text(column.comment))};`,
      );
    }
    return statements.map((statement) => (statement.endsWith(";") ? statement : `${statement};`)).join("\n\n");
  }

  return {
    async namespaces(): Promise<readonly Namespace[]> {
      const listed = await rows(NAMESPACES_SQL);
      const namespaces: Namespace[] = [];
      const seen = new Set<string>();
      for (const row of listed) {
        const database = text(row.database_name);
        const system = row.internal === true;
        const current = row.current_database === database;
        if (!seen.has(database)) {
          seen.add(database);
          namespaces.push({ path: [database], name: database, kind: "database", system, current: false });
        }
        const schema = textOrNull(row.schema_name);
        if (schema === null) continue;
        namespaces.push({
          path: [database, schema],
          name: schema,
          kind: "schema",
          system: system || SYSTEM_SCHEMAS.has(schema),
          current: current && row.current_schema === schema,
        });
      }
      return namespaces;
    },
    describe,
    qualifiedName,
    definition,
  };
}
