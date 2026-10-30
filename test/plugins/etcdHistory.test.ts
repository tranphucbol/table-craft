import { EventEmitter } from "node:events";
import type { Call } from "@table-craft/plugin-etcd/admin";
import { describe, expect, it, vi } from "vitest";
import type { KeyHistoryRequest } from "@table-craft/plugin-api";
import { HistoryState, keyHistory } from "@table-craft/plugin-etcd/history";
import { EtcdKeyspace } from "@table-craft/plugin-etcd/keyspace";
import { applyPlan } from "@table-craft/plugin-etcd/writes";

const KEY = Buffer.from([0xff, 0, 0x61]);
type Etcd3 = Parameters<Parameters<Call>[0]>[0];
type IKeyValue = Awaited<ReturnType<Etcd3["kv"]["range"]>>["kvs"][number];
type IWatchRequest = Parameters<Awaited<ReturnType<Etcd3["watchClient"]["watch"]>>["write"]>[0];
const request: KeyHistoryRequest = {
  database: 0,
  key: { text: "binary", hex: KEY.toString("hex") },
  cursor: null,
  count: 10,
  maxBytes: 4096,
  timeoutMs: 100,
};

function kv(revision: string, value = Buffer.from([0xff, 0])): IKeyValue {
  return { key: KEY, value, create_revision: "1", mod_revision: revision, version: revision, lease: "0" };
}

function fixture(terminal: string | null, batches: readonly Record<string, unknown>[][], acquisition?: Promise<void>) {
  const state = new HistoryState();
  const snapshot = {
    revision: "9007199254741001",
    terminal,
    reads: 0,
    current: undefined as IKeyValue | null | undefined,
    compactedThrough: null as string | null,
    ranges: [] as (string | number | undefined)[],
  };
  const streams: Stream[] = [];
  class Stream extends EventEmitter {
    canceled = false;
    ended = false;
    canceledWhileWritable = false;
    start: string | number | undefined;
    write(value: IWatchRequest) {
      this.start = value.create_request?.start_revision;
      queueMicrotask(() => {
        for (const batch of batches[streams.indexOf(this)] ?? []) {
          if (!this.canceled) {
            if (batch.error !== undefined) this.emit("error", batch.error);
            else this.emit("data", { events: [], compact_revision: "0", ...batch });
          }
        }
      });
    }
    end() {
      this.ended = true;
    }
    cancel() {
      this.canceled = true;
      this.canceledWhileWritable = !this.ended;
    }
  }
  const client = {
    kv: {
      range: (range: { keys_only?: boolean; revision?: string | number }) => {
        if (range.keys_only === true) snapshot.reads++;
        else {
          snapshot.ranges.push(range.revision);
          if (
            range.revision !== undefined &&
            snapshot.compactedThrough !== null &&
            BigInt(range.revision) < BigInt(snapshot.compactedThrough)
          ) {
            return Promise.reject(new Error("etcdserver: mvcc: required revision has been compacted"));
          }
          if (range.revision === undefined && snapshot.current !== undefined) {
            return Promise.resolve({
              header: { revision: snapshot.revision },
              kvs: snapshot.current === null ? [] : [snapshot.current],
            });
          }
        }
        return Promise.resolve({
          header: { revision: snapshot.revision },
          kvs: snapshot.terminal === null ? [] : [kv(snapshot.terminal)],
        });
      },
    },
    watchClient: {
      watch: async () => {
        await acquisition;
        const stream = new Stream();
        streams.push(stream);
        return stream;
      },
    },
  } as unknown as Etcd3;
  const call = async <T>(work: (etcd: Etcd3) => Promise<T>) => work(client);
  return { call, streams, state, snapshot, history: (request: KeyHistoryRequest) => keyHistory(call, request, state) };
}

describe("etcd bounded history", () => {
  it("givenCreatedHeaderAheadOfEvents_whenReplaying_thenWaitForActualTerminalAndPreserveBinaryDeleteRecreate", async () => {
    const f = fixture("9007199254740995", [
      [
        { created: true, header: { revision: "9007199254741001" } },
        {
          events: [
            { type: "Put", kv: kv("9007199254740993") },
            { type: "Delete", kv: kv("9007199254740994", Buffer.alloc(0)) },
            { type: "Put", kv: kv("9007199254740995") },
          ],
        },
      ],
    ]);
    const page = await f.history(request);
    expect(page.complete).toBe(true);
    expect(page.events.map((e) => [e.kind, e.modRevision, e.value?.hex ?? null])).toEqual([
      ["PUT", "9007199254740993", "ff00"],
      ["DELETE", "9007199254740994", null],
      ["PUT", "9007199254740995", "ff00"],
    ]);
    expect(f.streams[0]?.start).toBe("1");
    expect(f.streams.every((s) => s.canceled)).toBe(true);
    // etcd3 resets every gRPC client of the connection when a still-writable stream errors.
    expect(f.streams.some((s) => s.canceledWhileWritable)).toBe(false);
  });

  it("givenPageLimit_whenContinuing_thenPinnedTerminalAndExactLastIncludedPlusOne", async () => {
    const f = fixture("9007199254740995", [
      [
        {
          events: [
            { type: "Put", kv: kv("9007199254740993") },
            { type: "Put", kv: kv("9007199254740995") },
          ],
        },
      ],
      [{ events: [{ type: "Put", kv: kv("9007199254740995") }] }],
    ]);
    const first = await f.history({ ...request, count: 1 });
    expect(first.stopReason).toBe("pageLimit");
    f.snapshot.revision = "9007199254741010";
    f.snapshot.terminal = "9007199254741009";
    const last = await f.history({ ...request, cursor: first.cursor });
    expect(last.complete).toBe(true);
    expect(last.snapshotRevision).toBe(first.snapshotRevision);
    expect(last.terminalRevision).toBe(first.terminalRevision);
    expect(f.snapshot.reads).toBe(1);
    expect(f.streams[1]?.start).toBe("9007199254740994");
  });

  it("givenSessionCursor_whenForgedTamperedCrossKeyOrCrossSession_thenRejectedBeforeServerAccess", async () => {
    const f = fixture("8", [[{ events: [{ type: "Put", kv: kv("7") }] }]]);
    const first = await f.history({ ...request, count: 1 });
    const cursor = first.cursor!;
    const other = fixture("8", []);
    await expect(other.history({ ...request, cursor })).rejects.toThrow(/invalid cursor/);
    expect(other.snapshot.reads).toBe(0);
    expect(other.streams).toHaveLength(0);
    await expect(f.history({ ...request, key: { text: "other", hex: null }, cursor })).rejects.toThrow(
      /invalid cursor/,
    );
    const [payload, signature] = cursor.split(".");
    const position = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as Record<string, unknown>;
    for (const field of ["snapshot", "terminal", "next", "unavailable", "key"]) {
      const tampered = Buffer.from(JSON.stringify({ ...position, [field]: "999" })).toString("base64url");
      await expect(f.history({ ...request, cursor: `${tampered}.${signature}` })).rejects.toThrow(/invalid cursor/);
    }
    await expect(f.history({ ...request, cursor: `${payload}.${"A".repeat(43)}` })).rejects.toThrow(/invalid cursor/);
    await expect(f.history({ ...request, cursor: payload! })).rejects.toThrow(/invalid cursor/);
    expect(f.streams).toHaveLength(1);
  });

  it("givenStreamError_whenReading_thenRejectAndCancel", async () => {
    const f = fixture("8", [[{ error: new Error("watch failed") }]]);
    await expect(f.history(request)).rejects.toThrow("watch failed");
    expect(f.streams[0]?.canceled).toBe(true);
  });

  it("givenActiveHistory_whenSessionKeyspaceCloses_thenRejectCancelAndInvalidateCursors", async () => {
    const f = fixture("8", [[]]);
    const keyspace = new EtcdKeyspace({
      delimiter: "/",
      scanBatch: 10,
      readOnly: false,
      queued: (work) => work(),
      call: f.call,
    });
    const pending = keyspace.history(request);
    const rejected = expect(pending).rejects.toMatchObject({ code: "connectionLost" });
    while (f.streams.length === 0) await Promise.resolve();
    await Promise.resolve();
    keyspace.close();
    await rejected;
    expect(f.streams[0]?.canceled).toBe(true);
    await expect(keyspace.history(request)).rejects.toMatchObject({ code: "connectionLost" });
  });

  it("givenDelayedAcquisition_whenSessionCloses_thenLateStreamCanceledWithoutWatchWrite", async () => {
    let acquire!: () => void;
    const acquisition = new Promise<void>((resolve) => {
      acquire = resolve;
    });
    const f = fixture("8", [], acquisition);
    const pending = f.history(request);
    const rejected = expect(pending).rejects.toMatchObject({ code: "connectionLost" });
    await Promise.resolve();
    f.state.close();
    acquire();
    await rejected;
    expect(f.streams[0]).toMatchObject({ canceled: true, start: undefined });
  });

  it("givenDelayedAcquisitionPastDeadline_whenStreamArrives_thenCancelWithoutWatchWrite", async () => {
    vi.useFakeTimers();
    try {
      let acquire!: () => void;
      const acquisition = new Promise<void>((resolve) => {
        acquire = resolve;
      });
      const f = fixture("8", [], acquisition);
      const pending = f.history({ ...request, timeoutMs: 1 });
      await vi.advanceTimersByTimeAsync(10);
      acquire();
      expect(await pending).toMatchObject({ events: [], complete: false, stopReason: "deadline" });
      expect(f.streams[0]).toMatchObject({ canceled: true, start: undefined });
    } finally {
      vi.useRealTimers();
    }
  });

  it("givenCompactionBeforeTerminal_whenRetrying_thenDiscloseGapAndResumeAfterCompaction", async () => {
    const f = fixture("8", [[{ canceled: true, compact_revision: "5" }], [{ events: [{ type: "Put", kv: kv("8") }] }]]);
    const page = await f.history(request);
    expect(page.complete).toBe(false);
    expect(page.unavailableThrough).toBe("5");
    expect(page.gaps).toEqual([{ fromRevision: "1", toRevision: "5", reason: "compacted" }]);
    expect(f.streams[1]?.start).toBe("6");
    expect(f.streams.every((s) => s.canceled)).toBe(true);
  });

  it("givenCompactionThroughTerminal_whenReading_thenCurrentVersionIsTheOnlyEvent", async () => {
    const f = fixture("8", [[{ canceled: true, compact_revision: "9" }]]);
    const page = await f.history(request);
    expect(page).toMatchObject({
      complete: false,
      cursor: null,
      stopReason: "compacted",
      unavailableThrough: "9",
      gaps: [{ fromRevision: "1", toRevision: "9", reason: "compacted" }],
    });
    expect(page.events.map((e) => [e.kind, e.modRevision, e.value?.hex ?? null])).toEqual([["PUT", "8", "ff00"]]);
    expect(f.snapshot.ranges).toEqual([undefined]);
    expect(f.streams).toHaveLength(1);
  });

  it("givenKeyChangedAfterSnapshot_whenTerminalCompacted_thenReadPinnedSnapshotVersion", async () => {
    const f = fixture("8", [[{ canceled: true, compact_revision: "9" }]]);
    f.snapshot.current = kv("9007199254741005");
    const page = await f.history(request);
    expect(page.events.map((e) => e.modRevision)).toEqual(["8"]);
    expect(f.snapshot.ranges).toEqual([undefined, f.snapshot.revision]);
  });

  it("givenSnapshotItselfCompactedAfterChange_whenTerminalCompacted_thenNoInventedEvent", async () => {
    const f = fixture("8", [[{ canceled: true, compact_revision: "9" }]]);
    f.snapshot.current = null;
    f.snapshot.compactedThrough = "9007199254741002";
    const page = await f.history(request);
    expect(page).toMatchObject({ events: [], cursor: null, stopReason: "compacted", unavailableThrough: "9" });
  });

  it("givenCompactedTerminalOverByteBudget_whenReading_thenExplicitError", async () => {
    const f = fixture("8", [[{ canceled: true, compact_revision: "9" }]]);
    await expect(f.history({ ...request, maxBytes: 2 })).rejects.toThrow(/exceeds the byte limit/);
  });

  it("givenRepeatedCompaction_whenRetryBudgetExhausted_thenBoundedPartialAndEveryStreamCanceled", async () => {
    const f = fixture("99", [
      [{ canceled: true, compact_revision: "5" }],
      [{ canceled: true, compact_revision: "6" }],
      [{ canceled: true, compact_revision: "7" }],
    ]);
    const page = await f.history(request);
    expect(page).toMatchObject({ complete: false, unavailableThrough: "7", stopReason: "compacted" });
    expect(f.streams).toHaveLength(3);
    expect(f.streams.every((s) => s.canceled)).toBe(true);
  });

  it("givenByteBudget_whenNextEventDoesNotFit_thenResumeAfterLastIncludedNotDroppedEvent", async () => {
    const f = fixture("8", [
      [
        {
          events: [
            { type: "Put", kv: kv("7") },
            { type: "Put", kv: kv("8") },
          ],
        },
      ],
      [{ events: [{ type: "Put", kv: kv("8") }] }],
    ]);
    const page = await f.history({ ...request, maxBytes: 5 });
    expect(page.stopReason).toBe("byteLimit");
    expect(page.events).toHaveLength(1);
    const last = await f.history({ ...request, cursor: page.cursor });
    expect(f.streams[1]?.start).toBe("8");
    expect(last.complete).toBe(true);
  });

  it("givenMissingKeyAndOnlyProgress_whenDeadline_thenPartialNotCompleteAndStreamCanceled", async () => {
    const f = fixture(null, [
      [{ created: true, header: { revision: "9007199254741001" } }, { header: { revision: "9007199254741001" } }],
    ]);
    const page = await f.history({ ...request, timeoutMs: 10 });
    expect(page).toMatchObject({ events: [], terminalRevision: null, complete: false, stopReason: "deadline" });
    expect(f.streams[0]?.canceled).toBe(true);
  });

  it("givenOversizedEvent_whenReading_thenExplicitErrorAndCanceledStream", async () => {
    const f = fixture("8", [[{ events: [{ type: "Put", kv: kv("8", Buffer.alloc(500)) }] }]]);
    await expect(f.history({ ...request, maxBytes: 100 })).rejects.toThrow(/exceeds the byte limit/);
    expect(f.streams[0]?.canceled).toBe(true);
  });
});

describe("etcd lease ownership", () => {
  function host(error: Error) {
    const revoked: string[] = [];
    let granted = 0;
    const client = {
      kv: {
        txn: () => Promise.reject(error),
      },
      leaseClient: {
        leaseGrant: () => {
          granted++;
          return Promise.resolve({ ID: "42" });
        },
        leaseRevoke: ({ ID }: { ID: string }) => {
          revoked.push(ID);
          return Promise.resolve();
        },
      },
    } as unknown as Etcd3;
    const keyspace = new EtcdKeyspace({
      delimiter: "/",
      scanBatch: 10,
      readOnly: false,
      queued: (work) => work(),
      call: (work) => work(client),
    });
    return { keyspace, revoked, grants: () => granted };
  }
  const changes = [{ kind: "setString" as const, value: { text: "new", hex: null }, original: null }];
  const options = { type: "string" as const, guard: true, ttlMs: 1000 };

  it("givenInvalidPlan_whenApplying_thenNoLeaseAcquired", async () => {
    const f = host(new Error("unused"));
    await expect(f.keyspace.apply(0, request.key, [], options)).rejects.toThrow(/Nothing to apply/);
    expect(f.grants()).toBe(0);
  });
  it("givenPermissionDeniedBeforeCommit_whenApplying_thenOwnedLeaseRevoked", async () => {
    const f = host(new Error("permission denied"));
    await expect(f.keyspace.apply(0, request.key, changes, options)).rejects.toThrow(/permission denied/);
    expect(f.revoked).toEqual(["42"]);
  });
  it("givenUnknownTransportOutcome_whenApplying_thenLeaseNotBlindlyRevoked", async () => {
    const f = host(new Error("UNAVAILABLE: transport closed"));
    await expect(f.keyspace.apply(0, request.key, changes, options)).rejects.toThrow(/UNAVAILABLE/);
    expect(f.revoked).toEqual([]);
  });
});

describe("etcd revision conflict snapshot", () => {
  it("givenFailedTxnWithBinaryCurrent_whenApplying_thenMergeUsesAtomicBranchNotRacyReread", async () => {
    const current = kv("9007199254740993");
    const client = {
      kv: {
        range: () => Promise.reject(new Error("must not reread")),
        txn: () =>
          Promise.resolve({
            succeeded: false,
            header: { revision: "9007199254740994" },
            responses: [{ response_range: { kvs: [current] } }],
          }),
      },
    } as unknown as Etcd3;
    const keyspace = new EtcdKeyspace({
      delimiter: "/",
      scanBatch: 10,
      readOnly: false,
      queued: (work) => work(),
      call: (work) => work(client),
    });
    await expect(
      keyspace.apply(
        0,
        request.key,
        [{ kind: "setString", value: { text: "mine", hex: null }, original: { text: "old", hex: null } }],
        { type: "string", guard: false, revisionGuard: { modRevision: "9007199254740992" } },
      ),
    ).rejects.toMatchObject({
      code: "conflict",
      current: {
        database: 0,
        key: request.key,
        value: { hex: "ff00" },
        revision: { modRevision: "9007199254740993" },
        snapshotRevision: "9007199254740994",
      },
    });
  });

  it("givenStructuredGuard_whenPlanning_thenExactRevisionOverridesValueGuardAndAbsentGuardCreates", () => {
    const changes = [
      { kind: "setString" as const, value: { text: "mine", hex: null }, original: { text: "old", hex: null } },
    ];
    const options = { type: "string" as const, guard: false, revisionGuard: { modRevision: "9007199254740993" } };
    const plan = applyPlan(request.key, changes, options, null);
    expect(plan.guarded).toBe(true);
    expect(plan.request.compare?.[0]).toMatchObject({ target: "Mod", mod_revision: "9007199254740993" });
    const absent = applyPlan(request.key, changes, { ...options, revisionGuard: { modRevision: "0" } }, null);
    expect(absent.request.success?.[0]?.request_put?.ignore_lease).toBe(false);
  });
});
