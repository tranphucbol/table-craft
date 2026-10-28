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
} from "@table-craft/plugin-api";
import type { ReadSet } from "./batch.js";

/** Runs one of the plugin's own requests on the session's connection, in turn with the user's. */
export type Reader = (sql: string, params?: readonly (string | null)[]) => Promise<ReadSet[]>;

type Record = Readonly<Partial<globalThis.Record<string, unknown>>>;

function records(set: ReadSet | undefined): Record[] {
  if (set === undefined) return [];
  return set.rows.map((row) => Object.fromEntries(set.columns.map((column, index) => [column.colName, row[index]])));
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}

function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

function number(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

/** `master`, `tempdb`, `model` and `msdb` have the first four `database_id`s. */
const LAST_SYSTEM_DATABASE_ID = 4;
/** Schemas from 16384 up belong to the fixed database roles (`db_owner` …). */
const FIRST_ROLE_SCHEMA_ID = 16384;
const SYSTEM_SCHEMAS: ReadonlySet<string> = new Set(["sys", "INFORMATION_SCHEMA", "guest"]);
/** `SERVERPROPERTY('EngineEdition')` of Azure SQL Database, which reads no other database's catalog. */
const AZURE_DATABASE_EDITION = 5;

const NAMESPACES_SQL = `
SELECT DB_NAME() AS database_name, SCHEMA_NAME() AS schema_name;
DECLARE @databases TABLE (name sysname, database_id int);
INSERT INTO @databases
  SELECT name, database_id FROM sys.databases
  WHERE state = 0 AND HAS_DBACCESS(name) = 1
    AND (SERVERPROPERTY('EngineEdition') <> ${String(AZURE_DATABASE_EDITION)} OR name = DB_NAME());
SELECT name, database_id FROM @databases ORDER BY name;
DECLARE @sql nvarchar(max) = N'';
SELECT @sql = @sql + CASE WHEN @sql = N'' THEN N'' ELSE N' UNION ALL ' END
  + N'SELECT ' + QUOTENAME(name, '''') + N' AS database_name, name COLLATE DATABASE_DEFAULT AS schema_name, schema_id FROM '
  + QUOTENAME(name) + N'.sys.schemas'
FROM @databases;
IF @sql <> N'' EXEC sys.sp_executesql @sql;`;

/** The kinds `describe` reads: tables, views and the four kinds of routine. */
const RELATION_TYPES: ReadonlyMap<string, Relation["kind"]> = new Map([
  ["U", "table"],
  ["V", "view"],
]);
/** Scalar, inline table-valued and multi-statement table-valued functions, T-SQL and CLR. */
const FUNCTION_TYPES: ReadonlySet<string> = new Set(["FN", "IF", "TF", "FS", "FT"]);
const PROCEDURE_TYPES: ReadonlySet<string> = new Set(["P", "PC"]);
const TABLE_FUNCTION_TYPES: ReadonlySet<string> = new Set(["IF", "TF", "FT"]);
const typeList = (types: Iterable<string>): string => [...types].map((type) => `'${type}'`).join(", ");
const ROUTINE_TYPES_SQL = typeList([...FUNCTION_TYPES, ...PROCEDURE_TYPES]);
const COLUMN_OWNER_TYPES_SQL = typeList([...RELATION_TYPES.keys(), ...TABLE_FUNCTION_TYPES]);

/** Every catalog query of `describe`, against `database`'s own catalog views (three-part names). */
function describeSql(database: string): string {
  const d = `${database}.sys`;
  const description = (major: string, minor: string): string =>
    `LEFT JOIN ${d}.extended_properties ep ON ep.class = 1 AND ep.major_id = ${major} AND ep.minor_id = ${minor} AND ep.name = N'MS_Description'`;
  return `
DECLARE @schema int = (SELECT schema_id FROM ${d}.schemas WHERE name = @p1);
SELECT @schema AS schema_id;
SELECT o.object_id, o.name, RTRIM(o.type) AS type, CAST(ep.value AS nvarchar(max)) AS comment
FROM ${d}.objects o ${description("o.object_id", "0")}
WHERE o.schema_id = @schema AND o.type IN (${typeList(RELATION_TYPES.keys())});
SELECT c.object_id, c.name, c.column_id, t.name AS type, t.is_user_defined, c.max_length, c.precision, c.scale,
  c.is_nullable, c.is_identity, dc.definition AS default_definition, CAST(ep.value AS nvarchar(max)) AS comment
FROM ${d}.columns c
JOIN ${d}.objects o ON o.object_id = c.object_id
JOIN ${d}.types t ON t.user_type_id = c.user_type_id
LEFT JOIN ${d}.default_constraints dc ON dc.object_id = c.default_object_id
${description("c.object_id", "c.column_id")}
WHERE o.schema_id = @schema AND o.type IN (${COLUMN_OWNER_TYPES_SQL})
ORDER BY c.object_id, c.column_id;
SELECT kc.parent_object_id AS object_id, kc.name, RTRIM(kc.type) AS type, c.name AS column_name
FROM ${d}.key_constraints kc
JOIN ${d}.objects o ON o.object_id = kc.parent_object_id
JOIN ${d}.index_columns ic ON ic.object_id = kc.parent_object_id AND ic.index_id = kc.unique_index_id
JOIN ${d}.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
WHERE o.schema_id = @schema AND ic.is_included_column = 0
ORDER BY kc.name, ic.key_ordinal;
SELECT fk.parent_object_id AS object_id, fk.name, fk.delete_referential_action_desc AS on_delete,
  fk.update_referential_action_desc AS on_update, pc.name AS column_name, rs.name AS target_schema,
  ro.name AS target_table, rc.name AS target_column
FROM ${d}.foreign_keys fk
JOIN ${d}.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
JOIN ${d}.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
JOIN ${d}.objects ro ON ro.object_id = fkc.referenced_object_id
JOIN ${d}.schemas rs ON rs.schema_id = ro.schema_id
JOIN ${d}.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
WHERE fk.schema_id = @schema
ORDER BY fk.name, fkc.constraint_column_id;
SELECT i.object_id, i.name, i.is_unique, i.is_primary_key, c.name AS column_name
FROM ${d}.indexes i
JOIN ${d}.objects o ON o.object_id = i.object_id
JOIN ${d}.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
JOIN ${d}.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
WHERE o.schema_id = @schema AND o.type IN (${typeList(RELATION_TYPES.keys())}) AND i.name IS NOT NULL
  AND ic.is_included_column = 0
ORDER BY i.name, ic.key_ordinal;
SELECT o.object_id, o.name, RTRIM(o.type) AS type, m.definition
FROM ${d}.objects o LEFT JOIN ${d}.sql_modules m ON m.object_id = o.object_id
WHERE o.schema_id = @schema AND o.type IN (${ROUTINE_TYPES_SQL});
SELECT p.object_id, p.parameter_id, p.name, t.name AS type, t.is_user_defined, p.max_length, p.precision, p.scale,
  p.is_output, p.has_default_value
FROM ${d}.parameters p
JOIN ${d}.objects o ON o.object_id = p.object_id
JOIN ${d}.types t ON t.user_type_id = p.user_type_id
WHERE o.schema_id = @schema AND o.type IN (${ROUTINE_TYPES_SQL})
ORDER BY p.object_id, p.parameter_id;
SELECT name FROM ${d}.sequences WHERE schema_id = @schema;`;
}

/** What only a definition needs: defaults' names, identity seeds, computed columns and checks. */
function definitionSql(database: string): string {
  const d = `${database}.sys`;
  return `
DECLARE @object int = (
  SELECT o.object_id FROM ${d}.objects o JOIN ${d}.schemas s ON s.schema_id = o.schema_id
  WHERE s.name = @p1 AND o.name = @p2 AND o.type IN (${typeList(RELATION_TYPES.keys())}));
SELECT RTRIM(o.type) AS type, m.definition FROM ${d}.objects o LEFT JOIN ${d}.sql_modules m ON m.object_id = o.object_id
WHERE o.object_id = @object;
SELECT c.name, dc.name AS default_name, ic.seed_value, ic.increment_value, cc.definition AS computed
FROM ${d}.columns c
LEFT JOIN ${d}.default_constraints dc ON dc.object_id = c.default_object_id
LEFT JOIN ${d}.identity_columns ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id
LEFT JOIN ${d}.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
WHERE c.object_id = @object;
SELECT name, definition FROM ${d}.check_constraints WHERE parent_object_id = @object ORDER BY name;`;
}

const TEXT_LENGTH_TYPES: ReadonlySet<string> = new Set(["varchar", "char", "varbinary", "binary"]);
const NATIONAL_TYPES: ReadonlySet<string> = new Set(["nvarchar", "nchar"]);
const SCALED_TYPES: ReadonlySet<string> = new Set(["decimal", "numeric"]);
const FRACTION_TYPES: ReadonlySet<string> = new Set(["datetime2", "time", "datetimeoffset"]);
/** `max_length` of a `(max)` column. */
const MAX_LENGTH = -1;
const BYTES_PER_NATIONAL_CHAR = 2;

/** A type as SQL Server spells it in DDL, from its catalog row: `nvarchar(40)`, `decimal(12,2)`. */
export function typeSpelling(row: Record): string {
  const name = text(row.type);
  if (row.is_user_defined === true) return name;
  const length = number(row.max_length);
  if (NATIONAL_TYPES.has(name)) {
    return `${name}(${length === MAX_LENGTH ? "max" : String(length / BYTES_PER_NATIONAL_CHAR)})`;
  }
  if (TEXT_LENGTH_TYPES.has(name)) return `${name}(${length === MAX_LENGTH ? "max" : String(length)})`;
  if (SCALED_TYPES.has(name)) return `${name}(${String(row.precision)},${String(row.scale)})`;
  if (FRACTION_TYPES.has(name)) return `${name}(${String(row.scale)})`;
  return name;
}

function groupBy(rows: readonly Record[]): Map<number, Record[]> {
  const groups = new Map<number, Record[]>();
  for (const row of rows) {
    const id = number(row.object_id);
    const group = groups.get(id);
    if (group === undefined) groups.set(id, [row]);
    else group.push(row);
  }
  return groups;
}

/** Rows of one constraint per name, in key order, as `[name, rows]`. */
function constraints(rows: readonly Record[]): [string, Record[]][] {
  const named = new Map<string, Record[]>();
  for (const row of rows) {
    const name = text(row.name);
    const group = named.get(name);
    if (group === undefined) named.set(name, [row]);
    else group.push(row);
  }
  return [...named];
}

/** `NO_ACTION` and `SET_NULL`, as the catalog spells them, are `NO ACTION` and `SET NULL` in SQL. */
function action(value: unknown): string {
  return text(value).replaceAll("_", " ");
}

const PARAMETER_PREFIX = "@";

/** `@amount` is `amount`: the contract's parameter names carry no sigil; calls add it back. */
function parameterName(name: unknown): string {
  const spelled = text(name);
  return spelled.startsWith(PARAMETER_PREFIX) ? spelled.slice(PARAMETER_PREFIX.length) : spelled;
}

const LINE_COMMENT = /--[^\n]*/g;
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const STRING = /N?'(?:[^']|'')*'/g;
const HEADER_TOKEN = /@[\w@#$]+|\w+|\S/g;
/** Words that end a module's parameter list: `RETURNS int`, `AS BEGIN`, `WITH RECOMPILE`, `FOR REPLICATION`. */
const HEADER_END = /^(?:RETURNS|AS|WITH|FOR)$/i;
const AS = /^AS$/i;

/**
 * T-SQL records no default for a T-SQL module's parameters (`has_default_value` is set only for
 * CLR ones), so the module's own header says which have one: `@rate decimal(6,4) = 0.015`.
 * Lower-cased names, `@` included.
 */
export function parametersWithDefaults(definition: string | null): ReadonlySet<string> {
  const found = new Set<string>();
  if (definition === null) return found;
  const plain = definition.replace(BLOCK_COMMENT, " ").replace(LINE_COMMENT, " ").replace(STRING, "''");
  const start = plain.indexOf(PARAMETER_PREFIX);
  if (start < 0) return found;
  let depth = 0;
  let name: string | null = null;
  let words = 0;
  for (const [token] of plain.slice(start).matchAll(HEADER_TOKEN)) {
    if (token === "(") depth += 1;
    else if (token === ")") {
      if (depth === 0) break;
      depth -= 1;
    } else if (depth > 0) continue;
    else if (token === ",") {
      name = null;
      words = 0;
    } else if (token === "=") {
      if (name !== null) found.add(name.toLowerCase());
    } else if (name === null && token.startsWith(PARAMETER_PREFIX)) {
      name = token;
      words = 1;
    } else {
      // `@a AS int` is a type; any other `AS` after a parameter starts the body.
      if (HEADER_END.test(token) && !(AS.test(token) && words === 1)) break;
      words += 1;
    }
  }
  return found;
}

function columnLine(column: ColumnMeta): string {
  return `${column.name} ${column.type}`;
}

/** Reads SQL Server's catalog views; every name is a two-level path `[database, schema]`. */
export function mssqlIntrospector(
  read: Reader,
  quoteIdentifier: (name: string) => string,
  nationalText: (value: string) => string,
): Introspector {
  async function sets(sql: string, params: readonly (string | null)[] = []): Promise<ReadSet[]> {
    try {
      return await read(sql, params);
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
        `A SQL Server namespace is a database and a schema, not "${path.join(".")}".`,
      );
    }
    return [database, schema];
  }

  // Definitions name objects within their database, where they are created.
  function schemaQualified(path: readonly string[], name: string): string {
    return [...path.slice(1), name].map(quoteIdentifier).join(".");
  }

  // Three parts, so a console that switched database with USE still reaches the object.
  function qualifiedName(path: readonly string[], name: string): string {
    return [...path, name].map(quoteIdentifier).join(".");
  }

  async function describe(path: readonly string[]): Promise<NamespaceCatalog> {
    const [database, schema] = schemaPath(path);
    const [head, relationSet, columnSet, keySet, foreignSet, indexSet, routineSet, parameterSet, sequenceSet] =
      await sets(describeSql(quoteIdentifier(database)), [schema]);
    if (records(head)[0]?.schema_id == null) {
      throw new PluginError("introspectionFailed", `Schema "${schema}" does not exist in database "${database}".`);
    }
    const columns = groupBy(records(columnSet));
    const keys = groupBy(records(keySet));
    const foreign = groupBy(records(foreignSet));
    const indexes = groupBy(records(indexSet));
    const relations = records(relationSet).map((row): Relation => {
      const id = number(row.object_id);
      const own = keys.get(id) ?? [];
      const keyOf = ([name, rows]: [string, Record[]]): Key => ({
        name,
        columns: rows.map((key) => text(key.column_name)),
      });
      const primary = constraints(own.filter((key) => key.type === "PK"))[0];
      return {
        name: text(row.name),
        kind: RELATION_TYPES.get(text(row.type)) ?? "table",
        comment: textOrNull(row.comment),
        columns: (columns.get(id) ?? []).map((column, index): ColumnMeta => ({
          name: text(column.name),
          position: index + 1,
          type: typeSpelling(column),
          nullable: column.is_nullable === true,
          default: textOrNull(column.default_definition),
          comment: textOrNull(column.comment),
          autoIncrement: column.is_identity === true,
        })),
        primaryKey: primary === undefined ? null : keyOf(primary),
        uniqueKeys: byName(constraints(own.filter((key) => key.type === "UQ")).map(keyOf)),
        foreignKeys: byName(
          constraints(foreign.get(id) ?? []).map(([name, rows]): ForeignKey => {
            const first = rows[0] ?? {};
            return {
              name,
              columns: rows.map((key) => text(key.column_name)),
              target: {
                path: [database, text(first.target_schema)],
                relation: text(first.target_table),
                columns: rows.map((key) => text(key.target_column)),
              },
              onDelete: action(first.on_delete),
              onUpdate: action(first.on_update),
            };
          }),
        ),
        indexes: byName(
          constraints(indexes.get(id) ?? []).map(([name, rows]): Index => ({
            name,
            columns: rows.map((index) => text(index.column_name)),
            unique: rows[0]?.is_unique === true,
            primary: rows[0]?.is_primary_key === true,
          })),
        ),
      };
    });
    const parameters = groupBy(records(parameterSet));
    const routines = records(routineSet).map((row): Routine => {
      const id = number(row.object_id);
      const type = text(row.type);
      const defaults = parametersWithDefaults(textOrNull(row.definition));
      const own = parameters.get(id) ?? [];
      const result = own.find((parameter) => number(parameter.parameter_id) === 0);
      const listed = own.filter((parameter) => number(parameter.parameter_id) > 0);
      const isFunction = FUNCTION_TYPES.has(type);
      const described = listed.map((parameter): RoutineParameter => ({
        name: parameterName(parameter.name),
        type: typeSpelling(parameter),
        mode: parameter.is_output === true ? "out" : "in",
        hasDefault: parameter.has_default_value === true || defaults.has(text(parameter.name).toLowerCase()),
      }));
      const tableColumns = (columns.get(id) ?? []).map((column) => `${text(column.name)} ${typeSpelling(column)}`);
      const returns = !isFunction
        ? null
        : TABLE_FUNCTION_TYPES.has(type)
          ? `TABLE(${tableColumns.join(", ")})`
          : result === undefined
            ? null
            : typeSpelling(result);
      return {
        name: text(row.name),
        kind: isFunction ? "function" : "procedure",
        signature: listed
          .map(
            (parameter) =>
              `${text(parameter.name)} ${typeSpelling(parameter)}${parameter.is_output === true ? " OUTPUT" : ""}`,
          )
          .join(", "),
        parameters: described,
        returns,
      };
    });
    return {
      path: [database, schema],
      relations: byName(relations),
      routines: byName(routines),
      sequences: byName(records(sequenceSet).map((row) => ({ name: text(row.name) }))),
    };
  }

  async function definition(path: readonly string[], name: string): Promise<string> {
    const [database, schema] = schemaPath(path);
    const [objectSet, columnSet, checkSet] = await sets(definitionSql(quoteIdentifier(database)), [schema, name]);
    const object = records(objectSet)[0];
    if (object === undefined) throw new DefinitionNotFoundError(path, name);
    const qualified = schemaQualified(path, name);
    if (object.type !== "U") {
      const body = textOrNull(object.definition)?.trim() ?? "";
      if (body === "") throw new DefinitionNotFoundError(path, name);
      return body.endsWith(";") ? body : `${body};`;
    }
    const relation = (await describe(path)).relations.find((candidate) => candidate.name === name);
    if (relation === undefined) throw new DefinitionNotFoundError(path, name);
    const extras = new Map(records(columnSet).map((row) => [text(row.name), row]));
    const lines = relation.columns.map((column) => {
      const extra = extras.get(column.name) ?? {};
      const quoted = quoteIdentifier(column.name);
      if (extra.computed != null) return `${quoted} AS ${text(extra.computed)}`;
      const identity = column.autoIncrement
        ? ` IDENTITY(${text(extra.seed_value ?? 1)},${text(extra.increment_value ?? 1)})`
        : "";
      const nullability = column.nullable ? " NULL" : " NOT NULL";
      const fallback =
        column.default === null
          ? ""
          : ` CONSTRAINT ${quoteIdentifier(text(extra.default_name))} DEFAULT ${column.default}`;
      return `${columnLine({ ...column, name: quoted })}${identity}${nullability}${fallback}`;
    });
    const list = (names: readonly string[]): string => names.map(quoteIdentifier).join(", ");
    if (relation.primaryKey !== null) {
      lines.push(
        `CONSTRAINT ${quoteIdentifier(relation.primaryKey.name)} PRIMARY KEY (${list(relation.primaryKey.columns)})`,
      );
    }
    for (const key of relation.uniqueKeys)
      lines.push(`CONSTRAINT ${quoteIdentifier(key.name)} UNIQUE (${list(key.columns)})`);
    for (const key of relation.foreignKeys) {
      const target = schemaQualified(key.target.path, key.target.relation);
      lines.push(
        `CONSTRAINT ${quoteIdentifier(key.name)} FOREIGN KEY (${list(key.columns)}) REFERENCES ${target} (${list(key.target.columns)})` +
          `${key.onDelete === "NO ACTION" ? "" : ` ON DELETE ${key.onDelete}`}${key.onUpdate === "NO ACTION" ? "" : ` ON UPDATE ${key.onUpdate}`}`,
      );
    }
    for (const check of records(checkSet)) {
      lines.push(`CONSTRAINT ${quoteIdentifier(text(check.name))} CHECK ${text(check.definition)}`);
    }
    const statements = [`CREATE TABLE ${qualified} (\n${lines.map((line) => `  ${line}`).join(",\n")}\n);`];
    const constrained = new Set([...relation.uniqueKeys.map((key) => key.name), relation.primaryKey?.name]);
    for (const index of relation.indexes) {
      if (index.primary || constrained.has(index.name)) continue;
      statements.push(
        `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${quoteIdentifier(index.name)} ON ${qualified} (${list(index.columns)});`,
      );
    }
    const level = (comment: string, column?: string): string =>
      `EXEC sys.sp_addextendedproperty @name = N'MS_Description', @value = ${nationalText(comment)}, ` +
      `@level0type = N'SCHEMA', @level0name = ${nationalText(schema)}, @level1type = N'TABLE', @level1name = ${nationalText(name)}` +
      `${column === undefined ? "" : `, @level2type = N'COLUMN', @level2name = ${nationalText(column)}`};`;
    if (relation.comment !== null) statements.push(level(relation.comment));
    for (const column of relation.columns)
      if (column.comment !== null) statements.push(level(column.comment, column.name));
    return statements.join("\n\n");
  }

  return {
    async namespaces(): Promise<readonly Namespace[]> {
      const [currentSet, databaseSet, schemaSet] = await sets(NAMESPACES_SQL);
      const current = records(currentSet)[0] ?? {};
      const systemDatabases = new Set(
        records(databaseSet)
          .filter((row) => number(row.database_id) <= LAST_SYSTEM_DATABASE_ID)
          .map((row) => text(row.name)),
      );
      const databases = records(databaseSet).map((row): Namespace => ({
        path: [text(row.name)],
        name: text(row.name),
        kind: "database",
        system: systemDatabases.has(text(row.name)),
        current: false,
      }));
      const schemas = records(schemaSet)
        .map((row): Namespace => {
          const database = text(row.database_name);
          const name = text(row.schema_name);
          return {
            path: [database, name],
            name,
            kind: "schema",
            system:
              systemDatabases.has(database) ||
              SYSTEM_SCHEMAS.has(name) ||
              number(row.schema_id) >= FIRST_ROLE_SCHEMA_ID,
            current: database === current.database_name && name === current.schema_name,
          };
        })
        .sort((left, right) => left.path.join("\u0000").localeCompare(right.path.join("\u0000")));
      return [...databases, ...schemas];
    },
    describe,
    qualifiedName,
    definition,
  };
}
