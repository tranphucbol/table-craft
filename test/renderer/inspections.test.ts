import { history, undo } from "@codemirror/commands";
import { ChangeSet, EditorState, type Transaction, type TransactionSpec } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import type { Problem } from "@table-craft/desktop/engine/protocol.js";
import { errorMarks, setErrorMarks } from "@table-craft/desktop/renderer/console/errorMarks.js";
import {
  INSPECTION_MAX_TEXT,
  enabledProblems,
  inspectionRequest,
} from "@table-craft/desktop/renderer/console/inspectionSource.js";
import {
  acceptedProblems,
  drawnSpan,
  fixTransaction,
  inspections,
  lineMarks,
  movedProblems,
  nextProblemIn,
  problemsIn,
  problemsNear,
  setProblems,
  visibleProblemsIn,
} from "@table-craft/desktop/renderer/console/inspections.js";
import type { ErrorMark } from "@table-craft/desktop/renderer/model/errorLocation.js";
import { intentionsFor, suppressionEdit } from "@table-craft/desktop/renderer/model/intentions.js";

const QUERY = "select * from order where order by order_no asc;";

function at(text: string, word: string, from = 0): { from: number; to: number } {
  const start = text.indexOf(word, from);
  return { from: start, to: start + word.length };
}

function problem(span: { from: number; to: number }, overrides: Partial<Problem> = {}): Problem {
  return {
    ...span,
    severity: "error",
    inspection: "SqlSyntax",
    message: "Expression expected",
    fixes: [],
    ...overrides,
  };
}

const ASC = problem(at(QUERY, "asc"), {
  severity: "weak",
  inspection: "SqlRedundantOrderingDirection",
  message: "Redundant ordering direction",
  fixes: [{ title: "Remove ASC", edits: [{ from: QUERY.indexOf(" asc"), to: QUERY.indexOf(" asc") + 4, insert: "" }] }],
});
const ORDER = problem(at(QUERY, "order"), {
  inspection: "SqlReservedWordAsName",
  message: "'order' is a reserved word",
  fixes: [{ title: "Quote 'order'", edits: [{ ...at(QUERY, "order"), insert: "`order`" }] }],
});
const WHERE = problem(at(QUERY, "where"), {
  fixes: [
    {
      title: "Remove empty WHERE",
      edits: [{ from: QUERY.indexOf(" where"), to: QUERY.indexOf(" order by"), insert: "" }],
    },
  ],
});

function editor(doc = QUERY, problems: readonly Problem[] = [ORDER, WHERE, ASC]): EditorState {
  const state = EditorState.create({ doc, extensions: [history(), errorMarks, inspections] });
  return state.update({ effects: setProblems.of(problems) }).state;
}

function run(state: EditorState, spec: TransactionSpec | null): EditorState {
  if (spec === null) throw new Error("no transaction");
  return state.update(spec).state;
}

function undone(state: EditorState): EditorState {
  let next = state;
  undo({ state, dispatch: (transaction: Transaction) => (next = transaction.state) });
  return next;
}

function serverMark(span: { from: number; to: number }): ErrorMark {
  return { ...span, statementFrom: 0, statementTo: QUERY.length, message: "near 'order'", hint: "" };
}

describe("live problems", () => {
  it("givenProblems_whenEditElsewhere_thenTheyMoveAndATouchedOneIsDropped", () => {
    const changes = ChangeSet.of({ ...at(QUERY, "order_no"), insert: "id" }, QUERY.length);

    const moved = movedProblems([ORDER, WHERE, ASC], changes);

    const shift = "id".length - "order_no".length;
    expect(moved.map((each) => each.inspection)).toEqual(["SqlReservedWordAsName", "SqlSyntax", ASC.inspection]);
    expect(moved[2]).toMatchObject({ from: ASC.from + shift, to: ASC.to + shift });

    const typedInto = movedProblems(moved, ChangeSet.of({ from: ORDER.from + 1, insert: "x" }, QUERY.length + shift));
    expect(typedInto.map((each) => each.inspection)).not.toContain("SqlReservedWordAsName");
  });

  it("givenProblemsInTheEditor_whenTyping_thenTheFieldMapsThemUntilTheNextAnswer", () => {
    const state = run(editor(), { changes: { from: 0, insert: "  " } });

    expect(problemsIn(state).map((each) => each.from)).toEqual([ORDER.from + 2, WHERE.from + 2, ASC.from + 2]);
    expect(problemsIn(run(state, { effects: setProblems.of([]) }))).toEqual([]);
  });

  it("givenServerMarkOverOneProblem_whenDrawn_thenTheServerMarkWins", () => {
    const state = run(editor(), { effects: setErrorMarks.of([serverMark(at(QUERY, "order"))]) });

    expect(problemsIn(state)).toHaveLength(3);
    expect(visibleProblemsIn(state).map((each) => each.inspection)).toEqual(["SqlSyntax", ASC.inspection]);
  });

  it("givenFix_whenApplied_thenItIsOneUndoStep", () => {
    const state = editor();

    const fixed = run(state, fixTransaction(state, WHERE.fixes[0]!));

    expect(fixed.doc.toString()).toBe("select * from order order by order_no asc;");
    expect(undone(fixed).doc.toString()).toBe(QUERY);
  });

  it("givenTypingSinceTheAnswer_whenFixApplied_thenItsEditsAndCaretAreRebased", () => {
    const text = "delete from orders;";
    const fix = { title: "Add WHERE", edits: [{ from: 18, to: 18, insert: " WHERE " }], caret: 25 };
    const typed = run(editor(text, [problem({ from: 0, to: 6 }, { severity: "warning", fixes: [fix] })]), {
      changes: { from: 0, insert: "-- tidy\n" },
    });

    const fixed = run(typed, fixTransaction(typed, fix));

    expect(fixed.doc.toString()).toBe("-- tidy\ndelete from orders WHERE ;");
    expect(fixed.selection.main.head).toBe(fixed.doc.toString().indexOf(";"));
  });

  it("givenCaretInsideAMisspeltName_whenDidYouMeanApplied_thenCaretGoesAfterTheReplacement", () => {
    const text = "select * from ordrs;";
    const name = at(text, "ordrs");
    const fix = { title: "Did you mean 'orders'?", edits: [{ ...name, insert: "orders" }] };
    const state = run(editor(text, [problem(name, { inspection: "SqlResolve", fixes: [fix] })]), {
      selection: { anchor: name.from + 2 },
    });

    const fixed = run(state, fixTransaction(state, fix));

    expect(fixed.doc.toString()).toBe("select * from orders;");
    expect(fixed.selection.main.head).toBe(name.from + "orders".length);
  });

  it("givenAnswerWithFixOutsideTheText_whenAccepted_thenOnlyThatFixIsDropped", () => {
    const broken = problem({ from: 0, to: 6 }, { fixes: [{ title: "Bad", edits: [{ from: 0, to: 99, insert: "" }] }] });

    expect(acceptedProblems([broken, problem({ from: 90, to: 95 })], 10)).toEqual([{ ...broken, fixes: [] }]);
  });

  it("givenEmptyProblemAtTheEndOfTheText_whenDrawn_thenItTakesTheCharacterBefore", () => {
    const state = editor("select (1");

    expect(drawnSpan({ from: 9, to: 9 }, state.doc)).toEqual({ from: 8, to: 9 });
    expect(drawnSpan({ from: 7, to: 7 }, state.doc)).toEqual({ from: 7, to: 8 });
  });

  it("givenErrorsAndWarnings_whenF2_thenErrorsAreVisitedFirstAndWrapRound", () => {
    const state = run(editor(), { selection: { anchor: WHERE.from } });

    expect(nextProblemIn(state, false)).toEqual({ from: ORDER.from, to: ORDER.to });
    expect(nextProblemIn(state, true)).toEqual({ from: ORDER.from, to: ORDER.to });

    const warningsOnly = editor(QUERY, [ASC, { ...WHERE, severity: "warning" }]);
    expect(nextProblemIn(warningsOnly, false)).toEqual({ from: WHERE.from, to: WHERE.to });
  });

  it("givenProblemsOnOneLine_whenGutterMarked_thenWorstSeverityAndWeakIgnored", () => {
    const state = editor(`${QUERY}\nselect 1 asc;`);
    const weakOnly = problem({ from: QUERY.length + 10, to: QUERY.length + 13 }, { severity: "weak" });

    const marks = lineMarks(state.doc, [], [ASC, { ...WHERE, severity: "warning" }, ORDER, weakOnly]);

    expect([...marks]).toEqual([[0, { severity: "error", messages: [ORDER.message, WHERE.message] }]]);
  });

  it("givenCaretBesideAProblemOnItsLine_whenContextActionsAsked_thenNearestFirst", () => {
    const state = editor();

    expect(problemsNear(state, ASC.from + 1).map((each) => each.inspection)).toEqual([ASC.inspection]);
    expect(problemsNear(state, QUERY.length).map((each) => each.inspection)).toEqual([
      ASC.inspection,
      "SqlSyntax",
      "SqlReservedWordAsName",
    ]);
  });
});

describe("context actions", () => {
  it("givenProblemsUnderTheCaret_whenListed_thenFixesThenSuppressAndDisablePerInspection", () => {
    expect(intentionsFor([ORDER]).map((each) => each.title)).toEqual([
      "Quote 'order'",
      "Suppress for statement",
      "Disable inspection 'Reserved word used as a name'",
    ]);
    expect(intentionsFor([WHERE, ASC]).map((each) => [each.kind, each.title])).toEqual([
      ["fix", "Remove empty WHERE"],
      ["fix", "Remove ASC"],
      ["suppress", "Suppress 'Syntax errors' for statement"],
      ["disable", "Disable inspection 'Syntax errors'"],
      ["suppress", "Suppress 'Redundant ordering direction' for statement"],
      ["disable", "Disable inspection 'Redundant ordering direction'"],
    ]);
  });

  it("givenStatement_whenSuppressed_thenACommentGoesAboveItIndentedAsItIs", () => {
    const text = "select 1;\n  select * from order;";
    const from = text.indexOf("select *");

    const edit = suppressionEdit(text, from, "SqlReservedWordAsName");

    expect(edit).toEqual({ from: 10, to: 10, insert: "  -- noinspection SqlReservedWordAsName\n" });
  });

  it("givenNoinspectionCommentAbove_whenSuppressed_thenTheIdJoinsItOnce", () => {
    const text = "-- noinspection SqlResolve\nselect * from order;";
    const from = text.indexOf("select");

    expect(suppressionEdit(text, from, "SqlReservedWordAsName")).toEqual({
      from: 26,
      to: 26,
      insert: ",SqlReservedWordAsName",
    });
    expect(suppressionEdit(text, from, "SqlResolve")).toBeNull();
    expect(suppressionEdit("select 1", 0, "SqlResolve")).toEqual({
      from: 0,
      to: 0,
      insert: "-- noinspection SqlResolve\n",
    });
  });

  it("givenSuppressionAppliedInTheEditor_whenUndone_thenTheCommentGoesInOneStep", () => {
    const state = editor();
    const edit = suppressionEdit(QUERY, 0, "SqlSyntax");

    const suppressed = run(state, { changes: edit ?? [] });

    expect(suppressed.doc.toString()).toBe(`-- noinspection SqlSyntax\n${QUERY}`);
    expect(undone(suppressed).doc.toString()).toBe(QUERY);
  });
});

describe("inspection requests", () => {
  const ON = { enabled: true, disabled: [] };

  it("givenSettingsAndNamespace_whenRequested_thenTheyTravelWithTheText", () => {
    expect(inspectionRequest(QUERY, ["shop"], { enabled: true, disabled: ["SqlResolve"] })).toEqual({
      text: QUERY,
      current: ["shop"],
      disabled: ["SqlResolve"],
    });
    expect(inspectionRequest(QUERY, null, ON)).toEqual({ text: QUERY });
  });

  it("givenSwitchOffBlankOrHugeText_whenRequested_thenNothingIsAsked", () => {
    expect(inspectionRequest(QUERY, null, { enabled: false, disabled: [] })).toBeNull();
    expect(inspectionRequest("  \n", null, ON)).toBeNull();
    expect(inspectionRequest("x".repeat(INSPECTION_MAX_TEXT + 1), null, ON)).toBeNull();
  });

  it("givenEngineReportsADisabledInspection_whenReceived_thenItIsDropped", () => {
    expect(enabledProblems([ORDER, ASC], [ASC.inspection])).toEqual([ORDER]);
  });
});
