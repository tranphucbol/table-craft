import type { Reconnection } from "./sessions.js";
import type { ServerMessage } from "./wire.js";

/** What the SQL Generator writes: `create` is the relation's definition, the rest mirror `GeneratedStatement` in plugin-api. */
export type GeneratorStatement = "create" | "drop" | "select" | "insert" | "update";

/** Mirrors `StatementKind` in plugin-api. */
export type StatementKind = "read" | "write" | "ddl" | "transaction" | "other";

/** Mirrors `ParameterStyle` in plugin-api. */
export type ParameterStyle = "named" | "numbered" | "positional";

/** Mirrors `SqlParameter` in plugin-api: a placeholder, in offsets into its statement's `sql`. */
export interface StatementParameter {
  readonly name: string;
  readonly from: number;
  readonly to: number;
  readonly style: ParameterStyle;
}

/** Mirrors `ParameterValue` in plugin-api: text the server casts, or SQL NULL (decision 043). */
export type ParameterValue = string | null;

/** One statement of a script: its span in UTF-16 offsets, as the plugin split it, and its class. */
export interface ClassifiedStatement {
  readonly from: number;
  readonly to: number;
  readonly sql: string;
  /** Mirrors `StatementSpan.repeat`: SQL Server's `GO 3` count, which `statement.execute` passes on. */
  readonly repeat?: number;
  readonly kind: StatementKind;
  /** Why the console asks before running it, such as `DELETE without WHERE`; null when it need not. */
  readonly destructive: string | null;
  /** Why the command may weigh on the server; the editor marks it, nothing blocks it (decision 112). */
  readonly costly?: string | null;
  /** Confirming it asks for the datasource's name (decision 112). */
  readonly confirmByName?: boolean;
  /** The placeholders the plugin finds in `sql`, in order. */
  readonly parameters: readonly StatementParameter[];
}

/** Mirrors `KEYWORD_CASES` in plugin-api. */
export const KEYWORD_CASES = ["upper", "lower", "preserve"] as const;

export type KeywordCase = (typeof KEYWORD_CASES)[number];

/** Mirrors `FORMAT_STYLES` in plugin-api. */
export const FORMAT_STYLES = ["aligned", "standard"] as const;

export type FormatStyle = (typeof FORMAT_STYLES)[number];

/** Mirrors `FormatOptions` in plugin-api (decisions 042, 061). */
export interface FormatOptions {
  readonly style: FormatStyle;
  readonly keywordCase: KeywordCase;
  readonly indentWidth: number;
  readonly linesBetweenStatements: number;
  readonly alignAliases: boolean;
}

/** Mirrors `Explainability` in plugin-api. */
export type Explainability =
  { readonly ok: true; readonly writes: boolean } | { readonly ok: false; readonly reason: string };

/** Mirrors `PlanProperty` in plugin-api. */
export interface PlanProperty {
  readonly name: string;
  readonly value: string;
}

/** Mirrors `PlanNode` in plugin-api: one operator of the plan, numbers or null where the dialect says nothing. */
export interface PlanNode {
  readonly operation: string;
  readonly target: string | null;
  readonly detail: string | null;
  readonly estimatedRows: number | null;
  readonly estimatedCost: number | null;
  readonly actualRows: number | null;
  readonly actualTimeMs: number | null;
  readonly loops: number | null;
  readonly properties: readonly PlanProperty[];
  readonly children: readonly PlanNode[];
}

/** Mirrors `ExplainedPlan` in plugin-api. */
export interface ExplainedPlan {
  /** The EXPLAIN statement the plugin sent. */
  readonly statement: string;
  readonly analyzed: boolean;
  readonly roots: readonly PlanNode[];
  readonly summary: readonly PlanProperty[];
  /** What the database printed, for the Raw view. */
  readonly raw: string;
  readonly messages?: readonly ServerMessage[];
}

export interface ExplainedStatement {
  readonly plan: ExplainedPlan;
  /** Whether the session's transaction is open after the explain, as `ExecutedStatement` reports it. */
  readonly transactionOpen: boolean;
  readonly reconnected?: Reconnection;
}
