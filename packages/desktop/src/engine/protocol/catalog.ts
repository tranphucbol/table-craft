/** Mirrors `Namespace` in plugin-api. */
export interface Namespace {
  readonly path: readonly string[];
  readonly name: string;
  readonly kind: "database" | "schema";
  readonly system: boolean;
  readonly current: boolean;
}

/** Mirrors `ColumnMeta` in plugin-api. */
export interface ColumnMeta {
  readonly name: string;
  readonly position: number;
  readonly type: string;
  readonly nullable: boolean;
  readonly default: string | null;
  readonly comment: string | null;
  readonly autoIncrement: boolean;
}

/** Mirrors `Key` in plugin-api. */
export interface Key {
  readonly name: string;
  readonly columns: readonly string[];
}

/** Mirrors `ForeignKey` in plugin-api. */
export interface ForeignKey {
  readonly name: string;
  readonly columns: readonly string[];
  readonly target: {
    readonly path: readonly string[];
    readonly relation: string;
    readonly columns: readonly string[];
  };
  readonly onDelete: string;
  readonly onUpdate: string;
}

/** Mirrors `Index` in plugin-api. */
export interface Index {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
  readonly primary: boolean;
}

/** Mirrors `RelationKind` in plugin-api. */
export type RelationKind = "table" | "view" | "materializedView";

/** Mirrors `Relation` in plugin-api. */
export interface Relation {
  readonly name: string;
  readonly kind: RelationKind;
  readonly comment: string | null;
  readonly columns: readonly ColumnMeta[];
  readonly primaryKey: Key | null;
  readonly uniqueKeys: readonly Key[];
  readonly foreignKeys: readonly ForeignKey[];
  readonly indexes: readonly Index[];
}

/** Mirrors `Routine` in plugin-api. */
export interface Routine {
  readonly name: string;
  readonly kind: "function" | "procedure";
  readonly signature: string;
  readonly parameters: readonly RoutineParameter[];
  readonly returns: string | null;
}

/** Mirrors `RoutineArgument` in plugin-api: a parameter's value, or its default (decision 090). */
export type RoutineArgument = { readonly kind: "value"; readonly value: string | null } | { readonly kind: "default" };

/** Mirrors `RoutineCall` in plugin-api: console text and the value of each `:marker` in it. */
export interface RoutineCall {
  readonly sql: string;
  readonly params: Readonly<Record<string, string | null>>;
}

/** Mirrors `RoutineParameter` in plugin-api. */
export interface RoutineParameter {
  readonly name: string | null;
  readonly type: string;
  readonly mode: "in" | "out" | "inout" | "variadic";
  readonly hasDefault: boolean;
}

/** Mirrors `Sequence` in plugin-api. */
export interface Sequence {
  readonly name: string;
}

/** Mirrors `NamespaceCatalog` in plugin-api. */
export interface NamespaceCatalog {
  readonly path: readonly string[];
  readonly relations: readonly Relation[];
  readonly routines: readonly Routine[];
  readonly sequences: readonly Sequence[];
}

/** Mirrors `CachedCatalog` in core: a catalog and when, and how fast, it was read. */
export interface DescribedCatalog {
  readonly catalog: NamespaceCatalog;
  /** Epoch milliseconds. */
  readonly introspectedAt: number;
  readonly elapsedMs: number;
}

/** Mirrors `COMPLETION_KINDS` in plugin-api. */
export const COMPLETION_KINDS = [
  "namespace",
  "table",
  "view",
  "column",
  "alias",
  "cte",
  "join",
  "function",
  "keyword",
] as const;

export type CompletionKind = (typeof COMPLETION_KINDS)[number];

/** Mirrors `CompletionItem` in plugin-api. */
export interface CompletionItem {
  readonly label: string;
  readonly kind: CompletionKind;
  readonly detail: string | null;
  readonly apply: string;
  readonly boost: number;
  readonly info: string | null;
  /** Where the caret lands, as an offset into `apply`; null for its end. */
  readonly caret: number | null;
}

/** Mirrors `FunctionParameter` in plugin-api. */
export interface FunctionParameter {
  readonly name: string;
  readonly optional?: boolean;
  readonly variadic?: boolean;
  /** The keyword written before it instead of a comma, such as `FROM`. */
  readonly lead?: string;
}

/** Mirrors `FunctionSignature` in plugin-api. */
export interface FunctionSignature {
  readonly parameters: readonly FunctionParameter[];
  readonly returns: string;
}

/** Mirrors `SignatureHelp` in plugin-api: the call around the caret and the argument it is at. */
export interface SignatureHelp {
  readonly name: string;
  readonly summary: string;
  readonly signatures: readonly FunctionSignature[];
  readonly argument: number;
  readonly from: number;
  readonly to: number;
}

/** Mirrors `CompletionScope` in plugin-api: the table a clause body is written against. */
export interface CompletionScope {
  readonly path: readonly string[];
  readonly relation: string;
}

/** Mirrors `CompletionResult` in plugin-api. */
export interface CompletionResult {
  readonly from: number;
  readonly to: number;
  readonly items: readonly CompletionItem[];
  /** A regular expression source the editor may keep filtering with; null to ask on every keystroke. */
  readonly validFor: string | null;
}

/** Mirrors `Declaration` in plugin-api. */
export type Declaration =
  | { readonly kind: "alias" | "cte"; readonly from: number; readonly to: number }
  | { readonly kind: "relation"; readonly path: readonly string[]; readonly relation: string }
  | { readonly kind: "column"; readonly path: readonly string[]; readonly relation: string; readonly column: string };
