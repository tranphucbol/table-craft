import type {
  CheckDesign,
  ColumnDesign,
  DdlContext,
  DdlScript,
  ForeignKeyDesign,
  IndexDesign,
  ObjectChange,
  ObjectEditor,
  ObjectKind,
  TableDesign,
} from "@table-craft/plugin-api";
import {
  ddlScript,
  designError,
  NOTHING_TO_CHANGE,
  referencesClause,
  tableDesignOf,
  tableDifference,
  unchanged,
  validateDesign,
} from "@table-craft/plugin-api/sql";

const INDENT = "  ";
const IDENTITY = "IDENTITY(1,1)";
const DESCRIPTION = "MS_Description";

const TYPES = [
  "int",
  "bigint",
  "smallint",
  "bit",
  "decimal(12, 2)",
  "nvarchar(255)",
  "nvarchar(max)",
  "varchar(255)",
  "varbinary(max)",
  "date",
  "datetime2",
  "datetimeoffset",
  "uniqueidentifier",
  "float",
];

const KEYWORDS: Readonly<Partial<Record<ObjectKind, string>>> = {
  table: "TABLE",
  view: "VIEW",
  sequence: "SEQUENCE",
  function: "FUNCTION",
  procedure: "PROCEDURE",
};
/** `DROP VIEW`, `DROP FUNCTION` and `DROP PROCEDURE` take no database name; they run inside it. */
const DROPPED_INSIDE: ReadonlySet<ObjectKind> = new Set(["view", "function", "procedure"]);
const KINDS: readonly ObjectKind[] = ["table", "view", "sequence", "function", "procedure"];

export interface MssqlObjectOptions {
  /** Spells a column, index or constraint name, quoting only where needed. */
  readonly name: (identifier: string) => string;
  /** Always brackets: names inside `N'…'` strings that `OBJECT_ID` and `sp_rename` parse. */
  readonly quoteIdentifier: (identifier: string) => string;
}

/** `N'…'`: SQL Server's procedures take `nvarchar` names and values. */
export function nationalText(value: string): string {
  return `N'${value.replaceAll("'", "''")}'`;
}

/**
 * Object DDL for SQL Server, whose DDL is transactional. Names are three-part
 * (`[db].[schema].[name]`), so a change lands in the database the tree shows whatever the session's
 * own; what takes no database name runs through that database's `sp_executesql` or `sp_rename`.
 */
export function mssqlObjects(options: MssqlObjectOptions): ObjectEditor {
  const { name, quoteIdentifier } = options;

  function local(path: readonly string[], object: string): string {
    return `${quoteIdentifier(path[1] ?? "")}.${quoteIdentifier(object)}`;
  }

  function procedure(path: readonly string[], called: string): string {
    return `EXEC ${quoteIdentifier(path[0] ?? "")}.sys.${called}`;
  }

  function inside(path: readonly string[], sql: string): string {
    return `${procedure(path, "sp_executesql")} ${nationalText(sql)}`;
  }

  function defaultName(table: string, column: string): string {
    return `DF_${table}_${column}`;
  }

  function columnDefinition(table: string, column: ColumnDesign): string {
    const fallback = (column.default ?? "").trim();
    return [
      name(column.name),
      column.type.trim(),
      column.autoIncrement ? IDENTITY : "",
      column.nullable ? "NULL" : "NOT NULL",
      fallback === "" ? "" : `CONSTRAINT ${name(defaultName(table, column.name))} DEFAULT ${fallback}`,
    ]
      .filter((part) => part !== "")
      .join(" ");
  }

  function columns(list: readonly string[]): string {
    return list.map(name).join(", ");
  }

  function foreignKey(key: ForeignKeyDesign): string {
    // A foreign key cannot reach another database, and REFERENCES refuses a three-part name.
    const target = [...key.target.path.slice(1), key.target.relation].map(options.quoteIdentifier).join(".");
    return `CONSTRAINT ${name(key.name)} ${referencesClause(key, target, name)}`;
  }

  function check(entry: CheckDesign): string {
    return `CONSTRAINT ${name(entry.name)} CHECK (${entry.expression.trim()})`;
  }

  function createIndex(index: IndexDesign, table: string): string {
    return `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${name(index.name)} ON ${table} (${columns(index.columns)});`;
  }

  /** The description of a table, or of its column, replaced by `value`; none when it is empty. */
  function comment(
    path: readonly string[],
    table: string,
    column: string | null,
    value: string | null,
    replace = true,
  ): string[] {
    const target = [
      `@level0type = N'SCHEMA', @level0name = ${nationalText(path[1] ?? "")}`,
      `@level1type = N'TABLE', @level1name = ${nationalText(table)}`,
      ...(column === null ? [] : [`@level2type = N'COLUMN', @level2name = ${nationalText(column)}`]),
    ].join(", ");
    const objectId = `OBJECT_ID(${nationalText(`${quoteIdentifier(path[0] ?? "")}.${local(path, table)}`)})`;
    const minor = column === null ? "0" : `COLUMNPROPERTY(${objectId}, ${nationalText(column)}, 'ColumnId')`;
    const drop = `IF EXISTS (SELECT 1 FROM ${quoteIdentifier(path[0] ?? "")}.sys.extended_properties WHERE class = 1 AND major_id = ${objectId} AND minor_id = ${minor} AND name = N'${DESCRIPTION}') ${procedure(path, "sp_dropextendedproperty")} @name = N'${DESCRIPTION}', ${target};`;
    const add =
      value === null || value === ""
        ? []
        : [
            `${procedure(path, "sp_addextendedproperty")} @name = N'${DESCRIPTION}', @value = ${nationalText(value)}, ${target};`,
          ];
    return replace ? [drop, ...add] : add;
  }

  /** Drops the column's default constraint, whatever it is named. */
  function dropDefault(path: readonly string[], table: string, qualified: string, column: string): string {
    const objectId = `OBJECT_ID(${nationalText(qualified)})`;
    return [
      `DECLARE @default sysname = (SELECT name FROM ${quoteIdentifier(path[0] ?? "")}.sys.default_constraints`,
      `WHERE parent_object_id = ${objectId} AND parent_column_id = COLUMNPROPERTY(${objectId}, ${nationalText(column)}, 'ColumnId'));`,
      `IF @default IS NOT NULL EXEC (N'ALTER TABLE ${qualified.replaceAll("'", "''")} DROP CONSTRAINT [' + @default + N']');`,
    ].join("\n");
  }

  function createTable(path: readonly string[], design: TableDesign, context: DdlContext): DdlScript {
    validateDesign(design);
    const table = context.qualifiedName(path, design.name);
    const parts = [
      ...design.columns.map((column) => columnDefinition(design.name, column)),
      ...(design.primaryKey.length > 0 ? [`PRIMARY KEY (${columns(design.primaryKey)})`] : []),
      ...design.foreignKeys.map((key) => foreignKey(key)),
      ...design.checks.map(check),
    ];
    return ddlScript(
      [
        `CREATE TABLE ${table} (\n${parts.map((part) => INDENT + part).join(",\n")}\n);`,
        ...design.indexes.map((index) => createIndex(index, table)),
        ...comment(path, design.name, null, design.comment, false),
        ...design.columns.flatMap((column) => comment(path, design.name, column.name, column.comment, false)),
      ],
      { transactional: true },
    );
  }

  function alterColumn(
    path: readonly string[],
    tableName: string,
    table: string,
    before: ColumnDesign,
    after: ColumnDesign,
  ): string[] {
    const statements: string[] = [];
    if (before.name !== after.name) {
      const column = nationalText(`${local(path, tableName)}.${quoteIdentifier(before.name)}`);
      statements.push(`${procedure(path, "sp_rename")} ${column}, ${nationalText(after.name)}, N'COLUMN';`);
    }
    if (before.autoIncrement !== after.autoIncrement) {
      throw designError("SQL Server cannot add or remove IDENTITY on a column; add a new column instead.");
    }
    const type = after.type.trim();
    if (before.type.trim() !== type || before.nullable !== after.nullable) {
      statements.push(
        `ALTER TABLE ${table} ALTER COLUMN ${name(after.name)} ${type} ${after.nullable ? "NULL" : "NOT NULL"};`,
      );
    }
    const fallback = (after.default ?? "").trim();
    if ((before.default ?? "").trim() !== fallback) {
      statements.push(dropDefault(path, tableName, table, after.name));
      if (fallback !== "") {
        const constraint = name(defaultName(tableName, after.name));
        statements.push(
          `ALTER TABLE ${table} ADD CONSTRAINT ${constraint} DEFAULT ${fallback} FOR ${name(after.name)};`,
        );
      }
    }
    if ((before.comment ?? "") !== (after.comment ?? ""))
      statements.push(...comment(path, tableName, after.name, after.comment));
    return statements;
  }

  function alterTable(path: readonly string[], design: TableDesign, context: DdlContext): DdlScript {
    validateDesign(design);
    const current = context.current;
    if (current === null) throw designError("The table is not described; synchronize the data source and try again.");
    const difference = tableDifference(current, design);
    if (unchanged(difference)) return ddlScript([], { transactional: true, notes: [NOTHING_TO_CHANGE] });
    const table = context.qualifiedName(path, current.name);
    const alter = (clause: string): string => `ALTER TABLE ${table} ${clause};`;
    const statements = [
      ...difference.droppedForeignKeys.map((key) => alter(`DROP CONSTRAINT ${name(key.name)}`)),
      ...difference.droppedChecks.map((entry) => alter(`DROP CONSTRAINT ${name(entry.name)}`)),
      ...difference.droppedIndexes.map((index) => `DROP INDEX ${name(index.name)} ON ${table};`),
      ...(difference.primaryKeyChanged && current.primaryKeyName !== null
        ? [alter(`DROP CONSTRAINT ${name(current.primaryKeyName)}`)]
        : []),
      ...difference.droppedColumns.flatMap((column) => [
        dropDefault(path, current.name, table, column.name),
        alter(`DROP COLUMN ${name(column.name)}`),
      ]),
      ...difference.changedColumns.flatMap(({ before, after }) =>
        alterColumn(path, current.name, table, before, after),
      ),
      ...difference.addedColumns.flatMap((column) => [
        alter(`ADD ${columnDefinition(current.name, column)}`),
        ...comment(path, current.name, column.name, column.comment, false),
      ]),
      ...(difference.primaryKeyChanged && design.primaryKey.length > 0
        ? [alter(`ADD PRIMARY KEY (${columns(design.primaryKey)})`)]
        : []),
      ...difference.addedChecks.map((entry) => alter(`ADD ${check(entry)}`)),
      ...difference.addedForeignKeys.map((key) => alter(`ADD ${foreignKey(key)}`)),
      ...difference.addedIndexes.map((index) => createIndex(index, table)),
      ...(difference.commentChanged ? comment(path, current.name, null, design.comment) : []),
      ...(difference.renamedTo === null
        ? []
        : [
            `${procedure(path, "sp_rename")} ${nationalText(local(path, current.name))}, ${nationalText(difference.renamedTo)};`,
          ]),
    ];
    return ddlScript(statements, { transactional: true });
  }

  function script(change: ObjectChange, context: DdlContext): DdlScript {
    switch (change.kind) {
      case "createTable":
        return createTable(change.path, change.design, context);
      case "alterTable":
        return alterTable(change.path, change.design, context);
      case "rename": {
        if (change.name.trim() === "") throw designError("Type the new name.");
        const target = nationalText(local(change.path, change.object.name));
        return ddlScript([`${procedure(change.path, "sp_rename")} ${target}, ${nationalText(change.name)};`], {
          transactional: true,
        });
      }
      case "drop": {
        const keyword = KEYWORDS[change.object.kind];
        if (keyword === undefined) throw designError("SQL Server has no such object to drop.");
        const statement = DROPPED_INSIDE.has(change.object.kind)
          ? `${inside(change.path, `DROP ${keyword} ${local(change.path, change.object.name)}`)};`
          : `DROP ${keyword} ${context.qualifiedName(change.path, change.object.name)};`;
        return ddlScript([statement], { transactional: true });
      }
      case "truncate":
        return ddlScript([`TRUNCATE TABLE ${context.qualifiedName(change.path, change.relation)};`], {
          transactional: true,
        });
      case "createNamespace":
        if (change.name.trim() === "") throw designError("Name the schema.");
        return ddlScript([`${inside(change.path, `CREATE SCHEMA ${quoteIdentifier(change.name)}`)};`], {
          transactional: true,
        });
    }
  }

  return {
    features: {
      types: TYPES,
      checks: true,
      comments: true,
      cascade: false,
      truncate: true,
      namespaceKind: "schema",
      renamable: KINDS,
      droppable: KINDS,
    },
    design: (relation) => tableDesignOf(relation),
    script,
  };
}
