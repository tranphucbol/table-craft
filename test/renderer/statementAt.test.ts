import { describe, expect, it } from "vitest";
import { statementsToRun, type TextSpan } from "@table-craft/desktop/renderer/model/statementAt.js";

const SCRIPT = "SELECT 1;\n\nSELECT 2;\n-- note\nSELECT 3;";

interface Statement extends TextSpan {
  readonly sql: string;
}

/** The three statements of `SCRIPT` as the splitter reports them: no delimiter, no trailing comment. */
const STATEMENTS: readonly Statement[] = ["SELECT 1", "SELECT 2", "SELECT 3"].map((sql) => {
  const from = SCRIPT.indexOf(sql);
  return { from, to: from + sql.length, sql };
});

function caret(at: number): TextSpan {
  return { from: at, to: at };
}

function sqlOf(target: ReturnType<typeof statementsToRun<Statement>>): readonly string[] | string {
  if (target.kind === "nothing") return "nothing";
  if (target.kind === "selection") return SCRIPT.slice(target.from, target.to);
  return target.statements.map((statement) => statement.sql);
}

describe("statementsToRun", () => {
  it("givenCaretInsideStatement_whenResolved_thenRunsThatStatement", () => {
    expect(sqlOf(statementsToRun(STATEMENTS, caret(SCRIPT.indexOf("2")), "caret"))).toEqual(["SELECT 2"]);
  });

  it("givenCaretRightAfterSemicolon_whenResolved_thenRunsStatementItEnds", () => {
    expect(sqlOf(statementsToRun(STATEMENTS, caret(SCRIPT.indexOf(";") + 1), "caret"))).toEqual(["SELECT 1"]);
  });

  it("givenCaretInBlankLineAfterStatement_whenResolved_thenRunsPrecedingStatement", () => {
    expect(sqlOf(statementsToRun(STATEMENTS, caret(SCRIPT.indexOf("\n\n") + 1), "caret"))).toEqual(["SELECT 1"]);
  });

  it("givenCaretInCommentBetweenStatements_whenResolved_thenRunsPrecedingStatement", () => {
    expect(sqlOf(statementsToRun(STATEMENTS, caret(SCRIPT.indexOf("note")), "caret"))).toEqual(["SELECT 2"]);
  });

  it("givenCaretBeforeFirstStatement_whenResolved_thenRunsFirst", () => {
    const leading = STATEMENTS.map((statement) => ({ ...statement, from: statement.from + 2, to: statement.to + 2 }));
    expect(sqlOf(statementsToRun(leading, caret(0), "caret"))).toEqual(["SELECT 1"]);
  });

  it("givenSelectionAcrossTwoStatements_whenResolved_thenRunsSelectedTextOnly", () => {
    const selection = { from: SCRIPT.indexOf("1"), to: SCRIPT.indexOf("2") };
    expect(sqlOf(statementsToRun(STATEMENTS, selection, "caret"))).toBe("1;\n\nSELECT ");
  });

  it("givenSelectionOfWholeScript_whenResolved_thenRunsSelectedText", () => {
    const selection = { from: 0, to: SCRIPT.length };
    expect(sqlOf(statementsToRun(STATEMENTS, selection, "caret"))).toBe(SCRIPT);
  });

  it("givenSelectionInsideOneStatement_whenResolved_thenRunsSelectedTextAlone", () => {
    const from = SCRIPT.indexOf("SELECT 2");
    expect(sqlOf(statementsToRun(STATEMENTS, { from, to: from + "SELECT".length }, "caret"))).toBe("SELECT");
  });

  it("givenSelectionOfExactlyOneStatement_whenResolved_thenRunsSelectedText", () => {
    const [, second] = STATEMENTS;
    expect(sqlOf(statementsToRun(STATEMENTS, { from: second?.from ?? 0, to: second?.to ?? 0 }, "caret"))).toBe(
      "SELECT 2",
    );
  });

  it("givenSelectionFromCommentIntoStatement_whenResolved_thenRunsSelectedText", () => {
    const from = SCRIPT.indexOf("-- note");
    const selection = { from, to: SCRIPT.indexOf("SELECT 3") + "SELECT".length };
    expect(sqlOf(statementsToRun(STATEMENTS, selection, "caret"))).toBe("-- note\nSELECT");
  });

  it("givenBackwardSelection_whenResolved_thenNormalisedSpan", () => {
    const from = SCRIPT.indexOf("SELECT 2");
    const to = from + "SELECT".length;
    expect(statementsToRun(STATEMENTS, { from: to, to: from }, "caret")).toEqual({ kind: "selection", from, to });
  });

  it("givenSelectionAndRunAll_whenResolved_thenEveryStatement", () => {
    const from = SCRIPT.indexOf("SELECT 2");
    expect(sqlOf(statementsToRun(STATEMENTS, { from, to: from + "SELECT".length }, "all"))).toEqual([
      "SELECT 1",
      "SELECT 2",
      "SELECT 3",
    ]);
  });

  it("givenNoStatements_whenResolved_thenNothing", () => {
    expect(sqlOf(statementsToRun([], caret(0), "caret"))).toBe("nothing");
  });

  it("givenRunAll_whenResolved_thenEveryStatementWhateverTheCaret", () => {
    expect(sqlOf(statementsToRun(STATEMENTS, caret(SCRIPT.indexOf("2")), "all"))).toEqual([
      "SELECT 1",
      "SELECT 2",
      "SELECT 3",
    ]);
  });
});
