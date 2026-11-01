import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  exportEncoder,
  type ExportError,
  openFileSink,
  runExport,
  type ExportClock,
  type ExportProgress,
  type FileSink,
} from "@table-craft/core";
import type { Column, Row } from "@table-craft/plugin-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const COLUMNS: readonly Column[] = [{ name: "n", type: "int4" }];
const STALL_MS = 1_000;

let folder = "";

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "tc-runner-"));
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

/** Time moves only when a test says so. */
function fakeClock(): ExportClock & { advance(ms: number): void } {
  let now = 0;
  let timers: { at: number; run: () => void; id: number }[] = [];
  let nextId = 1;
  return {
    now: () => now,
    setTimeout(run, ms) {
      const id = nextId++;
      timers.push({ at: now + ms, run, id });
      return id;
    },
    clearTimeout(timer) {
      timers = timers.filter((entry) => entry.id !== timer);
    },
    advance(ms) {
      now += ms;
      const due = timers.filter((entry) => entry.at <= now);
      timers = timers.filter((entry) => entry.at > now);
      for (const entry of due) entry.run();
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

async function* counted(count: number): AsyncGenerator<Row> {
  await Promise.resolve();
  for (let n = 1; n <= count; n += 1) yield [n];
}

describe("export runner", () => {
  it("givenRows_whenRunning_thenCommittedCsv", async () => {
    const target = join(folder, "n.csv");

    const outcome = await runExport({
      rows: () => counted(3),
      encoder: exportEncoder("csv", COLUMNS),
      sink: await openFileSink(target, "t1"),
      signal: new AbortController().signal,
      stallMs: STALL_MS,
    });

    expect(outcome).toMatchObject({ rows: 3, bytes: 8, sheets: 0, truncatedCells: 0, clippedBytes: 0 });
    expect(await readFile(target, "utf8")).toBe("n\n1\n2\n3\n");
  });

  it("givenNoRowWithinStall_whenRunning_thenStalledWithRowsWritten", async () => {
    const clock = fakeClock();
    let stalled = false;
    let returned = false;
    const source: AsyncIterable<Row> = {
      [Symbol.asyncIterator]() {
        let n = 0;
        return {
          next: () => (n < 2 ? Promise.resolve({ done: false, value: [++n] }) : new Promise(() => undefined)),
          return: () => {
            returned = true;
            return new Promise(() => undefined);
          },
        };
      },
    };
    const running = runExport({
      rows: () => source,
      encoder: exportEncoder("csv", COLUMNS),
      sink: await openFileSink(join(folder, "s.csv"), "t1"),
      signal: new AbortController().signal,
      stallMs: 120_000,
      clock,
      onStall: () => {
        stalled = true;
      },
    }).catch((cause: unknown) => cause);
    await settle();
    clock.advance(119_999);
    await settle();
    expect(stalled).toBe(false);
    clock.advance(1);

    const failed = (await running) as ExportError;
    expect(failed.reason).toBe("stalled");
    expect(failed.rows).toBe(2);
    expect(failed.message).toBe(
      "The server sent nothing for 2 minutes; the network or the server stalled. 2 rows were exported before it stopped; the partial file was removed.",
    );
    expect(stalled).toBe(true);
    await settle();
    expect(returned).toBe(true);
    expect(await readdir(folder)).toEqual([]);
  });

  it("givenSlowButSteadyRows_whenRunning_thenNeverStalls", async () => {
    const clock = fakeClock();
    let release: (() => void) | null = null;
    async function* slow(): AsyncGenerator<Row> {
      for (let n = 1; n <= 5; n += 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        yield [n];
      }
    }
    const running = runExport({
      rows: slow,
      encoder: exportEncoder("csv", COLUMNS),
      sink: await openFileSink(join(folder, "slow.csv"), "t1"),
      signal: new AbortController().signal,
      stallMs: STALL_MS,
      clock,
    });
    for (let step = 0; step < 5; step += 1) {
      await settle();
      clock.advance(STALL_MS - 1);
      (release as (() => void) | null)?.();
    }

    await expect(running).resolves.toMatchObject({ rows: 5 });
  });

  it("givenAbort_whenRunning_thenCancelledAndPartRemoved", async () => {
    const controller = new AbortController();
    const target = join(folder, "c.csv");
    async function* endless(): AsyncGenerator<Row> {
      for (let n = 1; ; n += 1) {
        if (n === 100) controller.abort();
        yield [n];
        await settle();
      }
    }

    const failed = (await runExport({
      rows: endless,
      encoder: exportEncoder("csv", COLUMNS),
      sink: await openFileSink(target, "t1"),
      signal: controller.signal,
      stallMs: STALL_MS,
    }).catch((cause: unknown) => cause)) as ExportError;

    expect(failed.reason).toBe("cancelled");
    expect(failed.rows).toBeGreaterThanOrEqual(99);
    expect(await readdir(folder)).toEqual([]);
  });

  it("givenSourceThrows_whenRunning_thenSourceFailureWithRows", async () => {
    async function* broken(): AsyncGenerator<Row> {
      await Promise.resolve();
      yield [1];
      throw new Error("Connection terminated unexpectedly.");
    }

    const failed = (await runExport({
      rows: broken,
      encoder: exportEncoder("csv", COLUMNS),
      sink: await openFileSink(join(folder, "b.csv"), "t1"),
      signal: new AbortController().signal,
      stallMs: STALL_MS,
    }).catch((cause: unknown) => cause)) as ExportError;

    expect(failed.reason).toBe("source");
    expect(failed.message).toBe(
      "The export stopped: Connection terminated unexpectedly. 1 row was exported before it stopped; the partial file was removed.",
    );
    expect(await readdir(folder)).toEqual([]);
  });

  it("givenManyRows_whenRunning_thenProgressThrottled", async () => {
    const clock = fakeClock();
    const reports: ExportProgress[] = [];
    async function* ticking(): AsyncGenerator<Row> {
      await Promise.resolve();
      for (let n = 1; n <= 100; n += 1) {
        clock.advance(10);
        yield [n];
      }
    }

    await runExport({
      rows: ticking,
      encoder: exportEncoder("csv", COLUMNS),
      sink: await openFileSink(join(folder, "p.csv"), "t1"),
      signal: new AbortController().signal,
      stallMs: STALL_MS,
      clock,
      onProgress: (progress) => reports.push(progress),
    });

    expect(reports).toHaveLength(4 + 1);
    expect(reports.at(-1)).toMatchObject({ rows: 100, elapsedMs: 1_000 });
  });

  it("givenSlowSink_whenRunning_thenSourceReadsOnlyAfterWrites", async () => {
    let inFlight = 0;
    let read = 0;
    let maxAhead = 0;
    const real = await openFileSink(join(folder, "bp.csv"), "t1");
    const sink: FileSink = {
      path: real.path,
      partPath: real.partPath,
      get bytes() {
        return real.bytes;
      },
      async write(chunk) {
        inFlight += 1;
        await settle();
        await real.write(chunk);
        inFlight -= 1;
      },
      commit: () => real.commit(),
      abort: () => real.abort(),
    };
    async function* observed(): AsyncGenerator<Row> {
      await Promise.resolve();
      for (let n = 1; n <= 50; n += 1) {
        read += 1;
        maxAhead = Math.max(maxAhead, inFlight);
        yield [n];
      }
    }

    await runExport({
      rows: observed,
      encoder: exportEncoder("csv", COLUMNS),
      sink,
      signal: new AbortController().signal,
      stallMs: STALL_MS,
    });

    expect(read).toBe(50);
    expect(maxAhead).toBe(0);
  });

  it("givenPreviewBytes_whenRunning_thenClippedCounted", async () => {
    async function* blobs(): AsyncGenerator<Row> {
      await Promise.resolve();
      yield [{ kind: "bytes", preview: "00ff", length: 2 }];
      yield [{ kind: "bytes", preview: "00", length: 40 }];
    }

    const outcome = await runExport({
      rows: blobs,
      encoder: exportEncoder("csv", [{ name: "b", type: "bytea" }]),
      sink: await openFileSink(join(folder, "b.csv"), "t1"),
      signal: new AbortController().signal,
      stallMs: STALL_MS,
    });

    expect(outcome.clippedBytes).toBe(1);
    expect(await readFile(join(folder, "b.csv"), "utf8")).toBe("b\n0x00ff\n0x00…\n");
  });
});
