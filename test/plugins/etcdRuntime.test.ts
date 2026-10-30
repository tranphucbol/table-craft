import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { Call } from "@table-craft/plugin-etcd/admin";
import { NamespaceMapper, namespaceCall } from "@table-craft/plugin-etcd/namespace";
import { RuntimeState, type RuntimeHost } from "@table-craft/plugin-etcd/runtime";
import { EtcdKeyRanges } from "@table-craft/plugin-etcd/keyRanges";
import { EtcdLeases } from "@table-craft/plugin-etcd/leases";
import { EtcdAccess } from "@table-craft/plugin-etcd/access";
import { EtcdTransfer } from "@table-craft/plugin-etcd/transfer";
import { EtcdWatcher } from "@table-craft/plugin-etcd/watch";
import { EtcdCluster } from "@table-craft/plugin-etcd/cluster";
import { EtcdClient, type ClientSettings } from "@table-craft/plugin-etcd/client";
import { connectionSchema } from "@table-craft/plugin-etcd/config";
import type { Connection } from "@table-craft/plugin-etcd/connect";
import { applyPlan } from "@table-craft/plugin-etcd/writes";

type Etcd3 = Parameters<Parameters<Call>[0]>[0];
type Kv = Awaited<ReturnType<Etcd3["kv"]["range"]>>["kvs"][number];
const text = (value: string) => ({ text: value, hex: null });
const HEADER = { revision: "9007199254740993", cluster_id: "7", member_id: "9", raft_term: "1" };
function kv(key = "key", revision = HEADER.revision): Kv {
  return {
    key: Buffer.from(key),
    value: Buffer.from("value"),
    create_revision: "1",
    mod_revision: revision,
    version: "2",
    lease: "42",
  };
}
function host(fake: unknown, prefix = "", readOnly = false): RuntimeHost {
  const globalCall: Call = (work) => work(fake as Etcd3);
  const namespace = new NamespaceMapper(Buffer.from(prefix));
  return {
    globalCall,
    call: namespaceCall(globalCall, namespace),
    namespace,
    state: new RuntimeState(),
    readOnly,
    clusterId: "7",
  };
}
class Stream extends EventEmitter {
  readonly writes: unknown[] = [];
  cancelled = false;
  ended = false;
  readonly pause = vi.fn();
  readonly resume = vi.fn();
  write(request: unknown) {
    this.writes.push(request);
  }
  end() {
    this.ended = true;
  }
  cancel() {
    this.cancelled = true;
  }
}
const limits = { count: 1, maxBytes: 4096, timeoutMs: 1 };
function response(events: unknown[] = [], extra: object = {}) {
  return { header: HEADER, created: false, canceled: false, compact_revision: "0", events, fragment: false, ...extra };
}

describe("etcd scoped runtime", () => {
  it("givenNonBufferKey_whenScoped_thenRejectBeforeSendingInsteadOfEscapingNamespace", async () => {
    const range = vi.fn();
    const runtime = host({ kv: { range }, watchClient: {} }, "tenant/");
    await expect(runtime.call((etcd) => etcd.kv.range({ key: "outside" as unknown as Buffer }))).rejects.toThrow(
      "Buffer bytes",
    );
    expect(range).not.toHaveBeenCalled();
    range.mockResolvedValue({ kvs: [{ key: "tenant/key" }] });
    await expect(runtime.call((etcd) => etcd.kv.range({ key: Buffer.from("key") }))).rejects.toThrow("non-Buffer key");
    await runtime.state.close();
  });
  it("givenNamespace_whenNestedTxnRuns_thenRequestsAndResponsesAreMappedOnce", async () => {
    const txn = vi.fn().mockResolvedValue({
      header: HEADER,
      responses: [{ response_txn: { responses: [{ response_range: { kvs: [kv("tenant/key")] } }] } }],
    });
    const scoped = namespaceCall(
      (work) => work({ kv: { txn }, watchClient: {} } as unknown as Etcd3),
      new NamespaceMapper(Buffer.from("tenant/")),
      true,
    );
    const result = await scoped((etcd) =>
      etcd.kv.txn({
        compare: [{ key: Buffer.from("key"), target: "Mod", mod_revision: HEADER.revision }],
        success: [{ request_txn: { success: [{ request_range: { key: Buffer.from("key") } }] } }],
      }),
    );
    expect(txn.mock.calls[0]?.[0]).toMatchObject({
      compare: [{ key: Buffer.from("tenant/key") }],
      success: [
        { request_txn: { success: [{ request_range: { key: Buffer.from("tenant/key"), serializable: true } }] } },
      ],
    });
    expect(result.responses[0]?.response_txn?.responses[0]?.response_range?.kvs[0]?.key).toEqual(Buffer.from("key"));
  });

  it("givenAllAndFromKeyRanges_whenScoped_thenUpperSentinelNeverEscapesNamespace", () => {
    const mapper = new NamespaceMapper(Buffer.from([0x61, 0xff]));
    expect(mapper.range({ kind: "all" })).toEqual({ key: Buffer.from([0x61, 0xff]), range_end: Buffer.from("b") });
    expect(mapper.rawRange(Buffer.from("x"), Buffer.from([0]))).toEqual({
      key: Buffer.from([0x61, 0xff, 0x78]),
      range_end: Buffer.from("b"),
    });
    expect(() => mapper.strip(Buffer.from("outside"))).toThrow("outside");
  });

  it("givenNamespace_whenWatchListenersChain_thenPreviousAndCurrentKeysAreBothRelative", async () => {
    const stream = new Stream();
    const runtime = host({ kv: {}, watchClient: { watch: () => Promise.resolve(stream) } }, "tenant/");
    const scoped = await runtime.call((etcd) => etcd.watchClient.watch());
    const received = vi.fn();
    scoped.on("error", () => undefined).on("data", received);
    stream.emit("data", response([{ kv: kv("tenant/key"), prev_kv: kv("tenant/key") }]));
    expect((received.mock.calls[0]?.[0] as { events: unknown[] } | undefined)?.events[0]).toMatchObject({
      kv: { key: Buffer.from("key") },
      prev_kv: { key: Buffer.from("key") },
    });
    scoped.write({ create_request: { key: Buffer.from([0]), range_end: Buffer.from([0]) } });
    expect(stream.writes[0]).toMatchObject({
      create_request: { key: Buffer.from("tenant/"), range_end: Buffer.from("tenant0") },
    });
    await runtime.state.close();
  });

  it("givenPreview_whenCommitting_thenRevisionGuardAndDeleteShareOneTxnAndTokenIsConsumed", async () => {
    const range = vi.fn().mockResolvedValue({ header: HEADER, count: "1", kvs: [kv("tenant/key")] });
    const txn = vi
      .fn()
      .mockResolvedValue({ header: HEADER, succeeded: true, responses: [{ response_delete_range: { deleted: "1" } }] });
    const runtime = host({ kv: { range, txn }, watchClient: {} }, "tenant/");
    const ranges = new EtcdKeyRanges(runtime, "/");
    const preview = await ranges.prepareDelete(0, { kind: "all" });
    expect(preview.sampleKeys).toEqual([text("key")]);
    await expect(ranges.deletePrepared(preview.token)).resolves.toMatchObject({ deleted: "1" });
    expect(txn.mock.calls[0]?.[0]).toMatchObject({
      compare: [
        {
          key: Buffer.from("tenant/"),
          range_end: Buffer.from("tenant0"),
          target: "Mod",
          result: "Less",
          mod_revision: "9007199254740994",
        },
      ],
      success: [{ request_delete_range: { key: Buffer.from("tenant/") } }],
    });
    await expect(ranges.deletePrepared(preview.token)).rejects.toThrow("already used");
    expect(txn).toHaveBeenCalledTimes(1);
    await runtime.state.close();
  });

  it("givenSessionCursor_whenReusedElsewhereOrAfterClose_thenRejected", async () => {
    const first = new RuntimeState();
    const second = new RuntimeState();
    const cursor = first.cursor({ binding: "export", revision: HEADER.revision });
    expect(() => second.read(cursor, "export")).toThrow("cursor");
    expect(() => first.read(cursor, "children")).toThrow("cursor");
    await first.close();
    expect(() => first.read(cursor, "export")).toThrow("closed");
    await second.close();
  });
});

describe("etcd lease and administrative safety", () => {
  it("givenGuardTxnFalse_whenDeletingOrImporting_thenTypedConflictProvesNoCommit", async () => {
    const range = vi.fn().mockResolvedValue({ header: HEADER, count: "1", kvs: [kv()] });
    const txn = vi.fn().mockResolvedValue({ header: HEADER, succeeded: false, responses: [] });
    const runtime = host({ kv: { range, txn }, watchClient: {} });
    const ranges = new EtcdKeyRanges(runtime, "/");
    const preview = await ranges.prepareDelete(0, { kind: "all" });
    await expect(ranges.deletePrepared(preview.token)).rejects.toMatchObject({ code: "conflict" });
    await expect(
      new EtcdTransfer(runtime).importChunk(
        [{ key: text("key"), value: text("v"), expectedModRevision: "1" }],
        "ifUnchanged",
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(txn).toHaveBeenCalledTimes(2);
    await runtime.state.close();
  });

  it.each(["error", "end", "timeout", "expired"])(
    "givenRenewalDeath%s_whenObserved_thenStopWithReasonAndCleanResources",
    async (event) => {
      vi.useFakeTimers();
      try {
        const stream = new Stream();
        const leaseRevoke = vi.fn();
        const runtime = host({
          kv: {},
          watchClient: {},
          leaseClient: { leaseKeepAlive: () => Promise.resolve(stream), leaseRevoke },
        });
        const pending = new EtcdLeases(runtime).keepAlive("42");
        await vi.advanceTimersByTimeAsync(0);
        stream.emit("data", { ID: "42", TTL: "3" });
        const renewal = (await pending) as Awaited<typeof pending> & {
          onClosed(listener: (reason: string) => void): void;
        };
        const stopped = vi.fn();
        renewal.onClosed(stopped);
        if (event === "timeout") await vi.advanceTimersByTimeAsync(6000);
        else if (event === "expired") stream.emit("data", { ID: "42", TTL: "0" });
        else stream.emit(event, event === "error" ? new Error("private driver detail") : undefined);
        expect(stopped).toHaveBeenCalledTimes(1);
        expect(stopped.mock.calls[0]?.[0]).toMatch(/renewal|renew|expired/i);
        expect(stream.cancelled).toBe(true);
        const writes = stream.writes.length;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(stream.writes).toHaveLength(writes);
        await runtime.state.close();
        expect(leaseRevoke).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it("givenConfiguredRootWithoutVerifiedPassword_whenEnablingAuth_thenRefuseBeforeMutation", async () => {
    const authEnable = vi.fn();
    const runtime = host({
      kv: {},
      watchClient: {},
      auth: {
        userList: () => Promise.resolve({ users: ["root"] }),
        userGet: () => Promise.resolve({ roles: ["root"] }),
        authEnable,
      },
    });
    await expect(new EtcdAccess(runtime, "root", true).apply({ kind: "enableAuth" })).rejects.toMatchObject({
      outcome: "notApplied",
      message: expect.stringContaining("cannot verify") as unknown,
    });
    expect(authEnable).not.toHaveBeenCalled();
    await runtime.state.close();
  });

  it("givenSelfLockout_whenRevokingAccess_thenDefiniteRefusalBeforeMutation", async () => {
    const userDelete = vi.fn();
    const runtime = host({
      kv: {},
      watchClient: {},
      auth: {
        userList: () => Promise.resolve({ users: ["root"] }),
        userGet: () => Promise.resolve({ roles: ["root"] }),
        userDelete,
      },
    });
    await expect(
      new EtcdAccess(runtime, "root", true).apply({ kind: "deleteUser", user: "root" }),
    ).rejects.toMatchObject({ outcome: "notApplied" });
    expect(userDelete).not.toHaveBeenCalled();
    await runtime.state.close();
  });

  it("givenCredentialDriverFailure_whenApplyingSecret_thenNeverExposeSecretOrRawCause", async () => {
    const password = "private-password-never-returned";
    const runtime = host({
      kv: {},
      watchClient: {},
      auth: {
        userAdd: async () => {
          await Promise.resolve();
          throw new Error(password);
        },
      },
    });
    const failure = await new EtcdAccess(runtime, "root", true)
      .applySecret({ kind: "createUser", user: "another", password })
      .catch((error: unknown) => error);
    expect(String(failure)).toContain("not confirmed");
    expect(String(failure)).not.toContain(password);
    expect(failure).not.toHaveProperty("cause");
    await runtime.state.close();
  });

  it.each([{ kind: "preserve" as const }, { kind: "detach" as const }, { kind: "attach" as const, leaseId: "42" }])(
    "givenLeaseAssignment%s_whenPlanningValue_thenLeaseSemanticsAreExplicit",
    (lease) => {
      const plan = applyPlan(
        text("key"),
        [{ kind: "setString", value: text("new"), original: text("old") }],
        { type: "string", guard: true, lease },
        null,
      );
      expect(plan.request.success?.[0]?.request_put).toMatchObject(
        lease.kind === "preserve"
          ? { ignore_lease: true }
          : { ignore_lease: false, lease: lease.kind === "attach" ? "42" : "0" },
      );
    },
  );

  it("givenLeaseOnlyEdit_whenPlanning_thenPreserveValueAndRequireExistingKey", () => {
    const plan = applyPlan(text("key"), [], { type: "string", guard: false, lease: { kind: "detach" } }, null);
    expect(plan.request.success?.[0]?.request_put).toMatchObject({ ignore_value: true, lease: "0" });
    expect(plan.request.compare?.[0]).toMatchObject({ target: "Create", result: "Greater", create_revision: "0" });
    expect(plan.guarded).toBe(true);
  });

  it("givenSharedLease_whenPreviewed_thenCountsIncludeOutsideNamespaceButKeysRemainRelative", async () => {
    const leaseTimeToLive = vi.fn().mockResolvedValue({
      ID: "42",
      TTL: "60",
      grantedTTL: "60",
      keys: [Buffer.from("tenant/key"), Buffer.from("outside")],
    });
    const leaseRevoke = vi.fn().mockResolvedValue({});
    const runtime = host({ kv: {}, watchClient: {}, leaseClient: { leaseTimeToLive, leaseRevoke } }, "tenant/");
    const leases = new EtcdLeases(runtime);
    const preview = await leases.prepareRevoke("42");
    expect(preview.lease).toMatchObject({ scopedKeyCount: "1", totalKeyCount: "2", outsideNamespaceKeyCount: "1" });
    expect(preview.sampleKeys).toEqual([text("key")]);
    leaseTimeToLive.mockResolvedValue({
      ID: "42",
      TTL: "60",
      grantedTTL: "60",
      keys: [Buffer.from("tenant/key"), Buffer.from("outside"), Buffer.from("new")],
    });
    await expect(leases.revokePrepared(preview.token)).rejects.toMatchObject({
      outcome: "notApplied",
      message: expect.stringContaining("attachments changed") as unknown,
    });
    expect(leaseRevoke).not.toHaveBeenCalled();
    await runtime.state.close();
  });

  it("givenKeepAlive_whenClosed_thenStreamCancelledWithoutRevoke", async () => {
    const stream = new Stream();
    const leaseRevoke = vi.fn();
    const runtime = host({
      kv: {},
      watchClient: {},
      leaseClient: { leaseKeepAlive: () => Promise.resolve(stream), leaseRevoke },
    });
    const pending = new EtcdLeases(runtime).keepAlive("42");
    await vi.waitFor(() => expect(stream.writes).toHaveLength(1));
    stream.emit("data", { ID: "42", TTL: "30" });
    const renewal = await pending;
    await renewal.close();
    await runtime.state.close();
    expect(stream.cancelled).toBe(true);
    expect(leaseRevoke).not.toHaveBeenCalled();
  });

  it("givenReadOnly_whenCallingMutations_thenNoRpcSent", async () => {
    const call = vi.fn();
    const runtime = host({}, "", true);
    const guarded = { ...runtime, call, globalCall: call };
    await expect(new EtcdLeases(guarded).grant("60")).rejects.toThrow("Read-only");
    await expect(new EtcdAccess(guarded, "root", true).apply({ kind: "disableAuth" })).rejects.toThrow("Read-only");
    await expect(
      new EtcdTransfer(guarded).importChunk(
        [{ key: text("key"), value: text("v"), expectedModRevision: null }],
        "overwrite",
      ),
    ).rejects.toThrow("Read-only");
    expect(call).not.toHaveBeenCalled();
    await runtime.state.close();
  });

  it("givenUnknownImportOutcome_whenApplying_thenMutationIsNotReplayed", async () => {
    const txn = vi.fn().mockRejectedValue(new Error("Outcome unknown"));
    const runtime = host({ kv: { txn }, watchClient: {} });
    await expect(
      new EtcdTransfer(runtime).importChunk(
        [{ key: text("key"), value: text("v"), expectedModRevision: null }],
        "overwrite",
      ),
    ).rejects.toThrow("unknown");
    expect(txn).toHaveBeenCalledTimes(1);
    await runtime.state.close();
  });
});

describe("etcd managed Watch lifecycle", () => {
  it("givenDisconnectMidRevision_whenReconnecting_thenResumeCompletedCheckpointWithoutDuplicatingPartialDelivery", async () => {
    const streams: Stream[] = [];
    const runtime = host({
      kv: {},
      watchClient: {
        watch: async () => {
          await Promise.resolve();
          const stream = new Stream();
          streams.push(stream);
          return stream;
        },
      },
    });
    const watch = await new EtcdWatcher(runtime).open({
      database: 0,
      range: { kind: "all" },
      from: { kind: "revision", revision: "10" },
    });
    try {
      await vi.waitFor(() => expect(streams[0]?.writes).toHaveLength(1));
      const events = ["a", "b"].map((key) => ({ type: "Put", kv: kv(key, "10"), prev_kv: null }));
      streams[0]!.emit("data", response(events));
      expect((await watch.next(limits)).events[0]?.key.text).toBe("a");
      streams[0]!.emit("error", new Error("unavailable"));
      await vi.waitFor(() => expect(streams[1]?.writes).toHaveLength(1));
      expect(streams[1]!.writes[0]).toMatchObject({ create_request: { start_revision: "10" } });
      streams[1]!.emit("data", response(events));
      const replayed = await watch.next(limits);
      expect(replayed.events.map((event) => event.key.text)).toEqual(["b"]);
      expect(replayed.completedRevision).toBe("10");
      streams[1]!.emit("error", new Error("unavailable"));
      await vi.waitFor(() => expect(streams[2]?.writes).toHaveLength(1));
      expect(streams[2]!.writes[0]).toMatchObject({ create_request: { start_revision: "11" } });
    } finally {
      await runtime.state.close();
    }
  });

  it("givenEventLargerThanPullBudget_whenPulling_thenExplicitTerminalGapWithoutAdvancing", async () => {
    const stream = new Stream();
    const runtime = host({ kv: {}, watchClient: { watch: () => Promise.resolve(stream) } });
    const watch = await new EtcdWatcher(runtime).open({
      database: 0,
      range: { kind: "all" },
      from: { kind: "revision", revision: "1" },
    });
    await vi.waitFor(() => expect(stream.writes).toHaveLength(1));
    stream.emit("data", response([{ type: "Put", kv: kv(), prev_kv: null }]));
    await expect(watch.next({ ...limits, maxBytes: 1 })).resolves.toMatchObject({
      events: [],
      state: "gap",
      completedRevision: null,
      gap: { reason: "eventTooLarge" },
    });
    await expect(watch.next(limits)).resolves.toMatchObject({ events: [], state: "gap", completedRevision: null });
    await runtime.state.close();
  });

  it("givenOneRevisionSplitAcrossPulls_whenDelivering_thenAdvanceOnlyAfterLastEventAndIgnoreCreationHeader", async () => {
    const stream = new Stream();
    const runtime = host({ kv: {}, watchClient: { watch: () => Promise.resolve(stream) } });
    const watch = await new EtcdWatcher(runtime).open({
      database: 0,
      range: { kind: "all" },
      from: { kind: "revision", revision: HEADER.revision },
    });
    await vi.waitFor(() => expect(stream.writes).toHaveLength(1));
    stream.emit("data", response([], { created: true }));
    expect((await watch.next(limits)).completedRevision).toBeNull();
    stream.emit("data", response([{ type: "Put", kv: kv("a"), prev_kv: null }], { fragment: true }));
    expect((await watch.next(limits)).events).toEqual([]);
    stream.emit("data", response([{ type: "Put", kv: kv("b"), prev_kv: null }]));
    const first = await watch.next(limits);
    expect(first.events.map((event) => event.key.text)).toEqual(["a"]);
    expect(first.completedRevision).toBeNull();
    const last = await watch.next(limits);
    expect(last.events.map((event) => event.key.text)).toEqual(["b"]);
    expect(last.completedRevision).toBe(HEADER.revision);
    await runtime.state.close();
    expect(stream.cancelled).toBe(true);
    expect((await watch.next(limits)).state).toBe("stopped");
  });

  it("givenCompactedStart_whenServerCancels_thenExplicitGapWithoutCreationAckCheckpoint", async () => {
    const stream = new Stream();
    const runtime = host({ kv: {}, watchClient: { watch: () => Promise.resolve(stream) } });
    const watch = await new EtcdWatcher(runtime).open({
      database: 0,
      range: { kind: "all" },
      from: { kind: "revision", revision: "1" },
    });
    await vi.waitFor(() => expect(stream.writes).toHaveLength(1));
    stream.emit("data", response([], { canceled: true, compact_revision: HEADER.revision }));
    await expect(watch.next(limits)).resolves.toMatchObject({
      state: "gap",
      completedRevision: null,
      gap: { reason: "compacted", fromRevision: "1", toRevision: HEADER.revision },
    });
    await runtime.state.close();
  });

  it("givenLateStreamOpen_whenSessionAlreadyClosed_thenCancelImmediately", async () => {
    const stream = new Stream();
    let resolve!: (value: unknown) => void;
    const opened = new Promise((done) => {
      resolve = done;
    });
    const runtime = host({ kv: {}, watchClient: { watch: () => opened } });
    await new EtcdWatcher(runtime).open({
      database: 0,
      range: { kind: "all" },
      from: { kind: "revision", revision: "1" },
    });
    await runtime.state.close();
    resolve(stream);
    await vi.waitFor(() => expect(stream.cancelled).toBe(true));
  });
});

describe("etcd snapshot final status", () => {
  function snapshotHost() {
    const stream = new Stream();
    const status = {
      header: HEADER,
      leader: "9",
      version: "3.6.5",
      dbSize: "1",
      dbSizeInUse: "1",
      raftTerm: "1",
      raftIndex: "1",
      raftAppliedIndex: "1",
    };
    const settings: ClientSettings = {
      address: "127.0.0.1:2379",
      tls: null,
      user: "",
      password: "",
      maxMessageMb: 16,
      connectTimeoutMs: 1000,
    };
    const createClient = (configuration: ClientSettings) =>
      new EtcdClient(
        configuration,
        () =>
          ({
            maintenance: { status: () => Promise.resolve(status), snapshot: () => Promise.resolve(stream) },
            close() {},
          }) as unknown as Etcd3,
      );
    const client = createClient({ ...settings, endpoints: [{ id: "primary", address: settings.address, tls: null }] });
    const connection: Connection = {
      client,
      address: settings.address,
      version: status.version,
      clusterId: HEADER.cluster_id,
      config: connectionSchema.parse({}),
      endpoints: [{ id: "primary", reachable: true }],
    };
    const runtime = { ...host({}), clusterId: HEADER.cluster_id };
    return { stream, client, runtime, cluster: new EtcdCluster(runtime, connection, createClient) };
  }

  it("givenSlowConsumer_whenBufferReachesHighWater_thenPauseAndResumeAtLowWaterWithoutLosingBytes", async () => {
    const fixture = snapshotHost();
    try {
      const snapshot = await fixture.cluster.snapshot("primary");
      const chunk = Buffer.alloc(4_194_304, 7);
      const expectChunk = (value: unknown) => {
        expect(Buffer.isBuffer(value) && value.equals(chunk)).toBe(true);
      };
      fixture.stream.emit("data", { blob: chunk });
      fixture.stream.emit("data", { blob: chunk });
      expect(fixture.stream.pause).toHaveBeenCalledTimes(1);
      const iterator = snapshot.chunks[Symbol.asyncIterator]();
      expectChunk((await iterator.next()).value);
      expect(fixture.stream.resume).toHaveBeenCalledTimes(1);
      fixture.stream.emit("data", { blob: chunk });
      expect(fixture.stream.pause).toHaveBeenCalledTimes(2);
      expectChunk((await iterator.next()).value);
      expectChunk((await iterator.next()).value);
      for (let batch = 0; batch < 4; batch++) {
        fixture.stream.emit("data", { blob: chunk });
        fixture.stream.emit("data", { blob: chunk });
        expectChunk((await iterator.next()).value);
        expectChunk((await iterator.next()).value);
      }
      fixture.stream.emit("end");
      fixture.stream.emit("status", { code: 0 });
      expect((await iterator.next()).done).toBe(true);
    } finally {
      await fixture.runtime.state.close();
      fixture.client.close();
    }
  });

  it("givenPausedSnapshot_whenCancelledOrDriverIgnoresPause_thenBoundMemoryAndCancelStream", async () => {
    const fixture = snapshotHost();
    try {
      const snapshot = await fixture.cluster.snapshot("primary");
      const chunk = Buffer.alloc(8_388_608);
      fixture.stream.emit("data", { blob: chunk });
      expect(fixture.stream.pause).toHaveBeenCalledTimes(1);
      fixture.stream.emit("data", { blob: chunk });
      fixture.stream.emit("data", { blob: Buffer.from("overflow") });
      await expect(snapshot.chunks[Symbol.asyncIterator]().next()).rejects.toThrow("bounded stream buffer");
      expect(fixture.stream.cancelled).toBe(true);
      await snapshot.close();
    } finally {
      await fixture.runtime.state.close();
      fixture.client.close();
    }
  });

  it("givenPausedSnapshot_whenSessionCloses_thenWaitingConsumerFailsAndNoResume", async () => {
    const fixture = snapshotHost();
    try {
      const snapshot = await fixture.cluster.snapshot("primary");
      fixture.stream.emit("data", { blob: Buffer.alloc(8_388_608) });
      await fixture.runtime.state.close();
      await expect(snapshot.chunks[Symbol.asyncIterator]().next()).rejects.toThrow("cancelled");
      expect(fixture.stream.cancelled).toBe(true);
      expect(fixture.stream.resume).not.toHaveBeenCalled();
    } finally {
      fixture.client.close();
    }
  });

  it("givenEofWithoutStatus_whenConsuming_thenWaitForFinalOkBeforeCompleting", async () => {
    const fixture = snapshotHost();
    try {
      const snapshot = await fixture.cluster.snapshot("primary");
      const iterator = snapshot.chunks[Symbol.asyncIterator]();
      fixture.stream.emit("data", { blob: Buffer.from("chunk") });
      expect((await iterator.next()).value).toEqual(Buffer.from("chunk"));
      fixture.stream.emit("end");
      let complete = false;
      const final = iterator.next().then((result) => {
        complete = true;
        return result;
      });
      await Promise.resolve();
      expect(complete).toBe(false);
      fixture.stream.emit("status", { code: 0 });
      expect((await final).done).toBe(true);
      expect(fixture.stream.cancelled).toBe(true);
    } finally {
      await fixture.runtime.state.close();
      fixture.client.close();
    }
  });

  it("givenEofThenFailedStatus_whenConsuming_thenRejectAndNeverClaimSuccess", async () => {
    const fixture = snapshotHost();
    try {
      const snapshot = await fixture.cluster.snapshot("primary");
      fixture.stream.emit("data", { blob: Buffer.from("unpublishable") });
      fixture.stream.emit("end");
      fixture.stream.emit("status", { code: 14 });
      const consume = async () => {
        for await (const _chunk of snapshot.chunks) {
          /* Draining must not hide a non-OK final status. */
        }
      };
      await expect(consume()).rejects.toThrow("without OK status");
      expect(fixture.stream.cancelled).toBe(true);
    } finally {
      await fixture.runtime.state.close();
      fixture.client.close();
    }
  });
});
