import {
  ChangeSet,
  RangeSet,
  StateEffect,
  StateField,
  type ChangeDesc,
  type EditorState,
  type Extension,
  type Text,
  type TransactionSpec,
} from "@codemirror/state";
import { Decoration, EditorView, gutter, GutterMarker, type DecorationSet } from "@codemirror/view";
import type { Problem, ProblemSeverity, QuickFix, TextEdit } from "@table-craft/desktop/engine/protocol.js";
import {
  ERROR_GUTTER_CLASS,
  ERROR_GUTTER_MARKER_CLASS,
  PROBLEM_MARK_CLASSES,
  WARNING_GUTTER_MARKER_CLASS,
} from "@table-craft/desktop/renderer/console/editorTheme.js";
import { errorMarksField, errorMarksIn } from "@table-craft/desktop/renderer/console/errorMarks.js";
import type { ErrorMark } from "@table-craft/desktop/renderer/model/errorLocation.js";
import type { TextSpan } from "@table-craft/desktop/renderer/model/statementAt.js";

/** Replaces the live problems with an answer for the editor's current text (plan 108 decision 4). */
export const setProblems = StateEffect.define<readonly Problem[]>();

/** Drops one inspection's problems inside a span, as a suppression or a disabled inspection does at once. */
export const dropProblems = StateEffect.define<{ readonly inspection: string; readonly span: TextSpan }>();

interface ProblemsState {
  /** Ranges in the current text. */
  readonly problems: readonly Problem[];
  /**
   * The edits since the answer. Fixes keep the answer's offsets and are rebased over these only when
   * applied: a fix's caret is an offset into its own result, which no position mapping can carry.
   */
  readonly since: ChangeSet;
}

const NO_PROBLEMS: readonly Problem[] = [];

const SEVERITY_RANK: Readonly<Record<ProblemSeverity, number>> = { error: 0, warning: 1, weak: 2 };

/** Worst first, then in text order. */
export function bySeverity(left: Problem, right: Problem): number {
  return SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] || left.from - right.from;
}

function validEdits(edits: readonly TextEdit[], length: number): boolean {
  const sorted = [...edits].sort((a, b) => a.from - b.from);
  return sorted.every(
    (edit, index) =>
      Number.isInteger(edit.from) &&
      Number.isInteger(edit.to) &&
      edit.from >= 0 &&
      edit.from <= edit.to &&
      edit.to <= length &&
      edit.from >= (sorted[index - 1]?.to ?? 0),
  );
}

/** The answer's problems the text can hold; a fix whose edits fall outside the text, or overlap, is dropped. */
export function acceptedProblems(problems: readonly Problem[], length: number): readonly Problem[] {
  return problems
    .filter((problem) => problem.from >= 0 && problem.from <= problem.to && problem.to <= length)
    .map((problem) => ({ ...problem, fixes: problem.fixes.filter((fix) => validEdits(fix.edits, length)) }));
}

function touches(problem: TextSpan, changes: ChangeDesc): boolean {
  let touched = false;
  changes.iterChangedRanges((from, to) => {
    if (from <= problem.to && to >= problem.from) touched = true;
  });
  return touched;
}

/**
 * The problems after an edit: each moves with its text, and one whose range the edit touched is
 * dropped until the next answer, since what the plugin said about that text no longer holds.
 */
export function movedProblems(problems: readonly Problem[], changes: ChangeDesc): readonly Problem[] {
  if (changes.empty || problems.length === 0) return problems;
  return problems
    .filter((problem) => !touches(problem, changes))
    .map((problem) => ({ ...problem, from: changes.mapPos(problem.from), to: changes.mapPos(problem.to, -1) }));
}

const problemsField = StateField.define<ProblemsState>({
  create: (state) => ({ problems: NO_PROBLEMS, since: ChangeSet.empty(state.doc.length) }),
  update(value, transaction) {
    let next = value;
    if (transaction.docChanged) {
      next = {
        problems: movedProblems(value.problems, transaction.changes),
        since: value.since.compose(transaction.changes),
      };
    }
    for (const effect of transaction.effects) {
      if (effect.is(setProblems)) {
        const { length } = transaction.state.doc;
        next = { problems: acceptedProblems(effect.value, length), since: ChangeSet.empty(length) };
      } else if (effect.is(dropProblems)) {
        const { inspection, span } = effect.value;
        const kept = next.problems.filter(
          (problem) => problem.inspection !== inspection || problem.to < span.from || problem.from > span.to,
        );
        if (kept.length !== next.problems.length) next = { ...next, problems: kept };
      }
    }
    return next;
  },
});

/** Every live problem, in the current text's offsets, whether drawn or hidden under a server mark. */
export function problemsIn(state: EditorState): readonly Problem[] {
  return state.field(problemsField, false)?.problems ?? NO_PROBLEMS;
}

function overlapsMark(problem: TextSpan, mark: TextSpan): boolean {
  if (problem.from === problem.to) return mark.from <= problem.from && problem.from <= mark.to;
  return problem.from < mark.to && mark.from < problem.to;
}

/** The problems drawn: where the database already said what is wrong, its mark wins (plan 108 decision 4). */
export function visibleProblems(problems: readonly Problem[], marks: readonly ErrorMark[]): readonly Problem[] {
  if (marks.length === 0) return problems;
  return problems.filter((problem) => !marks.some((mark) => overlapsMark(problem, mark)));
}

export function visibleProblemsIn(state: EditorState): readonly Problem[] {
  return visibleProblems(problemsIn(state), errorMarksIn(state));
}

/**
 * Where a problem is drawn. An empty one, such as a missing `)` at the end, takes the character
 * after it, or before it at the end of the text, so the underline is never drawn on nothing.
 */
export function drawnSpan(problem: TextSpan, doc: Text): TextSpan {
  const to = Math.min(problem.to, doc.length);
  const from = Math.min(problem.from, to);
  if (from < to) return { from, to };
  const line = doc.lineAt(from);
  if (from < line.to) return { from, to: from + 1 };
  if (from > line.from) return { from: from - 1, to: from };
  return { from, to };
}

/** The visible problems covering `pos`, worst first. */
export function problemsAt(state: EditorState, pos: number): readonly Problem[] {
  return visibleProblemsIn(state)
    .filter((problem) => {
      const span = drawnSpan(problem, state.doc);
      return span.from <= pos && pos <= span.to;
    })
    .sort(bySeverity);
}

/**
 * What Alt+Enter offers fixes for: the problems under the caret, or else those on its line, nearest
 * first, as IntelliJ does when the caret sits beside a highlighted problem.
 */
export function problemsNear(state: EditorState, pos: number): readonly Problem[] {
  const under = problemsAt(state, pos);
  if (under.length > 0) return under;
  const line = state.doc.lineAt(pos);
  const distance = (problem: Problem) => Math.min(Math.abs(problem.from - pos), Math.abs(problem.to - pos));
  return visibleProblemsIn(state)
    .filter((problem) => problem.from <= line.to && problem.to >= line.from)
    .sort((left, right) => distance(left) - distance(right) || bySeverity(left, right));
}

/**
 * Where F2 goes: server marks and live errors; with none, live warnings (plan 108 decision 5).
 * Weak problems are never visited, as DataGrip's Next Highlighted Error skips them.
 */
export function problemStops(marks: readonly ErrorMark[], problems: readonly Problem[]): readonly TextSpan[] {
  const errors = [...marks, ...problems.filter((problem) => problem.severity === "error")];
  const stops = errors.length > 0 ? errors : problems.filter((problem) => problem.severity === "warning");
  return stops.map(({ from, to }) => ({ from, to }));
}

/** The next stop after the caret, or before it going backward, wrapping round; null with none. */
export function nextStop(stops: readonly TextSpan[], caret: number, backward: boolean): TextSpan | null {
  const sorted = [...stops].sort((a, b) => a.from - b.from);
  if (backward) return sorted.filter((stop) => stop.from < caret).at(-1) ?? sorted.at(-1) ?? null;
  return sorted.find((stop) => stop.from > caret) ?? sorted[0] ?? null;
}

/** Where F2 goes in `state`, from its caret. */
export function nextProblemIn(state: EditorState, backward: boolean): TextSpan | null {
  const { from, to } = state.selection.main;
  return nextStop(problemStops(errorMarksIn(state), visibleProblemsIn(state)), backward ? from : to, backward);
}

/**
 * The transaction applying `fix`, its edits rebased over what was typed since the answer, as one
 * undo step; the caret goes where the fix says.
 */
export function fixTransaction(state: EditorState, fix: QuickFix): TransactionSpec | null {
  const since = state.field(problemsField, false)?.since ?? ChangeSet.empty(state.doc.length);
  if (!validEdits(fix.edits, since.length)) return null;
  const original = ChangeSet.of(
    fix.edits.map(({ from, to, insert }) => ({ from, to, insert })),
    since.length,
  );
  const changes = original.map(since);
  // Without a caret of its own, one inside a replaced name goes after the replacement, as in DataGrip,
  // not back to where the name began.
  const selection =
    fix.caret === undefined
      ? state.selection.map(changes, 1)
      : { anchor: since.map(original).mapPos(Math.min(fix.caret, original.newLength)) };
  return {
    changes,
    selection,
    scrollIntoView: true,
    userEvent: "input.fix",
  };
}

const PROBLEM_DECORATIONS: Readonly<Record<ProblemSeverity, Decoration>> = {
  error: Decoration.mark({ class: PROBLEM_MARK_CLASSES.error }),
  warning: Decoration.mark({ class: PROBLEM_MARK_CLASSES.warning }),
  weak: Decoration.mark({ class: PROBLEM_MARK_CLASSES.weak }),
};

function decorationsOf(state: EditorState): DecorationSet {
  const ranges = visibleProblemsIn(state).flatMap((problem) => {
    const span = drawnSpan(problem, state.doc);
    return span.from < span.to ? [PROBLEM_DECORATIONS[problem.severity].range(span.from, span.to)] : [];
  });
  return Decoration.set(ranges, true);
}

const problemDecorations = EditorView.decorations.compute([problemsField, errorMarksField], decorationsOf);

type GutterSeverity = Exclude<ProblemSeverity, "weak">;

const GUTTER_MARKER_CLASSES: Readonly<Record<GutterSeverity, string>> = {
  error: ERROR_GUTTER_MARKER_CLASS,
  warning: WARNING_GUTTER_MARKER_CLASS,
};

class ProblemGutterMarker extends GutterMarker {
  constructor(
    private readonly severity: GutterSeverity,
    private readonly message: string,
  ) {
    super();
  }

  override eq(other: GutterMarker): boolean {
    return other instanceof ProblemGutterMarker && other.severity === this.severity && other.message === this.message;
  }

  override toDOM(): Node {
    const dot = document.createElement("span");
    dot.className = GUTTER_MARKER_CLASSES[this.severity];
    dot.title = this.message;
    return dot;
  }
}

interface LineMark {
  readonly severity: GutterSeverity;
  readonly messages: readonly string[];
}

/**
 * Each line's worst severity and its messages, worst first: server marks count as errors, weak
 * problems not at all, since a dot for every redundant `ASC` would bury the ones that matter.
 */
export function lineMarks(
  doc: Text,
  marks: readonly ErrorMark[],
  problems: readonly Problem[],
): ReadonlyMap<number, LineMark> {
  const entries = [
    ...marks.map((mark) => ({ from: mark.from, severity: "error" as const, message: mark.message })),
    ...problems.flatMap((problem) =>
      problem.severity === "weak" ? [] : [{ from: problem.from, severity: problem.severity, message: problem.message }],
    ),
  ].sort((left, right) => SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity]);
  const lines = new Map<number, LineMark>();
  for (const entry of entries) {
    if (entry.from > doc.length) continue;
    const line = doc.lineAt(entry.from).from;
    const current = lines.get(line);
    lines.set(
      line,
      current === undefined
        ? { severity: entry.severity, messages: [entry.message] }
        : { ...current, messages: [...current.messages, entry.message] },
    );
  }
  return lines;
}

/**
 * Holds the column's width while no line has a dot: live problems come and go as you type, and a
 * column that collapsed with them would shift the text sideways at every keystroke.
 */
const GUTTER_SPACER = new ProblemGutterMarker("error", "");

const problemGutter = gutter({
  class: ERROR_GUTTER_CLASS,
  initialSpacer: () => GUTTER_SPACER,
  markers(view) {
    const { state } = view;
    const lines = lineMarks(state.doc, errorMarksIn(state), visibleProblemsIn(state));
    return RangeSet.of(
      [...lines].map(([line, mark]) => new ProblemGutterMarker(mark.severity, mark.messages.join("\n")).range(line)),
      true,
    );
  },
});

/**
 * The live problems' field and underlines, and the one gutter column they share with the server's
 * error marks, which must be installed beside it.
 */
export const inspections: Extension = [problemsField, problemDecorations, problemGutter];
