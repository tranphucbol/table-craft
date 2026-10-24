import { RangeSet, StateEffect, StateField, type ChangeDesc, type Extension, type Text } from "@codemirror/state";
import { Decoration, EditorView, gutter, GutterMarker, hoverTooltip, type DecorationSet } from "@codemirror/view";
import {
  ERROR_GUTTER_CLASS,
  ERROR_GUTTER_MARKER_CLASS,
  ERROR_HINT_CLASS,
  ERROR_MARK_CLASS,
  ERROR_TOOLTIP_CLASS,
} from "@table-craft/desktop/renderer/console/editorTheme.js";
import type { ErrorMark } from "@table-craft/desktop/renderer/model/errorLocation.js";

/** Replaces the editor's error marks with the console's (decision 082). */
export const setErrorMarks = StateEffect.define<readonly ErrorMark[]>();

interface MarksState {
  readonly marks: readonly ErrorMark[];
  readonly decorations: DecorationSet;
}

const NO_MARKS: MarksState = { marks: [], decorations: Decoration.none };

function touches(mark: ErrorMark, changes: ChangeDesc): boolean {
  let touched = false;
  changes.iterChangedRanges((from, to) => {
    if (from <= mark.statementTo && to >= mark.statementFrom) touched = true;
  });
  return touched;
}

/**
 * The marks after an edit: each moves with its text, and one whose statement the edit touched is
 * dropped, since what the database said about that statement no longer holds.
 */
export function movedMarks(marks: readonly ErrorMark[], changes: ChangeDesc): readonly ErrorMark[] {
  if (changes.empty || marks.length === 0) return marks;
  return marks
    .filter((mark) => !touches(mark, changes))
    .map((mark) => ({
      ...mark,
      from: changes.mapPos(mark.from),
      to: changes.mapPos(mark.to),
      statementFrom: changes.mapPos(mark.statementFrom),
      statementTo: changes.mapPos(mark.statementTo),
    }));
}

function decorationsOf(marks: readonly ErrorMark[], doc: Text): DecorationSet {
  const ranges = marks
    .filter((mark) => mark.from < mark.to && mark.to <= doc.length)
    .map((mark) =>
      Decoration.mark({ class: ERROR_MARK_CLASS, attributes: { "data-error": mark.message } }).range(
        mark.from,
        mark.to,
      ),
    );
  return Decoration.set(ranges, true);
}

const marksField = StateField.define<MarksState>({
  create: () => NO_MARKS,
  update(value, transaction) {
    let marks = movedMarks(value.marks, transaction.changes);
    for (const effect of transaction.effects) if (effect.is(setErrorMarks)) marks = effect.value;
    if (marks === value.marks && !transaction.docChanged) return value;
    return { marks, decorations: decorationsOf(marks, transaction.state.doc) };
  },
  provide: (field) => EditorView.decorations.from(field, (state) => state.decorations),
});

/** The marks as the editor holds them now. */
export function errorMarksOf(view: EditorView): readonly ErrorMark[] {
  return view.state.field(marksField).marks;
}

/** Whether `update` moved or dropped marks by editing the text, so the console should hear of it. */
export function marksChanged(update: {
  readonly docChanged: boolean;
  readonly state: EditorView["state"];
  readonly startState: EditorView["state"];
}): boolean {
  return update.docChanged && update.state.field(marksField).marks !== update.startState.field(marksField).marks;
}

class ErrorGutterMarker extends GutterMarker {
  constructor(private readonly message: string) {
    super();
  }

  override eq(other: GutterMarker): boolean {
    return other instanceof ErrorGutterMarker && other.message === this.message;
  }

  override toDOM(): Node {
    const dot = document.createElement("span");
    dot.className = ERROR_GUTTER_MARKER_CLASS;
    dot.title = this.message;
    return dot;
  }
}

const errorGutter = gutter({
  class: ERROR_GUTTER_CLASS,
  markers(view) {
    const { doc } = view.state;
    const lines = new Map<number, string>();
    for (const mark of errorMarksOf(view)) {
      if (mark.from > doc.length) continue;
      const line = doc.lineAt(mark.from).from;
      if (!lines.has(line)) lines.set(line, mark.message);
    }
    return RangeSet.of(
      [...lines].map(([line, message]) => new ErrorGutterMarker(message).range(line)),
      true,
    );
  },
});

const errorTooltip = hoverTooltip((view, pos) => {
  const mark = errorMarksOf(view).find((candidate) => candidate.from <= pos && pos <= candidate.to);
  if (mark === undefined) return null;
  return {
    pos: mark.from,
    end: mark.to,
    above: true,
    create() {
      const dom = document.createElement("div");
      dom.className = ERROR_TOOLTIP_CLASS;
      const message = dom.appendChild(document.createElement("div"));
      message.textContent = mark.message;
      if (mark.hint !== "") {
        const hint = dom.appendChild(document.createElement("div"));
        hint.className = ERROR_HINT_CLASS;
        hint.textContent = mark.hint;
      }
      return { dom };
    },
  };
});

/** The wavy underline, gutter dot and hover message of each failed statement's error (decision 082). */
export const errorMarks: Extension = [marksField, errorGutter, errorTooltip];
