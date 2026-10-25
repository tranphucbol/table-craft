import { INSPECTION_IDS, type InspectionId } from "@table-craft/desktop/engine/protocol.js";

/** What the Settings dialog and the Alt+Enter popup call each inspection (plan 108). */
export const INSPECTION_NAMES: Readonly<Record<InspectionId, string>> = {
  SqlSyntax: "Syntax errors",
  SqlResolve: "Unresolved references",
  SqlAmbiguousColumn: "Ambiguous column references",
  SqlReservedWordAsName: "Reserved word used as a name",
  SqlInsertValues: "INSERT value count differs from its columns",
  SqlWithoutWhere: "DELETE or UPDATE without WHERE",
  SqlNullComparison: "Comparison with NULL",
  SqlConstantCondition: "Constant condition",
  SqlUnusedCte: "Unused common table expression",
  SqlDuplicateAlias: "Duplicate alias",
  SqlRedundantOrderingDirection: "Redundant ordering direction",
  SqlRedundantAlias: "Redundant alias",
  SqlRedundantElseNull: "Redundant ELSE NULL",
};

function isInspectionId(id: string): id is InspectionId {
  return (INSPECTION_IDS as readonly string[]).includes(id);
}

/** The readable name of `id`; a plugin's own inspection, which this build cannot name, shows its id. */
export function inspectionName(id: string): string {
  return isInspectionId(id) ? INSPECTION_NAMES[id] : id;
}
