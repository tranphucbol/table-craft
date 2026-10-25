import type { Problem, QuickFix, TextEdit } from "@table-craft/desktop/engine/protocol.js";
import { inspectionName } from "@table-craft/desktop/renderer/model/inspectionNames.js";

/** A row of the Alt+Enter popup (plan 108 decision 5). */
export type Intention =
  | { readonly kind: "fix"; readonly title: string; readonly problem: Problem; readonly fix: QuickFix }
  | { readonly kind: "suppress"; readonly title: string; readonly problem: Problem }
  | { readonly kind: "disable"; readonly title: string; readonly inspection: string };

/**
 * The popup's rows for `problems`, worst first: every fix, a repeated title once, then for each
 * inspection Suppress for Statement and Disable Inspection, as DataGrip offers under each fix.
 */
export function intentionsFor(problems: readonly Problem[]): readonly Intention[] {
  const titles = new Set<string>();
  const fixes = problems.flatMap((problem) =>
    problem.fixes.flatMap((fix): Intention[] => {
      if (titles.has(fix.title)) return [];
      titles.add(fix.title);
      return [{ kind: "fix", title: fix.title, problem, fix }];
    }),
  );
  const firstOf = new Map<string, Problem>();
  for (const problem of problems) if (!firstOf.has(problem.inspection)) firstOf.set(problem.inspection, problem);
  const named = firstOf.size > 1;
  const suppressions = [...firstOf].flatMap(([inspection, problem]): Intention[] => {
    const name = inspectionName(inspection);
    return [
      { kind: "suppress", title: named ? `Suppress '${name}' for statement` : "Suppress for statement", problem },
      { kind: "disable", title: `Disable inspection '${name}'`, inspection },
    ];
  });
  return [...fixes, ...suppressions];
}

/** DataGrip's suppression comment: `-- noinspection SqlResolve,SqlRedundantAlias` on the line above. */
const NOINSPECTION = /^([ \t]*--[ \t]*noinspection[ \t]+)([\w, \t]*\w)[ \t\r]*$/i;
const ID_SEPARATOR = /[\s,]+/;
const INDENT = /^[ \t]*/;

function lineStartOf(text: string, offset: number): number {
  return text.lastIndexOf("\n", offset - 1) + 1;
}

function lineEndOf(text: string, offset: number): number {
  const end = text.indexOf("\n", offset);
  return end < 0 ? text.length : end;
}

function addTo(text: string, lineStart: number, inspection: string): TextEdit | "present" | null {
  const match = NOINSPECTION.exec(text.slice(lineStart, lineEndOf(text, lineStart)));
  if (match === null) return null;
  const [, lead = "", ids = ""] = match;
  if (ids.split(ID_SEPARATOR).includes(inspection)) return "present";
  const at = lineStart + lead.length + ids.length;
  return { from: at, to: at, insert: `,${inspection}` };
}

/**
 * The edit silencing `inspection` for the statement starting at `statementFrom`: its id joins a
 * `noinspection` comment already on the statement's first line or the one above, or a new comment
 * goes above, indented as the statement is. Null when the comment already names it.
 */
export function suppressionEdit(text: string, statementFrom: number, inspection: string): TextEdit | null {
  const lineStart = lineStartOf(text, statementFrom);
  const candidates = lineStart > 0 ? [lineStart, lineStartOf(text, lineStart - 1)] : [lineStart];
  for (const candidate of candidates) {
    const edit = addTo(text, candidate, inspection);
    if (edit === "present") return null;
    if (edit !== null) return edit;
  }
  const indent = INDENT.exec(text.slice(lineStart))?.[0] ?? "";
  return { from: lineStart, to: lineStart, insert: `${indent}-- noinspection ${inspection}\n` };
}
