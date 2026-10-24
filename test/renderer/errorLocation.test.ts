import { ChangeSet } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { movedMarks } from "@table-craft/desktop/renderer/console/errorMarks.js";
import {
  errorMarkOf,
  errorSpan,
  marksOutside,
  nextMark,
  withMark,
  type ErrorMark,
} from "@table-craft/desktop/renderer/model/errorLocation.js";

const ERROR = { message: "syntax error", hint: "Fix it." };

function statementAt(text: string, sql: string) {
  const from = text.indexOf(sql);
  return { from, to: from + sql.length, sql };
}

function mark(from: number, to: number, statementFrom: number, statementTo: number): ErrorMark {
  return { from, to, statementFrom, statementTo, ...ERROR };
}

describe("error location", () => {
  it("givenPositionOnAWord_whenSpanned_thenTheWholeWordInDocumentOffsets", () => {
    const text = "SELECT 1;\nSELECT id FROM customers WHER id = 1;";
    const statement = statementAt(text, "SELECT id FROM customers WHER id = 1");

    const span = errorSpan(statement, statement.sql.indexOf("HER"));

    expect(text.slice(span.from, span.to)).toBe("WHER");
  });

  it("givenPositionOnASymbol_whenSpanned_thenThatCharacter", () => {
    const statement = { from: 0, to: 19, sql: "SELECT id, FROM t)" };

    const span = errorSpan(statement, statement.sql.indexOf(")"));

    expect(statement.sql.slice(span.from, span.to)).toBe(")");
  });

  it("givenPositionPastTheEnd_whenSpanned_thenTheLastToken", () => {
    const statement = { from: 4, to: 22, sql: "SELECT * FROM (  " };

    const span = errorSpan(statement, statement.sql.length);

    expect({ from: span.from - 4, to: span.to - 4 }).toEqual({ from: 14, to: 15 });
  });

  it("givenPositionOnWhitespaceAfterAWord_whenSpanned_thenThatWord", () => {
    const statement = { from: 0, to: 13, sql: "SELECT * FROM" };

    const span = errorSpan(statement, statement.sql.length);

    expect(statement.sql.slice(span.from, span.to)).toBe("FROM");
  });

  it("givenEmptyStatement_whenSpanned_thenEmptySpanAtItsStart", () => {
    expect(errorSpan({ from: 3, to: 5, sql: "  " }, 1)).toEqual({ from: 4, to: 4 });
  });

  it("givenNoPosition_whenMarked_thenNull", () => {
    expect(errorMarkOf({ from: 0, to: 4, sql: "SELE" }, ERROR)).toBeNull();
  });

  it("givenMarks_whenStatementsRun_thenOnlyMarksOfOtherStatementsStay", () => {
    const first = mark(2, 4, 0, 10);
    const second = mark(14, 16, 12, 20);

    expect(marksOutside([first, second], [{ from: 12, to: 20 }])).toEqual([first]);
    const untouched = [first];
    expect(marksOutside(untouched, [{ from: 30, to: 40 }])).toBe(untouched);
  });

  it("givenAMarkInTheSameStatement_whenMarkedAgain_thenReplaced", () => {
    const old = mark(2, 4, 0, 10);
    const fresh = mark(6, 8, 0, 10);

    expect(withMark([old], fresh)).toEqual([fresh]);
  });

  it("givenMarks_whenNextFromCaret_thenFollowingOneAndWraps", () => {
    const marks = [mark(30, 32, 28, 40), mark(5, 7, 0, 10)];

    expect(nextMark(marks, 0, false)?.from).toBe(5);
    expect(nextMark(marks, 5, false)?.from).toBe(30);
    expect(nextMark(marks, 31, false)?.from).toBe(5);
    expect(nextMark(marks, 31, true)?.from).toBe(30);
    expect(nextMark(marks, 5, true)?.from).toBe(30);
    expect(nextMark([], 0, false)).toBeNull();
  });
});

describe("error marks in the editor", () => {
  const text = "SELECT FAIL;\nSELECT 2;\nSELECT oops;";
  const first = mark(7, 11, 0, 11);
  const third = mark(30, 34, 23, 34);

  it("givenEditBeforeAMark_whenMoved_thenTheMarkShiftsWithItsText", () => {
    const changes = ChangeSet.of({ from: text.indexOf("2"), to: text.indexOf("2") + 1, insert: "22" }, text.length);

    expect(movedMarks([first, third], changes)).toEqual([first, mark(31, 35, 24, 35)]);
  });

  it("givenEditInsideAMarkedStatement_whenMoved_thenThatMarkIsDropped", () => {
    const changes = ChangeSet.of({ from: 0, to: 6, insert: "select" }, text.length);

    expect(movedMarks([first, third], changes)).toEqual([third]);
  });

  it("givenNoMarks_whenMoved_thenTheSameArray", () => {
    const none: readonly ErrorMark[] = [];

    expect(movedMarks(none, ChangeSet.of({ from: 0, insert: "x" }, text.length))).toBe(none);
  });
});
