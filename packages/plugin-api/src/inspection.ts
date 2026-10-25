/** How loudly the console marks a problem (plan 108): red wavy, amber wavy, or muted dotted. */
export const PROBLEM_SEVERITIES = ["error", "warning", "weak"] as const;
export type ProblemSeverity = (typeof PROBLEM_SEVERITIES)[number];

/**
 * The inspections `sqlInspector` runs. The ids are DataGrip's, so a `-- noinspection <Id>` comment
 * written there silences the same check here.
 */
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

/** One replacement in the inspected text; offsets are UTF-16 indexes into `InspectionRequest.text`. */
export interface TextEdit {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

/** A fix the user can apply from Alt+Enter: its edits apply together, as one undo step. */
export interface QuickFix {
  readonly title: string;
  readonly edits: readonly TextEdit[];
  /** Where the caret goes after the edits, as an offset into the edited text; absent leaves it. */
  readonly caret?: number;
}

/** A problem found while typing, before anything runs. */
export interface Problem {
  readonly from: number;
  readonly to: number;
  readonly severity: ProblemSeverity;
  /** An `INSPECTION_IDS` entry, or a plugin's own id for a check it adds. */
  readonly inspection: string;
  readonly message: string;
  readonly fixes: readonly QuickFix[];
}

export interface InspectionRequest {
  /** The whole console text; problems cover every statement in it. */
  readonly text: string;
  /** Inspections the user turned off; the plugin skips them. */
  readonly disabled?: readonly string[];
}
