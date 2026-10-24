import { describe, expect, it } from "vitest";
import type { ScriptError, ScriptTask } from "@table-craft/desktop/engine/protocol.js";
import { fileMarks } from "@table-craft/desktop/renderer/model/errorLocation.js";
import { scriptFailure, scriptFailures, scriptStateText } from "@table-craft/desktop/renderer/model/scriptText.js";

const FILE = "/work/seed.sql";
const TEXT = "INSERT INTO t VALUES (1);\nSELEC 2;\nSELECT * FROM nowhere;\n";

function failure(overrides: Partial<ScriptError> = {}): ScriptError {
  return {
    code: "statementFailed",
    message: "syntax error",
    hint: "Fix the statement.",
    file: FILE,
    line: 2,
    column: 1,
    statement: "SELEC 2",
    at: { line: 2, column: 1 },
    ...overrides,
  };
}

function task(overrides: Partial<ScriptTask> = {}): ScriptTask {
  return {
    taskId: "script-1",
    files: [FILE],
    file: FILE,
    namespace: null,
    state: "running",
    statements: 3,
    bytes: 50,
    size: 100,
    elapsedMs: 10,
    error: null,
    failed: 0,
    failures: [],
    question: null,
    ...overrides,
  };
}

const MISSING = failure({
  message: "no such table: nowhere",
  line: 3,
  column: 1,
  statement: "SELECT * FROM nowhere",
  at: { line: 3, column: 15 },
});

describe("script failures", () => {
  it("givenRunningTask_whenStateText_thenPercent", () => {
    expect(scriptStateText(task())).toBe("running 50%");
  });

  it("givenAskingTask_whenStateText_thenWaiting", () => {
    expect(scriptStateText(task({ question: failure() }))).toBe("waiting on a failed statement");
  });

  it("givenDoneWithFailures_whenStateText_thenCountsThem", () => {
    expect(scriptStateText(task({ state: "done", failed: 2 }))).toBe("done, 2 failed");
    expect(scriptStateText(task({ state: "done" }))).toBe("done");
  });

  it("givenQuestionAndSkippedFailures_whenFailure_thenTheQuestion", () => {
    const question = failure({ line: 3 });
    expect(scriptFailure(task({ question, failures: [failure()] }))).toBe(question);
  });

  it("givenDoneWithFailures_whenFailure_thenTheLastSkipped", () => {
    const last = failure({ line: 3 });
    expect(scriptFailure(task({ state: "done", failed: 2, failures: [failure(), last] }))).toBe(last);
  });

  it("givenErrorWithoutLine_whenFailure_thenFallsBackToSkipped", () => {
    const skipped = failure();
    const lost = failure({ code: "connectionLost", file: null, line: null, column: null, statement: null, at: null });
    expect(scriptFailure(task({ state: "failed", error: lost, failures: [skipped] }))).toBe(skipped);
    expect(scriptFailures(task({ state: "failed", error: lost, failures: [skipped] }))).toEqual([skipped, lost]);
  });

  it("givenFailuresInTheFile_whenFileMarks_thenEachTokenMarked", () => {
    const marks = fileMarks(TEXT, [failure(), MISSING]);
    expect(marks.map((mark) => TEXT.slice(mark.from, mark.to))).toEqual(["SELEC", "nowhere"]);
    expect(marks[1]).toMatchObject({ statementFrom: TEXT.indexOf("SELECT"), message: "no such table: nowhere" });
  });

  it("givenFileChangedSince_whenFileMarks_thenThatFailureMarksNothing", () => {
    const edited = TEXT.replace("SELEC 2", "SELECT 2");
    expect(fileMarks(edited, [failure({ statement: "SELEC 2;" })])).toEqual([]);
  });

  it("givenFailureWithoutPosition_whenFileMarks_thenNothing", () => {
    expect(fileMarks(TEXT, [failure({ at: null })])).toEqual([]);
  });
});
