/**
 * A database or schema: the unit the explorer lists, introspects and caches (decision 022).
 * `path` names it from the server down, such as `["table_craft", "public"]` on PostgreSQL.
 */
export interface Namespace {
  readonly path: readonly string[];
  readonly name: string;
  readonly kind: "database" | "schema";
  /** The database's own catalog, such as `pg_catalog`; hidden unless the user asks. */
  readonly system: boolean;
  /** Where unqualified names resolve for this connection. */
  readonly current: boolean;
}

export interface ColumnMeta {
  readonly name: string;
  /** 1-based, in table order. */
  readonly position: number;
  /** The type as the database spells it, such as `numeric(12,2)`. */
  readonly type: string;
  readonly nullable: boolean;
  /** The default expression as the database prints it; null when there is none. */
  readonly default: string | null;
  readonly comment: string | null;
  readonly autoIncrement: boolean;
}

export interface Key {
  readonly name: string;
  readonly columns: readonly string[];
}

export interface ForeignKey {
  readonly name: string;
  readonly columns: readonly string[];
  readonly target: {
    readonly path: readonly string[];
    readonly relation: string;
    readonly columns: readonly string[];
  };
  /** The referential action as SQL spells it, such as `CASCADE` or `NO ACTION`. */
  readonly onDelete: string;
  readonly onUpdate: string;
}

export interface Index {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
  readonly primary: boolean;
}

export type RelationKind = "table" | "view" | "materializedView";

export interface Relation {
  readonly name: string;
  readonly kind: RelationKind;
  readonly comment: string | null;
  /** Ordered by position. */
  readonly columns: readonly ColumnMeta[];
  readonly primaryKey: Key | null;
  readonly uniqueKeys: readonly Key[];
  readonly foreignKeys: readonly ForeignKey[];
  readonly indexes: readonly Index[];
}

export const ROUTINE_PARAMETER_MODES = ["in", "out", "inout", "variadic"] as const;
export type RoutineParameterMode = (typeof ROUTINE_PARAMETER_MODES)[number];

export interface RoutineParameter {
  /** Null when the database records none, as PostgreSQL allows. */
  readonly name: string | null;
  /** As the database prints it, `numeric` or `decimal(12,2)`. */
  readonly type: string;
  readonly mode: RoutineParameterMode;
  readonly hasDefault: boolean;
}

/** Name, kind and signature are unique in a namespace; PostgreSQL overloads are separate routines. */
export interface Routine {
  readonly name: string;
  readonly kind: "function" | "procedure";
  /** The argument list as the database prints it, without parentheses. */
  readonly signature: string;
  /** In declaration order; a function's result and `RETURNS TABLE` columns are not parameters. */
  readonly parameters: readonly RoutineParameter[];
  /** A function's result as the database prints it; null for a procedure. */
  readonly returns: string | null;
}

export interface Sequence {
  readonly name: string;
}

/** Everything one `describe` returns; every list but `columns` is sorted by name. */
export interface NamespaceCatalog {
  readonly path: readonly string[];
  readonly relations: readonly Relation[];
  readonly routines: readonly Routine[];
  readonly sequences: readonly Sequence[];
}

/** Present on a session exactly when the plugin declares `schemaTree`. */
export interface Introspector {
  /** Every namespace the connection can see, system ones included and marked. */
  namespaces(): Promise<readonly Namespace[]>;
  /**
   * Rejects with a `PluginError` coded `introspectionFailed` when the namespace does not exist
   * or the user cannot read it.
   */
  describe(path: readonly string[]): Promise<NamespaceCatalog>;
  /** `name` inside `path`, quoted the way this database quotes identifiers. */
  qualifiedName(path: readonly string[], name: string): string;
  /**
   * Present exactly when the plugin declares `ddl` (decision 029). The statements that create
   * relation `name` in `path`, read from the database on every call: each ends in `;` and a blank
   * line separates them. Rejects with `DefinitionNotFoundError` when there is no such relation.
   */
  definition?(path: readonly string[], name: string): Promise<string>;
}

/** Sorts by `name`, the order every catalog list but columns is returned in. */
export function byName<T extends { readonly name: string }>(items: Iterable<T>): T[] {
  return [...items].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}
