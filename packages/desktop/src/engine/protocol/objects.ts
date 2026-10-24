/** Mirrors `OBJECT_KINDS` in plugin-api: what the tree can rename and drop. */
export const OBJECT_KINDS = ["table", "view", "materializedView", "sequence", "function", "procedure"] as const;

export type ObjectKind = (typeof OBJECT_KINDS)[number];

/** Mirrors `CatalogObject` in plugin-api. */
export interface CatalogObject {
  readonly kind: ObjectKind;
  readonly name: string;
}

/** Mirrors `ColumnDesign` in plugin-api. `original` is the column's name in the table, null when new. */
export interface ColumnDesign {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
  readonly default: string | null;
  readonly autoIncrement: boolean;
  readonly comment: string | null;
  readonly original: string | null;
}

/** Mirrors `IndexDesign` in plugin-api. */
export interface IndexDesign {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
  readonly original: string | null;
}

/** Mirrors `ForeignKeyDesign` in plugin-api. */
export interface ForeignKeyDesign {
  readonly name: string;
  readonly columns: readonly string[];
  readonly target: { readonly path: readonly string[]; readonly relation: string; readonly columns: readonly string[] };
  readonly onDelete: string | null;
  readonly onUpdate: string | null;
  readonly original: string | null;
}

/** Mirrors `CheckDesign` in plugin-api. */
export interface CheckDesign {
  readonly name: string;
  readonly expression: string;
  readonly original: string | null;
}

/** Mirrors `TableDesign` in plugin-api: what the Create and Modify Table dialog edits. */
export interface TableDesign {
  readonly name: string;
  readonly comment: string | null;
  readonly columns: readonly ColumnDesign[];
  readonly primaryKey: readonly string[];
  readonly primaryKeyName: string | null;
  readonly indexes: readonly IndexDesign[];
  readonly foreignKeys: readonly ForeignKeyDesign[];
  readonly checks: readonly CheckDesign[];
}

/** Mirrors `ObjectChange` in plugin-api: one change to the database's objects. */
export type ObjectChange =
  | { readonly kind: "createTable"; readonly path: readonly string[]; readonly design: TableDesign }
  | {
      readonly kind: "alterTable";
      readonly path: readonly string[];
      readonly relation: string;
      readonly design: TableDesign;
    }
  | {
      readonly kind: "rename";
      readonly path: readonly string[];
      readonly object: CatalogObject;
      readonly name: string;
    }
  | {
      readonly kind: "drop";
      readonly path: readonly string[];
      readonly object: CatalogObject;
      readonly cascade: boolean;
    }
  | {
      readonly kind: "truncate";
      readonly path: readonly string[];
      readonly relation: string;
      readonly cascade: boolean;
    }
  | { readonly kind: "createNamespace"; readonly path: readonly string[]; readonly name: string };

/** Mirrors `DdlScript` in plugin-api. */
export interface DdlScript {
  readonly prepare: readonly string[];
  readonly statements: readonly string[];
  readonly verify: readonly string[];
  readonly finish: readonly string[];
  readonly transactional: boolean;
  readonly notes: readonly string[];
}

/** Mirrors `ObjectFeatures` in plugin-api. */
export interface ObjectFeatures {
  readonly types: readonly string[];
  readonly checks: boolean;
  readonly comments: boolean;
  readonly cascade: boolean;
  readonly truncate: boolean;
  readonly namespaceKind: "schema" | "database" | null;
  readonly renamable: readonly ObjectKind[];
  readonly droppable: readonly ObjectKind[];
}

/** What `objects.apply` ran. */
export interface AppliedChange {
  readonly statements: number;
  readonly elapsedMs: number;
}
