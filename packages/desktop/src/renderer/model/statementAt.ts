/** A range of the console's text in UTF-16 offsets, as CodeMirror and the splitter count them. */
export interface TextSpan {
  readonly from: number;
  readonly to: number;
}

/** Run (⌘↵) resolves against the caret or selection; Run All (⇧⌘↵) takes every statement. */
export type RunScope = "caret" | "all";

export type RunTarget<S extends TextSpan> =
  | { readonly kind: "statements"; readonly statements: readonly S[] }
  /** A non-empty selection: run exactly the selected text, whatever statements it touches. */
  | { readonly kind: "selection"; readonly from: number; readonly to: number }
  | { readonly kind: "nothing" };

const NOTHING = { kind: "nothing" } as const;

function atCaret<S extends TextSpan>(statements: readonly S[], caret: number): S | undefined {
  const containing = statements.find((statement) => statement.from <= caret && caret <= statement.to);
  if (containing !== undefined) return containing;
  const before = statements.filter((statement) => statement.to <= caret).at(-1);
  return before ?? statements[0];
}

/**
 * The text Run executes on its own (plan 113, decision 1): a non-empty selection under Run, as a
 * forward span. Null for a bare caret or Run All, which resolve against the console's statements.
 */
export function selectionToRun(selection: TextSpan, scope: RunScope): TextSpan | null {
  if (scope === "all" || selection.from === selection.to) return null;
  return { from: Math.min(selection.from, selection.to), to: Math.max(selection.from, selection.to) };
}

/**
 * What Run executes (plans 006 and 113). A selection runs exactly the selected text. With no
 * selection, the statement at the caret; in the whitespace or comments between two, the one before;
 * before the first, the first. Run All takes every statement and ignores the selection.
 */
export function statementsToRun<S extends TextSpan>(
  statements: readonly S[],
  selection: TextSpan,
  scope: RunScope,
): RunTarget<S> {
  const selected = selectionToRun(selection, scope);
  if (selected !== null) return { kind: "selection", ...selected };
  if (statements.length === 0) return NOTHING;
  if (scope === "all") return { kind: "statements", statements };
  const statement = atCaret(statements, selection.from);
  return statement === undefined ? NOTHING : { kind: "statements", statements: [statement] };
}
