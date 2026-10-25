import { closeCompletion } from "@codemirror/autocomplete";
import { ChangeSet, Facet, Prec, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  closeHoverTooltips,
  EditorView,
  hoverTooltip,
  keymap,
  showTooltip,
  type Tooltip,
  type TooltipView,
  type ViewUpdate,
} from "@codemirror/view";
import type { Problem, QuickFix } from "@table-craft/desktop/engine/protocol.js";
import {
  INTENTION_CLASS,
  INTENTION_EMPTY_CLASS,
  INTENTION_GLYPH_CLASS,
  INTENTION_SEPARATOR_CLASS,
  INTENTIONS_CLASS,
  PROBLEM_CHORD_CLASS,
  PROBLEM_FIX_CLASS,
  PROBLEM_MESSAGE_CLASS,
  PROBLEM_TOOLTIP_CLASS,
} from "@table-craft/desktop/renderer/console/editorTheme.js";
import { intentionGlyphMarkup, type IntentionGlyph } from "@table-craft/desktop/renderer/console/intentionGlyphs.js";
import {
  dropProblems,
  fixTransaction,
  problemsAt,
  problemsNear,
} from "@table-craft/desktop/renderer/console/inspections.js";
import { intentionsFor, suppressionEdit, type Intention } from "@table-craft/desktop/renderer/model/intentions.js";
import type { TextSpan } from "@table-craft/desktop/renderer/model/statementAt.js";

/** What the popup needs from outside the editor. */
export interface IntentionTarget {
  /** The statements of `text`, so a suppression goes above the right one; null while not connected. */
  readonly statements: (text: string) => Promise<readonly TextSpan[]> | null;
  /** Turns an inspection off in the settings. */
  readonly disable: (inspection: string) => void;
  /** Show Context Actions' chord as the platform writes it, for the hover's hint; empty without one. */
  readonly chord: () => string;
}

const NO_TARGET: IntentionTarget = { statements: () => null, disable: () => undefined, chord: () => "" };
const POPUP_LABEL = "Context actions";
const EMPTY_TEXT = "No context actions here";
const MORE_ACTIONS = "More actions…";
const SUPPRESS_EVENT = "input.suppress";

const intentionTarget = Facet.define<IntentionTarget, IntentionTarget>({
  combine: (values) => values[0] ?? NO_TARGET,
});

interface Popup {
  readonly items: readonly Intention[];
  readonly selected: number;
  /** Kept for the popup's life, so moving the selection redraws rows rather than the whole tooltip. */
  readonly tooltip: Tooltip;
}

const setPopup = StateEffect.define<Popup | null>();
const selectRow = StateEffect.define<number>();

const popupField = StateField.define<Popup | null>({
  create: () => null,
  update(value, transaction) {
    let next = value;
    let opened = false;
    for (const effect of transaction.effects) {
      if (effect.is(setPopup)) {
        next = effect.value;
        opened = effect.value !== null;
      } else if (effect.is(selectRow) && next !== null) {
        next = { ...next, selected: effect.value };
      }
    }
    // The rows speak of the text and caret they were opened on.
    if (!opened && (transaction.docChanged || transaction.selection !== undefined)) return null;
    return next;
  },
  provide: (field) => showTooltip.from(field, (popup) => popup?.tooltip ?? null),
});

function glyphOf(intention: Intention): IntentionGlyph {
  if (intention.kind === "fix") return `fix-${intention.problem.severity}`;
  return intention.kind;
}

function glyphElement(glyph: IntentionGlyph): HTMLElement {
  const span = document.createElement("span");
  span.className = INTENTION_GLYPH_CLASS;
  span.innerHTML = intentionGlyphMarkup(glyph);
  return span;
}

/** Applies `fix` as one undo step and closes whatever showed it. */
export function applyFix(view: EditorView, fix: QuickFix): boolean {
  const spec = fixTransaction(view.state, fix);
  view.dispatch({ ...spec, effects: [setPopup.of(null), closeHoverTooltips] });
  return spec !== null;
}

async function suppress(view: EditorView, problem: Problem): Promise<void> {
  const doc = view.state.doc;
  const text = doc.toString();
  let statements: readonly TextSpan[] | null;
  try {
    statements = (await view.state.facet(intentionTarget).statements(text)) ?? null;
  } catch {
    statements = null;
  }
  if (view.state.doc !== doc) return;
  const line = doc.lineAt(problem.from);
  const statement = statements?.find((span) => span.from <= problem.from && problem.from <= span.to) ?? line;
  const edit = suppressionEdit(text, statement.from, problem.inspection);
  if (edit === null) return;
  const changes = ChangeSet.of(edit, doc.length);
  const span = { from: changes.mapPos(statement.from), to: changes.mapPos(statement.to) };
  view.dispatch({
    changes,
    effects: dropProblems.of({ inspection: problem.inspection, span }),
    userEvent: SUPPRESS_EVENT,
  });
}

function choose(view: EditorView, intention: Intention): void {
  view.dispatch({ effects: setPopup.of(null) });
  switch (intention.kind) {
    case "fix":
      applyFix(view, intention.fix);
      return;
    case "suppress":
      void suppress(view, intention.problem);
      return;
    case "disable":
      view.state.facet(intentionTarget).disable(intention.inspection);
      view.dispatch({
        effects: dropProblems.of({ inspection: intention.inspection, span: { from: 0, to: view.state.doc.length } }),
      });
  }
}

class IntentionsView implements TooltipView {
  readonly dom = document.createElement("div");
  private readonly rows: HTMLElement[] = [];

  constructor(private readonly view: EditorView) {
    this.dom.className = INTENTIONS_CLASS;
    this.dom.setAttribute("role", "listbox");
    this.dom.setAttribute("aria-label", POPUP_LABEL);
    // Clicks must leave focus in the editor, whose keymap drives the list.
    this.dom.addEventListener("mousedown", (event) => event.preventDefault());
    const popup = view.state.field(popupField);
    if (popup === null || popup.items.length === 0) {
      const empty = this.dom.appendChild(document.createElement("div"));
      empty.className = INTENTION_EMPTY_CLASS;
      empty.textContent = EMPTY_TEXT;
      return;
    }
    popup.items.forEach((intention, index) => {
      const previous = popup.items[index - 1];
      if (previous?.kind === "fix" && intention.kind !== "fix") {
        this.dom.appendChild(document.createElement("div")).className = INTENTION_SEPARATOR_CLASS;
      }
      const row = this.dom.appendChild(document.createElement("div"));
      row.className = INTENTION_CLASS;
      row.setAttribute("role", "option");
      row.append(glyphElement(glyphOf(intention)), intention.title);
      row.addEventListener("mousemove", () => {
        if (view.state.field(popupField)?.selected !== index) view.dispatch({ effects: selectRow.of(index) });
      });
      row.addEventListener("click", () => choose(view, intention));
      this.rows.push(row);
    });
    this.mark(popup.selected);
  }

  update(update: ViewUpdate): void {
    const popup = update.state.field(popupField);
    if (popup !== null && popup !== update.startState.field(popupField)) this.mark(popup.selected);
  }

  private mark(selected: number): void {
    this.rows.forEach((row, index) => row.setAttribute("aria-selected", String(index === selected)));
    this.rows[selected]?.scrollIntoView({ block: "nearest" });
  }
}

/**
 * Opens Show Context Actions at the caret (plan 108 decision 5): the fixes of the problems under
 * it, or on its line, then Suppress and Disable for each of their inspections.
 */
export function openIntentions(view: EditorView): void {
  const pos = view.state.selection.main.head;
  const items = intentionsFor(problemsNear(view.state, pos));
  const tooltip: Tooltip = { pos, above: false, create: () => new IntentionsView(view) };
  closeCompletion(view);
  view.dispatch({ effects: [setPopup.of({ items, selected: 0, tooltip }), closeHoverTooltips] });
}

function moveBy(step: number) {
  return (view: EditorView): boolean => {
    const popup = view.state.field(popupField);
    if (popup === null) return false;
    const count = popup.items.length;
    if (count > 0) view.dispatch({ effects: selectRow.of((popup.selected + step + count) % count) });
    return true;
  };
}

function accept(view: EditorView): boolean {
  const popup = view.state.field(popupField);
  if (popup === null) return false;
  const intention = popup.items[popup.selected];
  if (intention === undefined) view.dispatch({ effects: setPopup.of(null) });
  else choose(view, intention);
  return true;
}

function close(view: EditorView): boolean {
  if (view.state.field(popupField) === null) return false;
  view.dispatch({ effects: setPopup.of(null) });
  return true;
}

const popupKeymap = Prec.highest(
  keymap.of([
    { key: "ArrowDown", run: moveBy(1) },
    { key: "ArrowUp", run: moveBy(-1) },
    { key: "Enter", run: accept },
    { key: "Tab", run: accept },
    { key: "Escape", run: close },
  ]),
);

const closeOnBlur = EditorView.focusChangeEffect.of((state, focusing) =>
  !focusing && state.field(popupField) !== null ? setPopup.of(null) : null,
);

function fixLink(view: EditorView, text: string, run: () => void): HTMLElement {
  const link = document.createElement("button");
  link.type = "button";
  link.className = PROBLEM_FIX_CLASS;
  link.textContent = text;
  link.addEventListener("mousedown", (event) => event.preventDefault());
  link.addEventListener("click", () => {
    run();
    view.focus();
  });
  return link;
}

const problemTooltip = hoverTooltip((view, pos) => {
  const problems = problemsAt(view.state, pos);
  const [first] = problems;
  if (first === undefined) return null;
  return {
    pos: Math.min(...problems.map((problem) => problem.from)),
    end: Math.max(...problems.map((problem) => problem.to)),
    above: false,
    create() {
      const dom = document.createElement("div");
      dom.className = PROBLEM_TOOLTIP_CLASS;
      for (const problem of problems) {
        const message = dom.appendChild(document.createElement("div"));
        message.className = PROBLEM_MESSAGE_CLASS;
        message.append(glyphElement(`fix-${problem.severity}`), problem.message);
        for (const fix of problem.fixes) dom.appendChild(fixLink(view, fix.title, () => applyFix(view, fix)));
      }
      const more = dom.appendChild(
        fixLink(view, MORE_ACTIONS, () => {
          view.dispatch({ selection: { anchor: first.from }, effects: closeHoverTooltips });
          openIntentions(view);
        }),
      );
      const chord = view.state.facet(intentionTarget).chord();
      if (chord !== "") {
        const hint = more.appendChild(document.createElement("span"));
        hint.className = PROBLEM_CHORD_CLASS;
        hint.textContent = chord;
      }
      return { dom };
    },
  };
});

/** The Alt+Enter popup, its keys while open, and the problem hover with its fixes as links. */
export function intentions(target: IntentionTarget): Extension {
  return [intentionTarget.of(target), popupField, popupKeymap, closeOnBlur, problemTooltip];
}
