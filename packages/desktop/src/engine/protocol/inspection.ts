/** Mirrors `PROBLEM_SEVERITIES` in plugin-api (plan 108). */
export const PROBLEM_SEVERITIES = ["error", "warning", "weak"] as const;
export type ProblemSeverity = (typeof PROBLEM_SEVERITIES)[number];

/** Mirrors `INSPECTION_IDS` in plugin-api. */
export const INSPECTION_IDS = [
  "SqlSyntax",
  "SqlResolve",
  "SqlAmbiguousColumn",
  "SqlReservedWordAsName",
  "SqlInsertValues",
  "SqlWithoutWhere",
  "SqlNullComparison",
  "SqlConstantCondition",
  "SqlUnusedCte",
  "SqlDuplicateAlias",
  "SqlRedundantOrderingDirection",
  "SqlRedundantAlias",
  "SqlRedundantElseNull",
] as const;
export type InspectionId = (typeof INSPECTION_IDS)[number];

/** Mirrors `TextEdit` in plugin-api. */
export interface TextEdit {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

/** Mirrors `QuickFix` in plugin-api. */
export interface QuickFix {
  readonly title: string;
  readonly edits: readonly TextEdit[];
  readonly caret?: number;
}

/** Mirrors `Problem` in plugin-api. */
export interface Problem {
  readonly from: number;
  readonly to: number;
  readonly severity: ProblemSeverity;
  readonly inspection: string;
  readonly message: string;
  readonly fixes: readonly QuickFix[];
}
