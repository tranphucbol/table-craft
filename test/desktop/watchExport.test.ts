import { describe, expect, it, vi } from "vitest";
import type { KeyWatchEvent } from "@table-craft/plugin-api";
import type { KeyTask } from "@table-craft/desktop/engine/protocol.js";
import type { KeyWatchSummary, KeyWatchWindow } from "@table-craft/desktop/engine/protocol.js";
import { engineRequestSchema } from "@table-craft/desktop/engine/requests.js";
import type { EngineOperationFiles } from "@table-craft/desktop/engine/keyOperations/files.js";
import type { KeyLocalJob, KeyTasks } from "@table-craft/desktop/engine/keyOperations/tasks.js";
import { KeyWatchRing, type KeyWatches } from "@table-craft/desktop/engine/keyOperations/watches.js";
import { captureRetainedWatch, watchExportOperations } from "@table-craft/desktop/engine/keyOperations/watchExport.js";

const BIG_REVISION = "9007199254740993";
const revision = { createRevision: "1", modRevision: BIG_REVISION, version: "1", lease: "0" };
const binary = { text: "\\xff\\x00", hex: "ff00" };
const put: KeyWatchEvent = { kind: "PUT", key: binary, value: binary, previous: null, revision };
const removed: KeyWatchEvent = {
  kind: "DELETE",
  key: { text: "/b", hex: null },
  value: null,
  previous: { key: { text: "/b", hex: null }, value: binary, revision },
  revision,
};
const request = {
  database: 0,
  range: { kind: "prefix", prefix: { text: "/", hex: null } },
  from: "5",
} as unknown as KeyWatchSummary["request"];
const gap = { reason: "compacted", fromRevision: "5", toRevision: "7" } as unknown as KeyWatchSummary["gap"];

function summaryOf(ring: KeyWatchRing): KeyWatchSummary {
  return {
    watchId: "w1",
    request,
    state: "live",
    completedRevision: BIG_REVISION,
    gap,
    evictedEvents: ring.evictions(),
  };
}

function windowOf(ring: KeyWatchRing): KeyWatchWindow {
  return { watchId: "w1", ...ring.window(null, 100, 1_000_000), state: "live", completedRevision: BIG_REVISION, gap };
}

function lines(chunks: readonly Uint8Array[]): unknown[] {
  return Buffer.concat(chunks)
    .toString("utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);
}

function fakeTasks() {
  const runs: Array<Promise<void>> = [];
  const controller = new AbortController();
  const progress = vi.fn();
  const tasks = {
    startLocal: vi.fn((kind: KeyTask["kind"], _capability: string, run: (job: KeyLocalJob) => Promise<void>) => {
      const job: KeyLocalJob = {
        signal: controller.signal,
        check: () => {
          if (controller.signal.aborted) throw new Error("Task cancelled.");
        },
        progress,
        beginWrite: vi.fn(),
        confirmed: vi.fn(),
        hashes: vi.fn(),
      };
      runs.push(run(job));
      return {
        taskId: `t${runs.length}`,
        kind,
        state: "running",
        completed: "0",
        total: null,
        error: null,
        outcome: "confirmed",
        resumable: false,
      } satisfies KeyTask;
    }),
  };
  return { tasks: tasks as unknown as KeyTasks, runs, controller, progress, startLocal: tasks.startLocal };
}

function fakeWatches(ring: KeyWatchRing) {
  return {
    capture: vi.fn((id: string, maxBytes: number) => {
      if (id !== "w1") throw new Error("No watch with this ID belongs to this connection.");
      return captureRetainedWatch(summaryOf(ring), windowOf(ring), maxBytes);
    }),
  } as unknown as KeyWatches;
}

describe("retained Watch JSONL export", () => {
  it("givenRetainedRing_whenCaptured_thenHeaderNamesRangeRevisionEvictionsAndGapAndEventsAreBinarySafe", () => {
    const ring = new KeyWatchRing(2, 1_000_000);
    ring.append(put);
    ring.append(put);
    ring.append(removed);
    const capture = captureRetainedWatch(summaryOf(ring), windowOf(ring), 1_000_000);
    const [header, ...events] = lines(capture.chunks);
    expect(header).toEqual({
      type: "header",
      format: "tablecraft-watch",
      version: 1,
      retainedOnly: true,
      watchId: "w1",
      request,
      state: "live",
      completedRevision: BIG_REVISION,
      gap,
      evictedEvents: "1",
      oldestSequence: "2",
      newestSequence: "3",
      eventCount: "2",
    });
    expect(events).toEqual([
      { type: "event", sequence: "2", event: put },
      { type: "event", sequence: "3", event: removed },
    ]);
    expect(typeof (events[0] as { event: KeyWatchEvent }).event.revision.modRevision).toBe("string");
    expect(capture.bytes).toBe(Buffer.concat(capture.chunks).byteLength);
  });

  it("givenCapture_whenRingAdvancesOrClears_thenSnapshotIsImmutable", () => {
    const ring = new KeyWatchRing(10, 1_000_000);
    ring.append(put);
    const capture = captureRetainedWatch(summaryOf(ring), windowOf(ring), 1_000_000);
    const before = Buffer.concat(capture.chunks).toString("utf8");
    ring.append(removed);
    ring.clear();
    expect(Buffer.concat(capture.chunks).toString("utf8")).toBe(before);
  });

  it("givenEmptyRingWithNullRevision_whenCaptured_thenOnlyHeaderWithNullBoundaries", () => {
    const ring = new KeyWatchRing(10, 1_000_000);
    const capture = captureRetainedWatch(
      { ...summaryOf(ring), completedRevision: null, gap: null, state: "stopped" },
      { ...windowOf(ring), completedRevision: null, gap: null },
      1_000_000,
    );
    expect(lines(capture.chunks)).toEqual([
      expect.objectContaining({
        completedRevision: null,
        gap: null,
        state: "stopped",
        oldestSequence: null,
        newestSequence: null,
        eventCount: "0",
      }),
    ]);
  });

  it("givenBudgetExceeded_whenCaptured_thenRejectsAndHoldsNothing", () => {
    const ring = new KeyWatchRing(10, 1_000_000);
    ring.append(put);
    ring.append(put);
    expect(() => captureRetainedWatch(summaryOf(ring), windowOf(ring), 400)).toThrow("capture budget");
  });

  it("givenCapture_whenDisposed_thenBytesAreZeroedAndReleased", () => {
    const ring = new KeyWatchRing(10, 1_000_000);
    ring.append(put);
    const capture = captureRetainedWatch(summaryOf(ring), windowOf(ring), 1_000_000);
    const held = [...capture.chunks];
    capture.dispose();
    expect(capture.chunks).toHaveLength(0);
    expect(held.every((chunk) => chunk.every((byte) => byte === 0))).toBe(true);
  });

  it("givenStart_whenPublished_thenAuthorizedWatchExportGrantGetsExactBytesAndTaskKindIsWatchExport", async () => {
    const ring = new KeyWatchRing(10, 1_000_000);
    ring.append(put);
    ring.append(removed);
    const published: Buffer[] = [];
    const publish = vi.fn(async (...args: Parameters<EngineOperationFiles["publish"]>) => {
      const source = args[2];
      const chunks: Uint8Array[] = [];
      for await (const chunk of source) chunks.push(Buffer.from(chunk));
      published.push(Buffer.concat(chunks));
    });
    const files: EngineOperationFiles = { read: vi.fn(), publish };
    const fake = fakeTasks();
    const task = watchExportOperations(fakeWatches(ring), fake.tasks, files).start({
      id: "r",
      type: "watch.exportStart",
      watchId: "w1",
      fileGrantId: "grant",
    } as never);
    expect(task.kind).toBe("watchExport");
    expect(fake.startLocal).toHaveBeenCalledWith("watchExport", "watch", expect.any(Function));
    await Promise.all(fake.runs);
    const call = publish.mock.calls[0]!;
    expect(call[0]).toBe("grant");
    expect(call[1]).toBe("watch.export");
    expect(call[3]).toBe(published[0]!.byteLength);
    expect(lines([published[0]!])).toHaveLength(3);
    expect(fake.progress).toHaveBeenLastCalledWith("2", "2");
  });

  it("givenUnknownWatchOrNoFileHost_whenStarted_thenRejectedWithoutTask", () => {
    const ring = new KeyWatchRing(10, 1_000_000);
    const fake = fakeTasks();
    const files = { read: vi.fn(), publish: vi.fn() } as unknown as EngineOperationFiles;
    expect(() =>
      watchExportOperations(fakeWatches(ring), fake.tasks, files).start({
        watchId: "foreign",
        fileGrantId: "g",
      } as never),
    ).toThrow();
    expect(() =>
      watchExportOperations(fakeWatches(ring), fake.tasks, undefined).start({
        watchId: "w1",
        fileGrantId: "g",
      } as never),
    ).toThrow("file operations");
    expect(fake.startLocal).not.toHaveBeenCalled();
  });

  it("givenTwoRunningExports_whenThirdStarted_thenRejectedUntilOneSettles", async () => {
    const ring = new KeyWatchRing(10, 1_000_000);
    ring.append(put);
    const gates: Array<() => void> = [];
    const files: EngineOperationFiles = {
      read: vi.fn(),
      publish: vi.fn(() => new Promise<void>((resolve) => gates.push(resolve))),
    };
    const fake = fakeTasks();
    const exports = watchExportOperations(fakeWatches(ring), fake.tasks, files);
    const start = () => exports.start({ watchId: "w1", fileGrantId: "g" } as never);
    start();
    start();
    expect(start).toThrow("Two Watch exports");
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    gates[0]!();
    await fake.runs[0];
    expect(start).not.toThrow();
    for (const gate of gates.slice(1)) gate();
  });

  it("givenCancelledTask_whenSourcePulled_thenPublicationStopsAndCaptureReleased", async () => {
    const ring = new KeyWatchRing(10, 1_000_000);
    ring.append(put);
    const fake = fakeTasks();
    const files: EngineOperationFiles = {
      read: vi.fn(),
      publish: vi.fn(async (_g, _o, source: AsyncIterable<Uint8Array>) => {
        fake.controller.abort();
        for await (const chunk of source) void chunk;
      }),
    };
    const exports = watchExportOperations(fakeWatches(ring), fake.tasks, files);
    exports.start({ watchId: "w1", fileGrantId: "g" } as never);
    await expect(fake.runs[0]).rejects.toThrow("cancelled");
    expect(() => exports.start({ watchId: "w1", fileGrantId: "g" } as never)).not.toThrow();
    await expect(fake.runs[1]).rejects.toThrow("cancelled");
  });

  it("givenWireRequests_whenParsed_thenStrictSchemaRejectsPathsAndExtraFields", () => {
    expect(
      engineRequestSchema.safeParse({ id: 1, type: "watch.exportStart", watchId: "w", fileGrantId: "g" }).success,
    ).toBe(true);
    expect(
      engineRequestSchema.safeParse({
        id: 1,
        type: "watch.exportStart",
        watchId: "w",
        fileGrantId: "g",
        path: "/tmp/x",
      }).success,
    ).toBe(false);
    expect(engineRequestSchema.safeParse({ id: 1, type: "watch.exportStart", watchId: "w" }).success).toBe(false);
    expect(
      engineRequestSchema.safeParse({ id: 1, type: "watch.exportStart", watchId: "", fileGrantId: "g" }).success,
    ).toBe(false);
    expect(engineRequestSchema.safeParse({ id: 1, type: "watch.exportList" }).success).toBe(true);
    expect(engineRequestSchema.safeParse({ id: 1, type: "watch.exportCancel", taskId: "t" }).success).toBe(true);
    expect(engineRequestSchema.safeParse({ id: 1, type: "watch.exportCancel" }).success).toBe(false);
  });
});
