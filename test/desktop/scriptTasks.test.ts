import { describe, expect, it } from "vitest";
import { sqlSplitter, sqlStatementStream } from "@table-craft/plugin-api/sql";
import type { EngineError, ScriptEvent, ScriptTask } from "@table-craft/desktop/engine/protocol.js";
import {
  scriptTasks,
  wholeFileStream,
  type ScriptJob,
  type ScriptSession,
} from "@table-craft/desktop/engine/scripts.js";

const FILE = "/scripts/seed.sql";
const OTHER = "/scripts/more.sql";
const STATEMENTS_PER_CHUNK = 100;
const CHUNKS = 50;

interface Recorded {
  readonly executed: string[];
  chunksRead: number;
  cancelled: number;
  closed: number;
}

function recorded(): Recorded {
  return { executed: [], chunksRead: 0, cancelled: 0, closed: 0 };
}

const encode = (text: string) => new TextEncoder().encode(text);

function sessionOf(record: Recorded, execute: (sql: string) => Promise<void> = () => Promise.resolve()): ScriptSession {
  return {
    execute: (sql) => {
      record.executed.push(sql);
      return execute(sql);
    },
    cancel: () => {
      record.cancelled += 1;
    },
    close: () => {
      record.closed += 1;
      return Promise.resolve();
    },
    inTransaction: () => false,
  };
}

function jobOf(session: ScriptSession, overrides: Partial<ScriptJob> = {}): ScriptJob {
  return {
    files: [{ path: FILE, size: 0 }],
    namespace: null,
    open: () => Promise.resolve(session),
    stream: sqlStatementStream(),
    failure: (cause, sql): EngineError => {
      const at = (cause as { at?: string }).at;
      const position = at === undefined || sql === undefined ? -1 : sql.indexOf(at);
      return {
        code: "statementFailed",
        message: cause instanceof Error ? cause.message : String(cause),
        hint: "Fix the statement.",
        ...(position === -1 ? {} : { position }),
      };
    },
    onError: "stop",
    ...overrides,
  };
}

function chunksFrom(files: Readonly<Record<string, readonly Uint8Array[]>>, record: Recorded) {
  return async function* (file: string): AsyncIterable<Uint8Array> {
    for (const chunk of files[file] ?? []) {
      record.chunksRead += 1;
      yield await Promise.resolve(chunk);
    }
  };
}

async function finished(tasks: ReturnType<typeof scriptTasks>, taskId: string): Promise<ScriptTask> {
  await tasks.settled();
  const task = tasks.get(taskId);
  if (task === undefined) throw new Error("task vanished");
  return task;
}

const FAILING = "SELECT 1;\nSELECT bad1;\nSELECT 2;\n  SELECT\n    bad2 FROM t;\nSELECT 3;\n";

/** Fails every statement naming `bad…`, locating the error at that word. */
function failingSession(record: Recorded): ScriptSession {
  return sessionOf(record, (sql) => {
    const bad = /bad\d/.exec(sql)?.[0];
    return bad === undefined ? Promise.resolve() : Promise.reject(Object.assign(new Error(`no ${bad}`), { at: bad }));
  });
}

async function questioned(tasks: ReturnType<typeof scriptTasks>, taskId: string): Promise<ScriptTask> {
  for (;;) {
    const task = tasks.get(taskId);
    if (task?.question != null || task?.state !== "running") return task as ScriptTask;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe("scriptTasks", () => {
  it("givenLargeScript_whenRunScript_thenStreamsWithoutLoadingWholeFile", async () => {
    const record = recorded();
    const chunks = Array.from({ length: CHUNKS }, (_, chunk) =>
      encode(
        Array.from(
          { length: STATEMENTS_PER_CHUNK },
          (_, index) => `INSERT INTO t VALUES (${String(chunk * STATEMENTS_PER_CHUNK + index)});\n`,
        ).join(""),
      ),
    );
    const readAhead: number[] = [];
    const session = sessionOf(record, () => {
      readAhead.push(record.chunksRead - Math.floor(record.executed.length / STATEMENTS_PER_CHUNK));
      return Promise.resolve();
    });
    const tasks = scriptTasks({ chunks: chunksFrom({ [FILE]: chunks }, record) });

    const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    const task = tasks.start(jobOf(session, { files: [{ path: FILE, size }] }));
    const done = await finished(tasks, task.taskId);

    expect(done).toMatchObject({ state: "done", statements: CHUNKS * STATEMENTS_PER_CHUNK, bytes: size, size });
    expect(record.executed.at(-1)).toBe(`INSERT INTO t VALUES (${String(CHUNKS * STATEMENTS_PER_CHUNK - 1)})`);
    // Each chunk is read only once the statements of the one before have run.
    expect(Math.max(...readAhead)).toBeLessThanOrEqual(2);
    expect(record.closed).toBe(1);
  });

  it("givenScriptError_whenRunScript_thenStopsAndLinksStatement", async () => {
    const record = recorded();
    const text = "SELECT 1;\n-- the bad one\n  SELECT nope FROM missing;\nSELECT 3;\n";
    const session = sessionOf(record, (sql) =>
      sql.includes("nope") ? Promise.reject(new Error('relation "missing" does not exist')) : Promise.resolve(),
    );
    const tasks = scriptTasks({ chunks: chunksFrom({ [FILE]: [encode(text)] }, record) });

    const done = await finished(tasks, tasks.start(jobOf(session)).taskId);

    expect(done.state).toBe("failed");
    expect(done.statements).toBe(1);
    expect(done.error).toMatchObject({
      code: "statementFailed",
      message: 'relation "missing" does not exist',
      file: FILE,
      line: 3,
      column: 3,
      statement: "SELECT nope FROM missing",
    });
    expect(record.executed).toEqual(["SELECT 1", "SELECT nope FROM missing"]);
  });

  it("givenRunningScript_whenCancelled_thenStopsTheStatementAndReportsCancelled", async () => {
    const record = recorded();
    let release: () => void = () => undefined;
    const session = sessionOf(record, (sql) =>
      sql === "SELECT pg_sleep(60)" ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve(),
    );
    const tasks = scriptTasks({
      chunks: chunksFrom({ [FILE]: [encode("SELECT 1;\nSELECT pg_sleep(60);\nSELECT 3;\n")] }, record),
    });
    const events: ScriptEvent[] = [];
    tasks.subscribe((event) => events.push(event));

    const task = tasks.start(jobOf(session));
    await new Promise((resolve) => setTimeout(resolve, 10));
    tasks.cancel(task.taskId);
    const done = await finished(tasks, task.taskId);
    release();

    expect(done.state).toBe("cancelled");
    expect(done.error?.code).toBe("cancelled");
    expect(record.cancelled).toBe(1);
    expect(record.executed).not.toContain("SELECT 3");
    expect(events.at(-1)?.type).toBe("script.cancelled");
  });

  it("givenInvalidUtf8_whenRunScript_thenFailsNamingTheByteOffset", async () => {
    const record = recorded();
    const bytes = new Uint8Array([...encode("SELECT 1;\n"), 0xff, ...encode(";\n")]);
    const tasks = scriptTasks({ chunks: chunksFrom({ [FILE]: [bytes] }, record) });

    const done = await finished(tasks, tasks.start(jobOf(sessionOf(record))).taskId);

    expect(done.state).toBe("failed");
    expect(done.error).toMatchObject({ code: "scriptFailed", file: FILE, line: null });
    expect(done.error?.message).toContain("byte 10");
  });

  it("givenBomAndSeveralFiles_whenRunScript_thenBomStrippedAndFilesRunInOrder", async () => {
    const record = recorded();
    const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
    const tasks = scriptTasks({
      chunks: chunksFrom(
        { [FILE]: [new Uint8Array([...bom, ...encode("SELECT 1;")])], [OTHER]: [encode("SELECT 2")] },
        record,
      ),
    });

    const done = await finished(
      tasks,
      tasks.start(
        jobOf(sessionOf(record), {
          files: [
            { path: FILE, size: 12 },
            { path: OTHER, size: 8 },
          ],
        }),
      ).taskId,
    );

    expect(done).toMatchObject({ state: "done", statements: 2, file: OTHER, files: [FILE, OTHER] });
    expect(record.executed).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("givenConnectFails_whenRunScript_thenFailsWithoutAStatement", async () => {
    const record = recorded();
    const tasks = scriptTasks({ chunks: chunksFrom({ [FILE]: [encode("SELECT 1;")] }, record) });

    const done = await finished(
      tasks,
      tasks.start(jobOf(sessionOf(record), { open: () => Promise.reject(new Error("refused")) })).taskId,
    );

    expect(done.error).toMatchObject({ message: "refused", file: null, line: null });
    expect(record.chunksRead).toBe(0);
  });
});

describe("wholeFileStream", () => {
  it("givenPluginWithoutSplitStream_whenStreamed_thenSplitAtTheEndWithLines", () => {
    const stream = wholeFileStream(sqlSplitter());

    expect(stream.push("SELECT 1;\n\n  SEL")).toEqual([]);
    expect(stream.push("ECT 2;")).toEqual([]);
    expect(stream.end()).toEqual([
      { from: 0, to: 8, sql: "SELECT 1", line: 1, column: 1 },
      { from: 13, to: 21, sql: "SELECT 2", line: 3, column: 3 },
    ]);
  });

  it("givenRunScriptContinue_whenErrors_thenTaskFinishesWithFailures", async () => {
    const record = recorded();
    const tasks = scriptTasks({ chunks: chunksFrom({ [FILE]: [encode(FAILING)] }, record) });

    const done = await finished(tasks, tasks.start(jobOf(failingSession(record), { onError: "continue" })).taskId);

    expect(done).toMatchObject({ state: "done", statements: 3, failed: 2, error: null, question: null });
    expect(done.failures.map((failure) => [failure.message, failure.line, failure.column, failure.at])).toEqual([
      ["no bad1", 2, 1, { line: 2, column: 8 }],
      ["no bad2", 4, 3, { line: 5, column: 5 }],
    ]);
    expect(record.executed.at(-1)).toBe("SELECT 3");
  });

  it("givenRunScriptAsk_whenSkip_thenGoesOn", async () => {
    const record = recorded();
    const tasks = scriptTasks({ chunks: chunksFrom({ [FILE]: [encode(FAILING)] }, record) });
    const { taskId } = tasks.start(jobOf(failingSession(record), { onError: "ask" }));

    const first = await questioned(tasks, taskId);
    expect(first.question).toMatchObject({ message: "no bad1", line: 2 });
    expect(record.executed).toEqual(["SELECT 1", "SELECT bad1"]);
    expect(tasks.answer(taskId, "skip")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await questioned(tasks, taskId);
    expect(second.question?.message).toBe("no bad2");
    tasks.answer(taskId, "stop");
    const done = await finished(tasks, taskId);

    expect(done).toMatchObject({ state: "failed", failed: 1, question: null, error: { message: "no bad2" } });
    expect(record.executed).not.toContain("SELECT 3");
  });

  it("givenRunScriptAskSkipAll_whenTwoFail_thenAsksOnce", async () => {
    const record = recorded();
    const tasks = scriptTasks({ chunks: chunksFrom({ [FILE]: [encode(FAILING)] }, record) });
    const events: ScriptEvent[] = [];
    tasks.subscribe((event) => events.push(event));
    const { taskId } = tasks.start(jobOf(failingSession(record), { onError: "ask" }));

    await questioned(tasks, taskId);
    tasks.answer(taskId, "skipAll");
    const done = await finished(tasks, taskId);

    expect(done).toMatchObject({ state: "done", failed: 2, statements: 3 });
    expect(events.filter((event) => event.task.question !== null)).toHaveLength(1);
    expect(tasks.answer(taskId, "skip")).toBe(false);
  });

  it("givenRunScriptAskRetry_whenFixed_thenRunsAgain", async () => {
    const record = recorded();
    let broken = true;
    const session = sessionOf(record, (sql) =>
      sql === "SELECT flaky" && broken ? Promise.reject(new Error("locked")) : Promise.resolve(),
    );
    const tasks = scriptTasks({ chunks: chunksFrom({ [FILE]: [encode("SELECT flaky;\nSELECT 2;\n")] }, record) });
    const { taskId } = tasks.start(jobOf(session, { onError: "ask" }));

    await questioned(tasks, taskId);
    broken = false;
    tasks.answer(taskId, "retry");
    const done = await finished(tasks, taskId);

    expect(done).toMatchObject({ state: "done", statements: 2, failed: 0 });
    expect(record.executed).toEqual(["SELECT flaky", "SELECT flaky", "SELECT 2"]);
  });

  it("givenAskingScript_whenCancelled_thenCancelledWithoutAnswer", async () => {
    const record = recorded();
    const tasks = scriptTasks({ chunks: chunksFrom({ [FILE]: [encode(FAILING)] }, record) });
    const { taskId } = tasks.start(jobOf(failingSession(record), { onError: "ask" }));

    await questioned(tasks, taskId);
    tasks.cancel(taskId);
    const done = await finished(tasks, taskId);

    expect(done).toMatchObject({ state: "cancelled", question: null, error: { code: "cancelled" } });
  });

  it("givenFailureInsideTransaction_whenSkipped_thenHintSaysTheRestIsRefused", async () => {
    const record = recorded();
    const session = { ...failingSession(record), inTransaction: () => true };
    const tasks = scriptTasks({ chunks: chunksFrom({ [FILE]: [encode(FAILING)] }, record) });

    const done = await finished(tasks, tasks.start(jobOf(session, { onError: "continue" })).taskId);

    expect(done.failures[0]?.hint).toMatch(/PostgreSQL refuses every later statement/);
  });

  it("givenLostConnection_whenContinue_thenStopsAnyway", async () => {
    const record = recorded();
    const tasks = scriptTasks({ chunks: chunksFrom({ [FILE]: [encode(FAILING)] }, record) });
    const job = jobOf(failingSession(record), {
      onError: "continue",
      failure: () => ({ code: "connectionLost", message: "gone", hint: "Reconnect." }),
    });

    const done = await finished(tasks, tasks.start(job).taskId);

    expect(done).toMatchObject({ state: "failed", failed: 0, error: { code: "connectionLost" } });
  });
});
