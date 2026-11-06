import type { AgentEdit, AgentEditRefusal } from "@table-craft/desktop/settings/mcp.js";

export interface TextChange {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

export type AgentEditOutcome =
  | {
      readonly ok: true;
      readonly text: string;
      /** One change from the first edited offset to the last, so the view and the store agree. */
      readonly change: TextChange;
      readonly selection: { readonly from: number; readonly to: number };
    }
  | { readonly ok: false; readonly reason: AgentEditRefusal; readonly index: number | null; readonly matches: number };

function occurrences(text: string, part: string): number[] {
  const found: number[] = [];
  for (let at = text.indexOf(part); at !== -1; at = text.indexOf(part, at + 1)) found.push(at);
  return found;
}

function changeBetween(before: string, after: string): TextChange {
  const shorter = Math.min(before.length, after.length);
  let start = 0;
  while (start < shorter && before[start] === after[start]) start += 1;
  let end = 0;
  while (end < shorter - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end += 1;
  return { from: start, to: before.length - end, insert: after.slice(start, after.length - end) };
}

function replaced(
  text: string,
  edits: Extract<AgentEdit, { kind: "replace" }>["edits"],
): { readonly text: string; readonly caret: number } | AgentEditOutcome {
  let current = text;
  let caret = 0;
  for (const [index, edit] of edits.entries()) {
    const found = occurrences(current, edit.oldText);
    if (found.length === 0) return { ok: false, reason: "notFound", index, matches: 0 };
    if (found.length > 1) return { ok: false, reason: "ambiguous", index, matches: found.length };
    const at = found[0] ?? 0;
    current = current.slice(0, at) + edit.newText + current.slice(at + edit.oldText.length);
    caret = at + edit.newText.length;
  }
  return { text: current, caret };
}

/**
 * Applies an agent's edit to a console's text (plan 156): each `oldText` must occur exactly once in
 * the text the edits before it left, and a whole replace must name the current revision. Nothing
 * changes unless every edit applies. `select` must occur exactly once in the result and is selected;
 * without it the caret goes after the last edit.
 */
export function applyAgentEdit(
  text: string,
  revision: number,
  edit: AgentEdit,
  select: string | null,
): AgentEditOutcome {
  let next: string;
  let caret: number;
  if (edit.kind === "whole") {
    if (edit.revision !== revision) return { ok: false, reason: "stale", index: null, matches: 0 };
    next = edit.text;
    caret = next.length;
  } else {
    const result = replaced(text, edit.edits);
    if ("ok" in result) return result;
    next = result.text;
    caret = result.caret;
  }
  let selection = { from: caret, to: caret };
  if (select !== null) {
    const found = occurrences(next, select);
    const [at] = found;
    if (found.length !== 1 || at === undefined)
      return { ok: false, reason: "selectNotFound", index: null, matches: found.length };
    selection = { from: at, to: at + select.length };
  }
  return { ok: true, text: next, change: changeBetween(text, next), selection };
}
