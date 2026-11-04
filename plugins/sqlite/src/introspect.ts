import type { DatabaseSync } from "node:sqlite";
import {
  byName,
  DefinitionNotFoundError,
  PluginError,
  type ColumnMeta,
  type ForeignKey,
  type Index,
  type DefinitionReader,
  type Introspector,
  type Key,
  type Namespace,
  type NamespaceCatalog,
  type Relation,
} from "@table-craft/plugin-api";

const MAIN_DATABASE = "main";
/** Where `CREATE TEMP TABLE` goes; it belongs to the connection, not the file. */
const TEMP_DATABASE = "temp";
/** Names SQLite reserves for its own tables, such as `sqlite_schema` and `sqlite_sequence`. */
const INTERNAL_PREFIX = "sqlite_";
const RELATION_TYPES: ReadonlyMap<string, Relation["kind"]> = new Map([
  ["table", "table"],
  ["virtual", "table"],
  ["view", "view"],
]);
/** `pragma_table_xinfo.hidden` for a virtual table's hidden column; generated columns are 2 and 3. */
const HIDDEN_VIRTUAL_COLUMN = 1;
/** An `INTEGER PRIMARY KEY` aliases the rowid, which SQLite assigns when the insert omits it. */
const ROWID_ALIAS_TYPE = /^INTEGER$/i;
const UNIQUE_CONSTRAINT_ORIGIN = "u";
const PRIMARY_KEY_ORIGIN = "pk";
/** What `pragma_index_info` names an expression part, which has no column. */
const EXPRESSION_PART = "<expression>";

const DATABASES_SQL = "SELECT name FROM pragma_database_list ORDER BY seq";
const RELATIONS_SQL = "SELECT name, type FROM pragma_table_list WHERE schema = ?";
const COLUMNS_SQL = 'SELECT name, type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(?, ?) ORDER BY cid';
const INDEXES_SQL = 'SELECT name, "unique", origin FROM pragma_index_list(?, ?)';
const INDEX_PARTS_SQL = "SELECT name FROM pragma_index_info(?, ?) ORDER BY seqno";
const FOREIGN_KEYS_SQL =
  'SELECT id, "table", "from", "to", on_update, on_delete FROM pragma_foreign_key_list(?, ?) ORDER BY id, seq';

/** `sqlite_schema` keeps each object's statement as written; an index a constraint made has none. */
const definedRelationSql = (schema: string): string =>
  `SELECT sql FROM ${quote(schema)}.sqlite_master WHERE name = ? AND type IN ('table', 'view') AND sql IS NOT NULL`;
const definedPartsSql = (schema: string): string =>
  `SELECT sql FROM ${quote(schema)}.sqlite_master WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY type, name`;

interface ColumnRow {
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly dflt_value: string | null;
  readonly pk: number;
  readonly hidden: number;
}

interface IndexRow {
  readonly name: string;
  readonly unique: number;
  readonly origin: string;
}

interface ForeignKeyRow {
  readonly id: number;
  readonly table: string;
  readonly from: string;
  readonly to: string | null;
  readonly on_update: string;
  readonly on_delete: string;
}

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/** node:sqlite is synchronous; this turns a throw into a rejection coded as the contract expects. */
// eslint-disable-next-line @typescript-eslint/require-await -- async is what turns the throw into a rejection
async function introspecting<T>(work: () => T): Promise<T> {
  try {
    return work();
  } catch (cause) {
    if (cause instanceof PluginError) throw cause;
    throw new PluginError("introspectionFailed", cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

/** Reads the `pragma_*` table-valued functions, one relation at a time; SQLite answers them from memory. */
export function sqliteIntrospector(database: DatabaseSync): Introspector & DefinitionReader {
  function all<T>(sql: string, ...values: (string | number)[]): T[] {
    return database.prepare(sql).all(...values) as T[];
  }

  function databases(): string[] {
    return all<{ name: string }>(DATABASES_SQL).map((row) => row.name);
  }

  function primaryKeyColumns(schema: string, table: string): string[] {
    return all<ColumnRow>(COLUMNS_SQL, table, schema)
      .filter((column) => column.pk > 0)
      .sort((left, right) => left.pk - right.pk)
      .map((column) => column.name);
  }

  function columnRows(schema: string, name: string, kind: Relation["kind"]): ColumnRow[] {
    try {
      return all<ColumnRow>(COLUMNS_SQL, name, schema);
    } catch (cause) {
      // SQLite lets a table a view reads be dropped; the view stays listed but no longer compiles,
      // and one such view must not fail its whole schema. It shows without columns.
      if (kind === "view") return [];
      throw cause;
    }
  }

  function describeRelation(schema: string, name: string, kind: Relation["kind"]): Relation {
    const rows = columnRows(schema, name, kind).filter((row) => row.hidden !== HIDDEN_VIRTUAL_COLUMN);
    const keyColumns = rows.filter((row) => row.pk > 0).sort((left, right) => left.pk - right.pk);
    const rowidAlias = keyColumns.length === 1 && ROWID_ALIAS_TYPE.test(keyColumns[0]?.type ?? "");
    const columns = rows.map((row, index): ColumnMeta => ({
      name: row.name,
      position: index + 1,
      type: row.type,
      nullable: row.notnull === 0 && row.pk === 0,
      default: row.dflt_value,
      comment: null,
      autoIncrement: rowidAlias && row.pk > 0,
    }));
    const indexRows = kind === "view" ? [] : all<IndexRow>(INDEXES_SQL, name, schema);
    const indexes = indexRows.map((row): Index => ({
      name: row.name,
      columns: all<{ name: string | null }>(INDEX_PARTS_SQL, row.name, schema).map(
        (part) => part.name ?? EXPRESSION_PART,
      ),
      unique: row.unique === 1,
      primary: row.origin === PRIMARY_KEY_ORIGIN,
    }));
    const uniqueKeys = indexes
      .filter((index) => indexRows.find((row) => row.name === index.name)?.origin === UNIQUE_CONSTRAINT_ORIGIN)
      .map((index): Key => ({ name: index.name, columns: index.columns }));
    const foreignKeyRows = kind === "view" ? [] : all<ForeignKeyRow>(FOREIGN_KEYS_SQL, name, schema);
    const foreignKeys = new Map<number, ForeignKeyRow[]>();
    for (const row of foreignKeyRows) foreignKeys.set(row.id, [...(foreignKeys.get(row.id) ?? []), row]);
    return {
      name,
      kind,
      comment: null,
      columns,
      // SQLite does not name a primary or foreign key; these are the names DataGrip gives them.
      primaryKey: keyColumns.length === 0 ? null : { name: `${name}_pk`, columns: keyColumns.map((row) => row.name) },
      uniqueKeys: byName(uniqueKeys),
      foreignKeys: byName(
        [...foreignKeys.values()].map((parts): ForeignKey => {
          const first = parts[0];
          const target = first?.table ?? "";
          // `REFERENCES customers` without columns means the target's primary key.
          const targetColumns = parts.every((part) => part.to !== null)
            ? parts.map((part) => part.to ?? "")
            : primaryKeyColumns(schema, target);
          return {
            name: `${name}_${target}_${targetColumns.join("_")}_fk`,
            columns: parts.map((part) => part.from),
            target: { path: [schema], relation: target, columns: targetColumns },
            onDelete: first?.on_delete ?? "NO ACTION",
            onUpdate: first?.on_update ?? "NO ACTION",
          };
        }),
      ),
      indexes: byName(indexes),
    };
  }

  return {
    namespaces: () =>
      introspecting(() =>
        databases().map((name): Namespace => ({
          path: [name],
          name,
          kind: "schema",
          system: name === TEMP_DATABASE,
          current: name === MAIN_DATABASE,
        })),
      ),

    describe: (path) =>
      introspecting((): NamespaceCatalog => {
        const [schema] = path;
        if (path.length !== 1 || schema === undefined || !databases().includes(schema)) {
          throw new PluginError("introspectionFailed", `"${path.join(".")}" is not an attached database.`);
        }
        const relations = all<{ name: string; type: string }>(RELATIONS_SQL, schema).flatMap((row) => {
          const kind = RELATION_TYPES.get(row.type);
          if (kind === undefined || row.name.startsWith(INTERNAL_PREFIX)) return [];
          return [describeRelation(schema, row.name, kind)];
        });
        return { path: [schema], relations: byName(relations), routines: [], sequences: [] };
      }),

    definition: (path, name) =>
      introspecting((): string => {
        const [schema] = path;
        const relation =
          path.length === 1 && schema !== undefined && databases().includes(schema)
            ? all<{ sql: string }>(definedRelationSql(schema), name)[0]
            : undefined;
        if (relation === undefined || schema === undefined) throw new DefinitionNotFoundError(path, name);
        const parts = all<{ sql: string }>(definedPartsSql(schema), name);
        return [relation, ...parts].map((part) => `${part.sql};`).join("\n\n");
      }),

    qualifiedName: (path, name) => [...path, name].map(quote).join("."),
  };
}
