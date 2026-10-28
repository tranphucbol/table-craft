import oracledb from "oracledb";
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
  type Relation,
  type RelationKind,
  type Routine,
  type RoutineParameter,
  type RoutineParameterMode,
} from "@table-craft/plugin-api";
import { messageOf } from "./connect.js";

const CURRENT_SCHEMA = "SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA')";

/**
 * Every schema that owns something this user can see, and the current one even when empty;
 * the ones Oracle maintains (`SYS`, `SYSTEM`, `XDB`…) are the system's.
 */
const NAMESPACES_SQL = `
  SELECT u.username AS "name", u.oracle_maintained AS "maintained",
    CASE WHEN u.username = ${CURRENT_SCHEMA} THEN 1 ELSE 0 END AS "current"
  FROM all_users u
  WHERE u.username = ${CURRENT_SCHEMA} OR EXISTS (SELECT 1 FROM all_objects o WHERE o.owner = u.username)
  ORDER BY 3 DESC, 2, 1`;

const SCHEMA_EXISTS_SQL = `SELECT 1 AS "found" FROM all_users WHERE username = :owner`;

/** Tables less the ones a materialized view keeps its rows in, the recycle bin and nested tables. */
const RELATIONS_SQL = `
  SELECT t.table_name AS "name", 'table' AS "kind", c.comments AS "comment"
  FROM all_tables t
  LEFT JOIN all_tab_comments c ON c.owner = t.owner AND c.table_name = t.table_name
  WHERE t.owner = :owner AND t.nested = 'NO' AND t.secondary = 'N' AND t.dropped = 'NO'
    AND NOT EXISTS (SELECT 1 FROM all_mviews m WHERE m.owner = t.owner AND m.mview_name = t.table_name)
  UNION ALL
  SELECT v.view_name, 'view', c.comments
  FROM all_views v
  LEFT JOIN all_tab_comments c ON c.owner = v.owner AND c.table_name = v.view_name
  WHERE v.owner = :owner
  UNION ALL
  SELECT m.mview_name, 'materializedView', c.comments
  FROM all_mviews m
  LEFT JOIN all_mview_comments c ON c.owner = m.owner AND c.mview_name = m.mview_name
  WHERE m.owner = :owner`;

const COLUMNS_SQL = `
  SELECT c.table_name AS "table", c.column_name AS "name", c.column_id AS "position", c.data_type AS "type",
    c.data_length AS "length", c.char_length AS "chars", c.char_used AS "charUsed",
    c.data_precision AS "precision", c.data_scale AS "scale", c.nullable AS "nullable",
    c.data_default AS "default", c.identity_column AS "identity", m.comments AS "comment"
  FROM all_tab_cols c
  LEFT JOIN all_col_comments m ON m.owner = c.owner AND m.table_name = c.table_name AND m.column_name = c.column_name
  WHERE c.owner = :owner AND c.hidden_column = 'NO' AND c.column_id IS NOT NULL
  ORDER BY c.table_name, c.column_id`;

const CONSTRAINTS_SQL = `
  SELECT k.table_name AS "table", k.constraint_name AS "name", k.constraint_type AS "type",
    k.delete_rule AS "deleteRule", r.owner AS "targetOwner", r.table_name AS "targetTable",
    k.r_constraint_name AS "targetKey", k.index_name AS "indexName"
  FROM all_constraints k
  LEFT JOIN all_constraints r ON r.owner = k.r_owner AND r.constraint_name = k.r_constraint_name
  WHERE k.owner = :owner AND k.constraint_type IN ('P', 'U', 'R') AND k.table_name NOT LIKE 'BIN$%'
  ORDER BY k.table_name, k.constraint_name`;

const KEY_COLUMNS_SQL = `
  SELECT k.owner AS "owner", k.constraint_name AS "name", k.column_name AS "column"
  FROM all_cons_columns k
  WHERE k.owner = :owner
     OR (k.owner, k.constraint_name) IN (
       SELECT c.r_owner, c.r_constraint_name FROM all_constraints c
       WHERE c.owner = :owner AND c.constraint_type = 'R')
  ORDER BY k.owner, k.constraint_name, k.position`;

const INDEXES_SQL = `
  SELECT i.table_name AS "table", i.index_name AS "name", i.uniqueness AS "uniqueness", c.column_name AS "column"
  FROM all_indexes i
  JOIN all_ind_columns c ON c.index_owner = i.owner AND c.index_name = i.index_name
  WHERE i.owner = :owner AND i.table_owner = :owner AND i.index_type <> 'LOB'
  ORDER BY i.table_name, i.index_name, c.column_position`;

/** Standalone functions and procedures, then each package's members, an overload per subprogram id. */
const ROUTINES_SQL = `
  SELECT p.object_name AS "object", p.procedure_name AS "member", p.subprogram_id AS "subprogram",
    p.object_type AS "type", p.overload AS "overload"
  FROM all_procedures p
  WHERE p.owner = :owner AND (
    (p.object_type IN ('FUNCTION', 'PROCEDURE') AND p.procedure_name IS NULL)
    OR (p.object_type = 'PACKAGE' AND p.procedure_name IS NOT NULL))
  ORDER BY 1, 2, 3`;

const ARGUMENTS_SQL = `
  SELECT a.package_name AS "package", a.object_name AS "object", a.subprogram_id AS "subprogram",
    a.argument_name AS "name", a.position AS "position", a.in_out AS "mode", a.data_type AS "type",
    a.type_owner AS "typeOwner", a.type_name AS "typeName", a.type_subname AS "typeSubname",
    a.defaulted AS "defaulted"
  FROM all_arguments a
  WHERE a.owner = :owner AND a.data_level = 0
  ORDER BY a.package_name, a.object_name, a.subprogram_id, a.sequence`;

/** Identity columns draw from a system-named sequence the explorer would only clutter. */
const SEQUENCES_SQL = `
  SELECT s.sequence_name AS "name" FROM all_sequences s
  WHERE s.sequence_owner = :owner AND s.sequence_name NOT LIKE 'ISEQ$$%'`;

const DEFINED_OBJECT_SQL = `
  SELECT object_type AS "type" FROM all_objects
  WHERE owner = :owner AND object_name = :name AND object_type IN ('TABLE', 'VIEW', 'MATERIALIZED VIEW')
  ORDER BY CASE object_type WHEN 'MATERIALIZED VIEW' THEN 0 ELSE 1 END`;

/**
 * The object's DDL as `DBMS_METADATA` prints it, terminated and without storage clauses, then its
 * indexes and comments; a dependent kind the object has none of raises ORA-31608, read as none.
 */
const DEFINITION_SQL = `
  DECLARE
    PROCEDURE param(name VARCHAR2, value BOOLEAN) IS
    BEGIN
      DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, name, value);
    END;
    FUNCTION dependent(kind VARCHAR2) RETURN CLOB IS
    BEGIN
      RETURN DBMS_METADATA.GET_DEPENDENT_DDL(kind, :name, :owner);
    EXCEPTION
      WHEN OTHERS THEN RETURN NULL;
    END;
  BEGIN
    param('SQLTERMINATOR', TRUE);
    param('PRETTY', TRUE);
    param('STORAGE', FALSE);
    param('SEGMENT_ATTRIBUTES', FALSE);
    :ddl := DBMS_METADATA.GET_DDL(:kind, :name, :owner);
    IF :kind = 'TABLE' THEN
      :indexes := dependent('INDEX');
    END IF;
    :comments := dependent('COMMENT');
    DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'DEFAULT', TRUE);
  END;`;

const METADATA_KINDS: Readonly<Record<string, string>> = {
  TABLE: "TABLE",
  VIEW: "VIEW",
  "MATERIALIZED VIEW": "MATERIALIZED_VIEW",
};

interface ColumnRow {
  readonly table: string;
  readonly name: string;
  readonly position: number;
  readonly type: string;
  readonly length: number | null;
  readonly chars: number | null;
  readonly charUsed: string | null;
  readonly precision: number | null;
  readonly scale: number | null;
  readonly nullable: string;
  readonly default: string | null;
  readonly identity: string;
  readonly comment: string | null;
}

interface ConstraintRow {
  readonly table: string;
  readonly name: string;
  readonly type: "P" | "U" | "R";
  readonly deleteRule: string | null;
  readonly targetOwner: string | null;
  readonly targetTable: string | null;
  readonly targetKey: string | null;
  readonly indexName: string | null;
}

interface ArgumentRow {
  readonly package: string | null;
  readonly object: string;
  readonly subprogram: number;
  readonly name: string | null;
  readonly position: number;
  readonly mode: string;
  readonly type: string | null;
  readonly typeOwner: string | null;
  readonly typeName: string | null;
  readonly typeSubname: string | null;
  readonly defaulted: string;
}

interface RoutineRow {
  readonly object: string;
  readonly member: string | null;
  readonly subprogram: number;
  readonly type: string;
}

const LENGTH_TYPES = new Set(["VARCHAR2", "NVARCHAR2", "CHAR", "NCHAR", "VARCHAR"]);
const NATIONAL_TYPES = new Set(["NVARCHAR2", "NCHAR"]);

/** A column's type as `CREATE TABLE` would spell it: `NUMBER(12,2)`, `VARCHAR2(200 CHAR)`. */
export function columnType(
  row: Pick<ColumnRow, "type" | "length" | "chars" | "charUsed" | "precision" | "scale">,
): string {
  const { type } = row;
  if (type === "NUMBER") {
    if (row.precision === null) return row.scale === 0 ? "INTEGER" : "NUMBER";
    return row.scale === null || row.scale === 0
      ? `NUMBER(${String(row.precision)})`
      : `NUMBER(${String(row.precision)},${String(row.scale)})`;
  }
  if (type === "FLOAT" && row.precision !== null) return `FLOAT(${String(row.precision)})`;
  if (LENGTH_TYPES.has(type)) {
    if (NATIONAL_TYPES.has(type)) return `${type}(${String(row.chars)})`;
    return row.charUsed === "C" ? `${type}(${String(row.chars)} CHAR)` : `${type}(${String(row.length)})`;
  }
  if (type === "RAW") return `RAW(${String(row.length)})`;
  return type;
}

/** An argument's type as a declaration would spell it. */
function argumentType(row: ArgumentRow): string {
  if (row.type === "REF CURSOR") return "SYS_REFCURSOR";
  if (row.type === "PL/SQL BOOLEAN") return "BOOLEAN";
  if (row.typeName !== null && row.type !== null && !LENGTH_TYPES.has(row.type) && row.type !== "NUMBER") {
    const owner = row.typeOwner === null ? "" : `${row.typeOwner}.`;
    return row.typeSubname === null ? `${owner}${row.typeName}` : `${owner}${row.typeName}.${row.typeSubname}`;
  }
  return row.type ?? "";
}

const MODES: Readonly<Record<string, RoutineParameterMode>> = { IN: "in", OUT: "out", "IN/OUT": "inout" };
const MODE_WORDS: Readonly<Record<RoutineParameterMode, string>> = {
  in: "",
  out: "OUT ",
  inout: "IN OUT ",
  variadic: "",
};

function signatureOf(parameters: readonly RoutineParameter[]): string {
  return parameters
    .map((parameter) => `${parameter.name ?? ""} ${MODE_WORDS[parameter.mode]}${parameter.type}`.trim())
    .join(", ");
}

function grouped<T, K>(rows: readonly T[], key: (row: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const row of rows) {
    const list = groups.get(key(row));
    if (list === undefined) groups.set(key(row), [row]);
    else list.push(row);
  }
  return groups;
}

function routinesOf(routineRows: readonly RoutineRow[], argumentRows: readonly ArgumentRow[]): Routine[] {
  const argumentsOf = grouped(
    argumentRows,
    (row) => `${row.package ?? ""}\u0000${row.object}\u0000${String(row.subprogram)}`,
  );
  return routineRows.map((row) => {
    const packaged = row.member !== null;
    const key = packaged
      ? `${row.object}\u0000${row.member ?? ""}\u0000${String(row.subprogram)}`
      : `\u0000${row.object}\u0000${String(row.subprogram)}`;
    // A standalone unit's arguments carry subprogram id 1, its own.
    const found = argumentsOf.get(key) ?? (packaged ? [] : (argumentsOf.get(`\u0000${row.object}\u00001`) ?? []));
    const result = found.find((argument) => argument.position === 0);
    // A unit without parameters still has one row, with no name and no type.
    const parameters: RoutineParameter[] = found
      .filter((argument) => argument.position > 0 && argument.type !== null)
      .map((argument) => ({
        name: argument.name,
        type: argumentType(argument),
        mode: MODES[argument.mode] ?? "in",
        hasDefault: argument.defaulted === "Y",
      }));
    const isFunction = result !== undefined || row.type === "FUNCTION";
    return {
      name: packaged ? `${row.object}.${row.member ?? ""}` : row.object,
      kind: isFunction ? "function" : "procedure",
      signature: signatureOf(parameters),
      parameters,
      returns: isFunction ? (result === undefined ? null : argumentType(result)) : null,
    };
  });
}

function relationsOf(
  self: string,
  relationRows: readonly { name: string; kind: RelationKind; comment: string | null }[],
  columnRows: readonly ColumnRow[],
  constraintRows: readonly ConstraintRow[],
  keyColumns: ReadonlyMap<string, string[]>,
  indexRows: readonly { table: string; name: string; uniqueness: string; column: string }[],
): Relation[] {
  const columnsOf = grouped(columnRows, (row) => row.table);
  const constraintsOf = grouped(constraintRows, (row) => row.table);
  const indexesOf = grouped(indexRows, (row) => row.table);
  const columnsAt = (owner: string | null, name: string | null): string[] =>
    keyColumns.get(`${owner ?? ""}\u0000${name ?? ""}`) ?? [];
  return relationRows.map((relation) => {
    const constraints = constraintsOf.get(relation.name) ?? [];
    const key = (row: ConstraintRow, owner: string): Key => ({ name: row.name, columns: columnsAt(owner, row.name) });
    const primary = constraints.find((row) => row.type === "P");
    const owner = (row: ConstraintRow): string => row.targetOwner ?? "";
    const foreignKeys: ForeignKey[] = constraints
      .filter((row) => row.type === "R")
      .map((row) => ({
        name: row.name,
        columns: columnsAt(self, row.name),
        target: {
          path: [owner(row)],
          relation: row.targetTable ?? "",
          columns: columnsAt(row.targetOwner, row.targetKey),
        },
        onDelete: row.deleteRule ?? "NO ACTION",
        onUpdate: "NO ACTION",
      }));
    const indexes: Index[] = [...grouped(indexesOf.get(relation.name) ?? [], (row) => row.name)].map(
      ([name, rows]) => ({
        name,
        columns: rows.map((row) => row.column),
        unique: rows[0]?.uniqueness === "UNIQUE",
        primary: primary?.indexName === name,
      }),
    );
    return {
      name: relation.name,
      kind: relation.kind,
      comment: relation.comment,
      columns: (columnsOf.get(relation.name) ?? []).map((row): ColumnMeta => ({
        name: row.name,
        position: row.position,
        type: columnType(row),
        nullable: row.nullable === "Y",
        default: row.identity === "YES" ? null : (row.default?.trim() ?? null) || null,
        comment: row.comment,
        autoIncrement: row.identity === "YES",
      })),
      primaryKey: primary === undefined ? null : key(primary, self),
      uniqueKeys: byName(constraints.filter((row) => row.type === "U").map((row) => key(row, self))),
      foreignKeys: byName(foreignKeys),
      indexes: byName(indexes),
    };
  });
}

async function lobText(lob: oracledb.Lob | null | undefined): Promise<string | null> {
  if (lob === null || lob === undefined) return null;
  try {
    const data = await lob.getData();
    return typeof data === "string" ? data : null;
  } finally {
    lob.destroy();
  }
}

const PLAIN_PART = /^[A-Z][A-Z0-9_$#]*$/;

export function oracleIntrospector(
  connection: oracledb.Connection,
  name: (identifier: string) => string,
): Introspector {
  async function rows<T>(sql: string, binds: oracledb.BindParameters = {}): Promise<T[]> {
    try {
      const result = await connection.execute<T>(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });
      return result.rows ?? [];
    } catch (cause) {
      throw new PluginError("introspectionFailed", messageOf(cause), { cause });
    }
  }

  function qualifiedName(path: readonly string[], object: string): string {
    const [owner] = path;
    // A package member is described as `PACKAGE.MEMBER`, and called with the package in between.
    const parts = object.split(".");
    const spelled =
      parts.length === 2 && parts.every((part) => PLAIN_PART.test(part)) ? parts.map(name).join(".") : name(object);
    return owner === undefined ? spelled : `${name(owner)}.${spelled}`;
  }

  return {
    async namespaces(): Promise<Namespace[]> {
      const found = await rows<{ name: string; maintained: string; current: number }>(NAMESPACES_SQL);
      return found.map((row) => ({
        path: [row.name],
        name: row.name,
        kind: "schema",
        system: row.maintained === "Y",
        current: row.current === 1,
      }));
    },

    async describe(path) {
      const [owner] = path;
      if (owner === undefined || path.length !== 1) {
        throw new PluginError("introspectionFailed", `"${path.join(".")}" is not a schema of the connected database.`);
      }
      const binds = { owner };
      if ((await rows<{ found: number }>(SCHEMA_EXISTS_SQL, binds)).length === 0) {
        throw new PluginError("introspectionFailed", `Schema "${owner}" does not exist in this database.`);
      }
      const [relationRows, columnRows, constraintRows, keyRows, indexRows, routineRows, argumentRows, sequenceRows] =
        await Promise.all([
          rows<{ name: string; kind: RelationKind; comment: string | null }>(RELATIONS_SQL, binds),
          rows<ColumnRow>(COLUMNS_SQL, binds),
          rows<ConstraintRow>(CONSTRAINTS_SQL, binds),
          rows<{ owner: string; name: string; column: string }>(KEY_COLUMNS_SQL, binds),
          rows<{ table: string; name: string; uniqueness: string; column: string }>(INDEXES_SQL, binds),
          rows<RoutineRow>(ROUTINES_SQL, binds),
          rows<ArgumentRow>(ARGUMENTS_SQL, binds),
          rows<{ name: string }>(SEQUENCES_SQL, binds),
        ]);
      const keyColumns = new Map<string, string[]>();
      for (const row of keyRows) {
        const key = `${row.owner}\u0000${row.name}`;
        keyColumns.set(key, [...(keyColumns.get(key) ?? []), row.column]);
      }
      return {
        path,
        relations: byName(relationsOf(owner, relationRows, columnRows, constraintRows, keyColumns, indexRows)),
        routines: routinesOf(routineRows, argumentRows).sort((a, b) =>
          a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
        ),
        sequences: byName(sequenceRows.map((row) => ({ name: row.name }))),
      };
    },

    async definition(path, object) {
      const [owner] = path;
      const found =
        owner === undefined
          ? undefined
          : (await rows<{ type: string }>(DEFINED_OBJECT_SQL, { owner, name: object }))[0];
      const kind = found === undefined ? undefined : METADATA_KINDS[found.type];
      if (owner === undefined || kind === undefined) throw new DefinitionNotFoundError(path, object);
      const clob = { dir: oracledb.BIND_OUT, type: oracledb.DB_TYPE_CLOB };
      try {
        const result = await connection.execute<Record<"ddl" | "indexes" | "comments", oracledb.Lob | null>>(
          DEFINITION_SQL,
          { owner, name: object, kind, ddl: clob, indexes: clob, comments: clob },
        );
        const out = result.outBinds;
        const parts = await Promise.all([out?.ddl, out?.indexes, out?.comments].map((lob) => lobText(lob)));
        return parts
          .filter((part): part is string => typeof part === "string" && part.trim() !== "")
          .map((part) => part.trim())
          .join("\n\n");
      } catch (cause) {
        throw new PluginError("introspectionFailed", messageOf(cause), { cause });
      }
    },

    qualifiedName,
  };
}
