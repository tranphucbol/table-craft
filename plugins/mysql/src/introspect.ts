import type mysql from "mysql2";
import {
  byName,
  DefinitionNotFoundError,
  PluginError,
  type ColumnMeta,
  type ForeignKey,
  type Index,
  type Introspector,
  type Key,
  type Namespace,
  type NamespaceCatalog,
  type Relation,
  type Routine,
  type RoutineParameter,
  type RoutineParameterMode,
} from "@table-craft/plugin-api";

/** `metrics_schema` is TiDB's own, listed to users holding PROCESS. */
const SYSTEM_DATABASES: ReadonlySet<string> = new Set([
  "information_schema",
  "metrics_schema",
  "mysql",
  "performance_schema",
  "sys",
]);

const VIEW_TYPES: ReadonlySet<string> = new Set(["VIEW", "SYSTEM VIEW"]);
const AUTO_INCREMENT = /\bauto_increment\b/i;
const PRIMARY_INDEX = "PRIMARY";
const PRIMARY_KEY = "PRIMARY KEY";
const UNIQUE_KEY = "UNIQUE";
const FOREIGN_KEY = "FOREIGN KEY";
const PROCEDURE = "PROCEDURE";
const PARAMETER_MODES: ReadonlyMap<string, RoutineParameterMode> = new Map([
  ["IN", "in"],
  ["OUT", "out"],
  ["INOUT", "inout"],
]);
/** A function's parameters have no mode in `information_schema.PARAMETERS`; they are all IN. */
const FUNCTION_PARAMETER_MODE: RoutineParameterMode = "in";
const DEFAULT_ACTION = "NO ACTION";
/** The result columns `SHOW CREATE TABLE` and `SHOW CREATE VIEW` put the statement in. */
const CREATE_TABLE_COLUMN = "Create Table";
const CREATE_VIEW_COLUMN = "Create View";

/**
 * Not `information_schema.SCHEMATA`: TiDB keeps a database there only for users with a global or
 * database privilege on it, while `SHOW DATABASES` also lists those reached through table or
 * column grants, as MySQL and MariaDB list both. The server sorts it by name.
 */
const DATABASES_SQL = "SHOW DATABASES";
const DATABASE_SQL = "SHOW DATABASES LIKE ?";
const CURRENT_DATABASE_SQL = "SELECT DATABASE() AS current";
const LIKE_WILDCARDS = /[\\%_]/g;

const RELATIONS_SQL = `
  SELECT TABLE_NAME AS name, TABLE_TYPE AS kind, TABLE_COMMENT AS comment
  FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = ?`;

const COLUMNS_SQL = `
  SELECT TABLE_NAME AS relation, COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable,
    COLUMN_DEFAULT AS dflt, COLUMN_COMMENT AS comment, EXTRA AS extra
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = ?
  ORDER BY TABLE_NAME, ORDINAL_POSITION`;

const CONSTRAINTS_SQL = `
  SELECT tc.TABLE_NAME AS relation, tc.CONSTRAINT_NAME AS name, tc.CONSTRAINT_TYPE AS type,
    k.COLUMN_NAME AS col, k.REFERENCED_TABLE_SCHEMA AS target_schema,
    k.REFERENCED_TABLE_NAME AS target_relation, k.REFERENCED_COLUMN_NAME AS target_col,
    rc.DELETE_RULE AS on_delete, rc.UPDATE_RULE AS on_update
  FROM information_schema.TABLE_CONSTRAINTS tc
  JOIN information_schema.KEY_COLUMN_USAGE k
    ON k.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND k.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
    AND k.TABLE_NAME = tc.TABLE_NAME
  LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
    ON rc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND rc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
    AND rc.TABLE_NAME = tc.TABLE_NAME
  WHERE tc.TABLE_SCHEMA = ? AND tc.CONSTRAINT_TYPE IN ('${PRIMARY_KEY}', '${UNIQUE_KEY}', '${FOREIGN_KEY}')
  ORDER BY tc.TABLE_NAME, tc.CONSTRAINT_NAME, k.ORDINAL_POSITION`;

/**
 * A functional index part has no column; `EXPRESSION` carries it instead. Only MySQL 8.0.13+ has
 * that column (MariaDB and older MySQL fail on the name), so `s.*` picks it up where it exists.
 */
const INDEXES_SQL = `
  SELECT TABLE_NAME AS relation, INDEX_NAME AS name, NON_UNIQUE AS non_unique, s.*
  FROM information_schema.STATISTICS s
  WHERE TABLE_SCHEMA = ?
  ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`;

const ROUTINES_SQL = `
  SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS kind, DTD_IDENTIFIER AS returns
  FROM information_schema.ROUTINES
  WHERE ROUTINE_SCHEMA = ?`;

/** Position 0 is a function's result, which `ROUTINES.DTD_IDENTIFIER` already carries. */
const PARAMETERS_SQL = `
  SELECT SPECIFIC_NAME AS routine, ROUTINE_TYPE AS kind, PARAMETER_MODE AS mode,
    PARAMETER_NAME AS name, DTD_IDENTIFIER AS type
  FROM information_schema.PARAMETERS
  WHERE SPECIFIC_SCHEMA = ? AND ORDINAL_POSITION > 0
  ORDER BY SPECIFIC_NAME, ROUTINE_TYPE, ORDINAL_POSITION`;

const RELATION_TYPE_SQL =
  "SELECT TABLE_TYPE AS kind FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?";

/** information_schema hands some columns over in a binary collation, which mysql2 reads as bytes. */
type Text = string | Buffer | null;

/** A `SHOW DATABASES` row, whose one column is `Database`, or `Database (<pattern>)` after `LIKE`. */
type DatabaseRow = Readonly<Record<string, Text>>;

interface CurrentDatabaseRow {
  readonly current: Text;
}

function databaseName(row: DatabaseRow): string {
  return text(Object.values(row)[0] ?? null);
}

function likePattern(name: string): string {
  return name.replace(LIKE_WILDCARDS, (wildcard) => `\\${wildcard}`);
}

interface RelationRow {
  readonly name: Text;
  readonly kind: Text;
  readonly comment: Text;
}

interface ColumnRow {
  readonly relation: Text;
  readonly name: Text;
  readonly type: Text;
  readonly nullable: Text;
  readonly dflt: Text;
  readonly comment: Text;
  readonly extra: Text;
}

interface ConstraintRow {
  readonly relation: Text;
  readonly name: Text;
  readonly type: Text;
  readonly col: Text;
  readonly target_schema: Text;
  readonly target_relation: Text;
  readonly target_col: Text;
  readonly on_delete: Text;
  readonly on_update: Text;
}

interface IndexRow {
  readonly relation: Text;
  readonly name: Text;
  readonly non_unique: number | string;
  readonly COLUMN_NAME: Text;
  readonly EXPRESSION?: Text;
}

function indexPart(row: IndexRow): string {
  return text(row.COLUMN_NAME ?? row.EXPRESSION ?? null);
}

interface RoutineRow {
  readonly name: Text;
  readonly kind: Text;
  readonly returns: Text;
}

interface ParameterRow {
  readonly routine: Text;
  readonly kind: Text;
  readonly mode: Text;
  readonly name: Text;
  readonly type: Text;
}

/** A function and a procedure may share a name, so a routine is its name and its type. */
function toRoutines(routines: readonly RoutineRow[], parameters: readonly ParameterRow[]): Routine[] {
  const parametersOf = new Map<string, RoutineParameter[]>();
  for (const row of parameters) {
    const key = `${text(row.kind)} ${text(row.routine)}`;
    const mode = PARAMETER_MODES.get(text(row.mode)) ?? FUNCTION_PARAMETER_MODE;
    const parameter: RoutineParameter = { name: optional(row.name), type: text(row.type), mode, hasDefault: false };
    parametersOf.set(key, [...(parametersOf.get(key) ?? []), parameter]);
  }
  return routines.map((row): Routine => {
    const kind = text(row.kind) === PROCEDURE ? "procedure" : "function";
    const routineParameters = parametersOf.get(`${text(row.kind)} ${text(row.name)}`) ?? [];
    return {
      name: text(row.name),
      kind,
      signature: routineParameters.map(signatureOf).join(", "),
      parameters: routineParameters,
      returns: kind === "procedure" ? null : optional(row.returns),
    };
  });
}

/** Printed as PostgreSQL prints identity arguments: the mode only when it is not IN. */
function signatureOf(parameter: RoutineParameter): string {
  const declared = `${parameter.name ?? ""} ${parameter.type}`.trim();
  return parameter.mode === FUNCTION_PARAMETER_MODE ? declared : `${parameter.mode.toUpperCase()} ${declared}`;
}

function text(value: Text): string {
  if (value === null) return "";
  return typeof value === "string" ? value : value.toString("utf8");
}

function optional(value: Text): string | null {
  const read = text(value);
  return read === "" ? null : read;
}

function quote(identifier: string): string {
  return `\`${identifier.replaceAll("`", "``")}\``;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Rows of one relation's multi-row objects (a key's columns, an index's parts), in query order. */
function grouped<T extends { readonly relation: Text; readonly name: Text }>(
  rows: readonly T[],
): Map<string, Map<string, T[]>> {
  const relations = new Map<string, Map<string, T[]>>();
  for (const row of rows) {
    const relation = text(row.relation);
    const objects = relations.get(relation) ?? new Map<string, T[]>();
    relations.set(relation, objects);
    const name = text(row.name);
    const parts = objects.get(name);
    if (parts === undefined) objects.set(name, [row]);
    else parts.push(row);
  }
  return relations;
}

function toColumn(row: ColumnRow, index: number): ColumnMeta {
  return {
    name: text(row.name),
    position: index + 1,
    type: text(row.type),
    nullable: text(row.nullable) === "YES",
    default: row.dflt === null ? null : text(row.dflt),
    comment: optional(row.comment),
    autoIncrement: AUTO_INCREMENT.test(text(row.extra)),
  };
}

/** Every query filters `information_schema` by `TABLE_SCHEMA = ?`, which MySQL answers without opening each table. */
export function mysqlIntrospector(connection: mysql.Connection): Introspector {
  function rows<T>(sql: string, values: string[] = []): Promise<T[]> {
    return new Promise((resolve, reject) => {
      connection.query(sql, values, (error, found) => {
        if (error === null) resolve(found as T[]);
        else reject(new PluginError("introspectionFailed", messageOf(error), { cause: error }));
      });
    });
  }

  /**
   * Routines read from `mysql.proc`, which a server upgraded without `mariadb-upgrade` cannot read
   * ("Column count of mysql.proc is wrong"); the tables still deserve a catalog then.
   */
  async function routineRows(database: string): Promise<[RoutineRow[], ParameterRow[]]> {
    try {
      return await Promise.all([
        rows<RoutineRow>(ROUTINES_SQL, [database]),
        rows<ParameterRow>(PARAMETERS_SQL, [database]),
      ]);
    } catch {
      return [[], []];
    }
  }

  return {
    async namespaces(): Promise<readonly Namespace[]> {
      const [found, [currentRow]] = await Promise.all([
        rows<DatabaseRow>(DATABASES_SQL),
        rows<CurrentDatabaseRow>(CURRENT_DATABASE_SQL),
      ]);
      const current = text(currentRow?.current ?? null);
      return found.map((row): Namespace => {
        const name = databaseName(row);
        return {
          path: [name],
          name,
          kind: "schema",
          system: SYSTEM_DATABASES.has(name.toLowerCase()),
          current: name === current,
        };
      });
    },

    async describe(path: readonly string[]): Promise<NamespaceCatalog> {
      const [database] = path;
      if (path.length !== 1 || database === undefined) {
        throw new PluginError("introspectionFailed", `"${path.join(".")}" is not a MySQL database.`);
      }
      if ((await rows<DatabaseRow>(DATABASE_SQL, [likePattern(database)])).length === 0) {
        throw new PluginError(
          "introspectionFailed",
          `Database "${database}" does not exist, or this user has no privileges on it.`,
        );
      }
      const [relations, columns, constraints, indexes, [routines, parameters]] = await Promise.all([
        rows<RelationRow>(RELATIONS_SQL, [database]),
        rows<ColumnRow>(COLUMNS_SQL, [database]),
        rows<ConstraintRow>(CONSTRAINTS_SQL, [database]),
        rows<IndexRow>(INDEXES_SQL, [database]),
        routineRows(database),
      ]);
      const columnsOf = new Map<string, ColumnRow[]>();
      for (const column of columns) {
        const relation = text(column.relation);
        columnsOf.set(relation, [...(columnsOf.get(relation) ?? []), column]);
      }
      const constraintsOf = grouped(constraints);
      const indexesOf = grouped(indexes);
      const described = relations.map((row): Relation => {
        const name = text(row.name);
        const kind = text(row.kind);
        const view = VIEW_TYPES.has(kind);
        const keys = [...(constraintsOf.get(name) ?? new Map<string, ConstraintRow[]>()).entries()];
        const ofType = (type: string): [string, ConstraintRow[]][] =>
          keys.filter(([, parts]) => text(parts[0]?.type ?? null) === type);
        const key = ([keyName, parts]: [string, ConstraintRow[]]): Key => ({
          name: keyName,
          columns: parts.map((part) => text(part.col)),
        });
        const primary = ofType(PRIMARY_KEY)[0];
        return {
          name,
          kind: view ? "view" : "table",
          // A view's TABLE_COMMENT is the word VIEW, not a comment anyone wrote.
          comment: view ? null : optional(row.comment),
          columns: (columnsOf.get(name) ?? []).map(toColumn),
          primaryKey: primary === undefined ? null : key(primary),
          uniqueKeys: byName(ofType(UNIQUE_KEY).map(key)),
          foreignKeys: byName(
            ofType(FOREIGN_KEY).map(([keyName, parts]): ForeignKey => {
              const first = parts[0];
              return {
                name: keyName,
                columns: parts.map((part) => text(part.col)),
                target: {
                  path: [text(first?.target_schema ?? null)],
                  relation: text(first?.target_relation ?? null),
                  columns: parts.map((part) => text(part.target_col)),
                },
                onDelete: optional(first?.on_delete ?? null) ?? DEFAULT_ACTION,
                onUpdate: optional(first?.on_update ?? null) ?? DEFAULT_ACTION,
              };
            }),
          ),
          indexes: byName(
            [...(indexesOf.get(name) ?? new Map<string, IndexRow[]>()).entries()].map(([indexName, parts]): Index => ({
              name: indexName,
              columns: parts.map(indexPart),
              unique: Number(parts[0]?.non_unique) === 0,
              primary: indexName === PRIMARY_INDEX,
            })),
          ),
        };
      });
      return {
        path: [database],
        relations: byName(described),
        routines: byName(toRoutines(routines, parameters)),
        sequences: [],
      };
    },

    /** `SHOW CREATE TABLE` or `SHOW CREATE VIEW` verbatim (decision 029), definer and counters included. */
    async definition(path: readonly string[], name: string): Promise<string> {
      const [database] = path;
      const found =
        path.length === 1 && database !== undefined
          ? (await rows<{ kind: Text }>(RELATION_TYPE_SQL, [database, name]))[0]
          : undefined;
      if (found === undefined || database === undefined) throw new DefinitionNotFoundError(path, name);
      const view = VIEW_TYPES.has(text(found.kind));
      const qualified = [database, name].map(quote).join(".");
      const shown = await rows<Record<string, Text>>(`SHOW CREATE ${view ? "VIEW" : "TABLE"} ${qualified}`);
      const statement = text(shown[0]?.[view ? CREATE_VIEW_COLUMN : CREATE_TABLE_COLUMN] ?? null);
      if (statement === "") throw new DefinitionNotFoundError(path, name);
      return `${statement};`;
    },

    qualifiedName(path: readonly string[], name: string): string {
      return [...path, name].map(quote).join(".");
    },
  };
}
