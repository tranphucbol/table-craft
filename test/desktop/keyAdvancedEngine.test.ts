import { describe, expect, it, vi } from "vitest";
import {
  PluginError,
  z,
  type Capability,
  type DatasourcePlugin,
  type Session,
  type KeyWatch,
  type LeaseInfo,
} from "@table-craft/plugin-api";
import type { PluginLoadResult } from "@table-craft/core";
import { createEngine, type EngineOptions } from "@table-craft/desktop/engine/engine.js";
import type { EngineResponse, KeyTask } from "@table-craft/desktop/engine/protocol.js";
import { fakeManifest } from "../support/manifests.js";
import { exportHeader, exportRecord } from "@table-craft/desktop/engine/keyOperations/transferFormat.js";
import { EtcdRefusal } from "@table-craft/plugin-etcd/runtime";
import { filesForPort } from "@table-craft/desktop/engine/portAuthority.js";

const key = { text: "/app/a", hex: null };
const range = { kind: "prefix", prefix: key } as const;
const lease: LeaseInfo = {
  id: "9007199254740993",
  state: "active",
  grantedTtlSeconds: "60",
  remainingTtlSeconds: "59",
  scopedKeyCount: "0",
  totalKeyCount: "0",
  outsideNamespaceKeyCount: "0",
};
const capabilities: Capability[] = [
  "commands",
  "keyValue",
  "leases",
  "watch",
  "members",
  "maintenance",
  "access",
  "coordination",
  "bulkTransfer",
];

function setup(
  open: () => Promise<Session>,
  options: {
    readonly readOnly?: boolean;
    readonly capabilities?: Capability[];
    readonly files?: EngineOptions["operationFiles"];
  } = {},
) {
  const declared = options.capabilities ?? capabilities;
  const plugin: DatasourcePlugin = {
    id: "advanced",
    capabilities: declared,
    connectionSchema: z.object({}),
    connect: open,
  };
  const loaded: PluginLoadResult = {
    status: "loaded",
    directory: "plugins/advanced",
    manifest: fakeManifest({ id: plugin.id, name: "Advanced", capabilities: declared }),
    plugin,
  };
  return createEngine({
    datasource: { id: "a", pluginId: plugin.id, config: {}, readOnly: options.readOnly ?? false, keepAliveSeconds: 0 },
    plugins: [loaded],
    ...(options.files === undefined ? {} : { operationFiles: options.files }),
  });
}
function session(services: Partial<Session> = {}): Session {
  return { execute: vi.fn(), serverVersion: null, close: vi.fn().mockResolvedValue(undefined), ...services };
}
function result<T>(response: EngineResponse): T {
  if (response.type === "engine.error") throw new Error(response.error.message);
  return response.result as T;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("advanced engine routes", () => {
  it.each([false, undefined, "true"])(
    "givenMcpOrUngrantedPort%s_whenReadingAndRequestingFiles_thenReadWorksButFileAuthorityIsDenied",
    async (flag) => {
      const read = vi.fn().mockResolvedValue([]);
      const files = { read: vi.fn(), publish: vi.fn() };
      const grant = vi.fn(() => files);
      const engine = setup(() => Promise.resolve(session({ leases: { list: read } as unknown as Session["leases"] })));
      const connection = engine.connect(undefined, filesForPort("mcp-owner", flag, grant));
      expect(result(await connection.handle({ id: 1, type: "leases.list" }))).toEqual([]);
      expect(read).toHaveBeenCalledTimes(1);
      expect(
        await connection.handle({
          id: 2,
          type: "maintenance.snapshotStart",
          endpointId: "primary",
          fileGrantId: "forged",
        }),
      ).toMatchObject({
        type: "engine.error",
        error: { code: "invalidRequest", message: "The host has not installed authorized file operations." },
      });
      expect(
        await connection.handle({
          id: 3,
          type: "keyTransfer.previewImport",
          fileGrantId: "forged",
          database: 0,
          range,
        }),
      ).toMatchObject({ type: "engine.error" });
      expect(grant).not.toHaveBeenCalled();
      expect(files.read).not.toHaveBeenCalled();
      expect(files.publish).not.toHaveBeenCalled();
      expect(filesForPort("window-owner", true, grant)).toBe(files);
      expect(grant).toHaveBeenCalledWith("window-owner");
      await engine.close();
    },
  );
  it.each([
    new EtcdRefusal("Enable authentication with a verified credential first."),
    new PluginError("conflict", "Preview changed; nothing was written."),
  ])("givenDefiniteRefusal_whenMutationFails_thenPreserveTypedMessageWithoutUncertainty", async (failure) => {
    const grant = vi.fn().mockRejectedValue(failure);
    const engine = setup(() => Promise.resolve(session({ leases: { grant } as unknown as Session["leases"] })));
    expect(await engine.connect().handle({ id: 1, type: "leases.grant", ttlSeconds: "60" })).toMatchObject({
      type: "engine.error",
      error: { code: failure.code, message: failure.message },
    });
    expect(grant).toHaveBeenCalledTimes(1);
    await engine.close();
  });

  it("givenLostAdminSession_whenLaterReadArrives_thenReconnectOnlyForNewWorkAndNeverReplayMutation", async () => {
    const grant = vi.fn().mockRejectedValue(new PluginError("connectionLost", "lost"));
    const closeOld = vi.fn().mockResolvedValue(undefined);
    const old = session({ close: closeOld, leases: { grant } as unknown as Session["leases"] });
    const list = vi.fn().mockResolvedValue([]);
    const open = vi
      .fn()
      .mockResolvedValueOnce(old)
      .mockResolvedValueOnce(session({ leases: { list } as unknown as Session["leases"] }));
    const engine = setup(open);
    const connection = engine.connect();
    expect(await connection.handle({ id: 1, type: "leases.grant", ttlSeconds: "60" })).toMatchObject({
      type: "engine.error",
      error: { message: expect.stringContaining("may have committed") as unknown },
    });
    expect(open).toHaveBeenCalledTimes(1);
    expect(result(await connection.handle({ id: 2, type: "leases.list" }))).toEqual([]);
    expect(open).toHaveBeenCalledTimes(2);
    expect(closeOld).toHaveBeenCalledTimes(1);
    expect(grant).toHaveBeenCalledTimes(1);
    await engine.close();
  });

  it("givenRenewalStreamDies_whenLeaseListPolled_thenObservableStoppedReasonAndDedicatedCleanup", async () => {
    let stopped!: (reason: string) => void;
    const resource = {
      once: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
      onClosed: (listener: (reason: string) => void) => {
        stopped = listener;
      },
    };
    const closeOwned = vi.fn().mockResolvedValue(undefined);
    const owned = session({
      close: closeOwned,
      leases: {
        keepAlive: () => Promise.resolve(resource),
        get: () => Promise.resolve(lease),
      } as unknown as Session["leases"],
    });
    const admin = session({ leases: { list: () => Promise.resolve([]) } as unknown as Session["leases"] });
    const engine = setup(vi.fn().mockResolvedValueOnce(owned).mockResolvedValueOnce(admin));
    const connection = engine.connect();
    const started = result<{ keepAliveId: string }>(
      await connection.handle({ id: 1, type: "leases.keepAliveStart", leaseId: lease.id }),
    );
    stopped("Renewal stream ended. Inspect TTL.");
    await vi.waitFor(() => expect(closeOwned).toHaveBeenCalledTimes(1));
    expect(result(await connection.handle({ id: 2, type: "leases.list" }))).toMatchObject([
      {
        id: lease.id,
        state: "unknown",
        remainingTtlSeconds: null,
        renewal: { keepAliveId: started.keepAliveId, state: "stopped", reason: "Renewal stream ended. Inspect TTL." },
      },
    ]);
    await connection.handle({ id: 3, type: "leases.keepAliveStop", keepAliveId: started.keepAliveId });
    await engine.close();
    expect(resource.close).toHaveBeenCalledTimes(1);
    expect(closeOwned).toHaveBeenCalledTimes(1);
  });
  it("givenMissingCapability_whenRequested_thenNoDedicatedConnectionOpens", async () => {
    const open = vi.fn(() => Promise.resolve(session()));
    const engine = setup(open, { capabilities: ["commands", "keyValue"] });
    expect(await engine.connect().handle({ id: 1, type: "leases.list" })).toMatchObject({
      type: "engine.error",
      error: { code: "invalidRequest" },
    });
    expect(open).not.toHaveBeenCalled();
    await engine.close();
  });

  it("givenReadOnlyDatasource_whenAnyMutationRequested_thenRejectedBeforeSessionOpen", async () => {
    const open = vi.fn(() => Promise.resolve(session()));
    const engine = setup(open, { readOnly: true });
    const connection = engine.connect();
    const requests = [
      { type: "leases.grant", ttlSeconds: "60" },
      { type: "leases.keepAliveOnce", leaseId: "1" },
      { type: "leases.keepAliveStart", leaseId: "1" },
      { type: "leases.revokePrepared", token: "token" },
      { type: "keyspace.deletePrepared", token: "token" },
      { type: "keyspace.remove", database: 0, keys: [key] },
      { type: "cluster.compact", revision: "1", physical: false },
      { type: "cluster.disarm", alarm: { memberId: "1", kind: "NOSPACE" } },
      { type: "cluster.promote", memberId: "1" },
      { type: "cluster.remove", memberId: "1" },
      { type: "maintenance.defragmentStart", endpointIds: ["primary"] },
      { type: "access.apply", change: { kind: "enableAuth" } },
      { type: "keyTransfer.importStart", fileGrantId: "grant", database: 0, range, policy: "overwrite" },
    ];
    for (const request of requests)
      expect(await connection.handle({ id: 1, ...request })).toMatchObject({
        type: "engine.error",
        error: { code: "invalidRequest" },
      });
    await expect(engine.applyAccessSecret({ kind: "createUser", user: "u", password: "secret" })).rejects.toThrow(
      "credential change",
    );
    expect(open).not.toHaveBeenCalled();
    await engine.close();
  });

  it("givenMutationTransportFailure_whenGrantCalled_thenNeverReplaysOnHelper", async () => {
    const grant = vi.fn().mockRejectedValue(new PluginError("connectionLost", "uncertain"));
    const leases = { grant } as unknown as NonNullable<Session["leases"]>;
    const open = vi.fn(() => Promise.resolve(session({ leases })));
    const engine = setup(open);
    const response = await engine.connect().handle({ id: 1, type: "leases.grant", ttlSeconds: "60" });
    expect(response).toMatchObject({
      type: "engine.error",
      error: { code: "statementFailed", hint: expect.stringContaining("automatic replay is disabled") as unknown },
    });
    expect(grant).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
    await engine.close();
  });

  it("givenSessionBoundPreview_whenAdminReadIntervenes_thenCommitUsesSameSession", async () => {
    const token = "bound-token";
    const prepareDelete = vi.fn().mockResolvedValue({
      token,
      revision: "2",
      counts: { revision: "2", keys: "1", leasedKeys: "0" },
      sampleKeys: [key],
      guard: "noNewOrModifiedKeys",
    });
    const deletePrepared = vi.fn().mockResolvedValue({ revision: "3", deleted: "1" });
    const open = vi.fn(() =>
      Promise.resolve(
        session({
          keyspace: { prepareDelete, deletePrepared } as unknown as Session["keyspace"],
          leases: { list: () => Promise.resolve([]) } as unknown as Session["leases"],
        }),
      ),
    );
    const engine = setup(open);
    const connection = engine.connect();
    await connection.handle({ id: 1, type: "keyspace.prepareDelete", database: 0, range });
    await connection.handle({ id: 2, type: "leases.list" });
    expect(result(await connection.handle({ id: 3, type: "keyspace.deletePrepared", token }))).toEqual({
      revision: "3",
      deleted: "1",
    });
    expect(open).toHaveBeenCalledTimes(1);
    expect(deletePrepared).toHaveBeenCalledWith(token);
    await engine.close();
  });

  it("givenPendingWatchOpen_whenPortCloses_thenLateWatchAndSessionAreClosed", async () => {
    const pending = deferred<KeyWatch>();
    const entered = deferred<void>();
    const closeWatch = vi.fn().mockResolvedValue(undefined);
    const watch: KeyWatch = { next: vi.fn(), close: closeWatch };
    const closeSession = vi.fn().mockResolvedValue(undefined);
    const owned = session({
      close: closeSession,
      watch: {
        open: () => {
          entered.resolve();
          return pending.promise;
        },
      },
    });
    const engine = setup(() => Promise.resolve(owned));
    const connection = engine.connect();
    const response = connection.handle({
      id: 1,
      type: "watch.start",
      database: 0,
      range,
      from: { kind: "now" },
      maxEvents: 10,
      maxBytes: 1000,
    });
    await entered.promise;
    await connection.close();
    pending.resolve(watch);
    expect(await response).toMatchObject({ type: "engine.error" });
    expect(closeWatch).toHaveBeenCalledTimes(1);
    expect(closeSession).toHaveBeenCalledTimes(1);
    await engine.close();
  });

  it("givenRenewingLease_whenStopped_thenOnlyRenewalClosesNeverRevokes", async () => {
    const resource = { once: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
    const revokePrepared = vi.fn();
    const owned = session({
      leases: {
        keepAlive: () => Promise.resolve(resource),
        get: () => Promise.resolve(lease),
        revokePrepared,
      } as unknown as Session["leases"],
    });
    const engine = setup(() => Promise.resolve(owned));
    const connection = engine.connect();
    const started = result<{ keepAliveId: string }>(
      await connection.handle({ id: 1, type: "leases.keepAliveStart", leaseId: lease.id }),
    );
    await connection.handle({ id: 2, type: "leases.keepAliveStop", keepAliveId: started.keepAliveId });
    expect(resource.close).toHaveBeenCalledTimes(1);
    expect(resource.once).not.toHaveBeenCalled();
    expect(revokePrepared).not.toHaveBeenCalled();
    await engine.close();
  });

  it("givenMaintenanceTask_whenDefragmented_thenFollowersPrecedeLeaderOnConfiguredEndpoints", async () => {
    const order: string[] = [];
    const cluster = {
      endpoints: () => Promise.resolve([{ id: "leader" }, { id: "follower" }]),
      status: (id: string) => Promise.resolve({ endpointId: id, memberId: id, leaderId: "leader" }),
      defragment: async (id: string) => {
        await Promise.resolve();
        order.push(id);
      },
    } as unknown as Session["cluster"];
    const engine = setup(() => Promise.resolve(session({ cluster })));
    const connection = engine.connect();
    result<KeyTask>(
      await connection.handle({ id: 1, type: "maintenance.defragmentStart", endpointIds: ["leader", "follower"] }),
    );
    await engine.tasksSettled();
    expect(order).toEqual(["follower", "leader"]);
    expect(result<KeyTask[]>(await connection.handle({ id: 2, type: "maintenance.list" }))[0]).toMatchObject({
      state: "completed",
      completed: "2",
      outcome: "confirmed",
    });
    await engine.close();
  });

  it("givenConsistencyTask_whenRun_thenEveryConfiguredEndpointUsesSameExplicitRevision", async () => {
    const hash = vi.fn((id: string, revision: string) =>
      Promise.resolve({
        endpointId: id,
        revision,
        hash: "42",
        compactRevision: "1",
      }),
    );
    const cluster = {
      endpoints: () => Promise.resolve([{ id: "one" }, { id: "two" }]),
      hash,
    } as unknown as Session["cluster"];
    const engine = setup(() => Promise.resolve(session({ cluster })));
    const connection = engine.connect();
    await connection.handle({
      id: 1,
      type: "maintenance.consistencyStart",
      endpointIds: ["one", "two"],
      revision: "9007199254740993",
    });
    await engine.tasksSettled();
    expect(hash.mock.calls).toEqual([
      ["one", "9007199254740993"],
      ["two", "9007199254740993"],
    ]);
    await engine.close();
  });

  it("givenMalformedImportTail_whenPreviewed_thenNoPartialInspectionTotalsEscape", async () => {
    const inspect = vi.fn();
    const document =
      exportHeader({ clusterId: "1", namespace: { text: "", hex: null }, revision: "2" }) +
      exportRecord({ key, value: key, revision: { createRevision: "1", modRevision: "2", version: "1", lease: "0" } }) +
      "]} broken";
    const files = {
      read: async <T>(_grant: string, use: (source: AsyncIterable<Uint8Array>) => Promise<T>) => {
        async function* source() {
          await Promise.resolve();
          yield Buffer.from(document);
        }
        return use(source());
      },
      publish: vi.fn(),
    };
    const engine = setup(
      () => Promise.resolve(session({ keyTransfer: { inspect } as unknown as Session["keyTransfer"] })),
      {
        files,
      },
    );
    expect(
      await engine.connect().handle({
        id: 1,
        type: "keyTransfer.previewImport",
        fileGrantId: "grant",
        database: 0,
        range: { kind: "all" },
      }),
    ).toMatchObject({ type: "engine.error" });
    expect(inspect).not.toHaveBeenCalled();
    await engine.close();
  });

  it.each(["ambiguous", "conflict"])(
    "givenSecondImportChunk%s_whenResumeRequested_thenPreserveKnownOutcome",
    async (outcome) => {
      const identity = { clusterId: "1", namespace: { text: "", hex: null }, revision: "2", records: [], cursor: null };
      const records = Array.from({ length: 65 }, (_, index) => ({
        key: { text: `/app/${index}`, hex: null },
        value: key,
        revision: { createRevision: "1", modRevision: "2", version: "1", lease: "0" },
      }));
      const document = exportHeader(identity) + records.map(exportRecord).join(",") + "]}";
      const importChunk = vi
        .fn()
        .mockResolvedValueOnce({ revision: "3", written: "64", skipped: "0" })
        .mockRejectedValueOnce(
          new PluginError(outcome === "ambiguous" ? "connectionLost" : "conflict", "chunk rejected"),
        );
      const files = {
        read: async <T>(_grant: string, use: (source: AsyncIterable<Uint8Array>) => Promise<T>) => {
          async function* source() {
            await Promise.resolve();
            yield Buffer.from(document);
          }
          return use(source());
        },
        publish: vi.fn(),
      };
      const engine = setup(
        () =>
          Promise.resolve(
            session({
              keyTransfer: {
                exportPage: () => Promise.resolve(identity),
                importChunk,
              } as unknown as Session["keyTransfer"],
            }),
          ),
        { files },
      );
      const connection = engine.connect();
      const task = result<KeyTask>(
        await connection.handle({
          id: 1,
          type: "keyTransfer.importStart",
          fileGrantId: "grant",
          database: 0,
          range: { kind: "all" },
          policy: "ifUnchanged",
        }),
      );
      await engine.tasksSettled();
      expect(result<KeyTask[]>(await connection.handle({ id: 2, type: "keyTransfer.list" }))[0]).toMatchObject({
        taskId: task.taskId,
        state: "failed",
        completed: "64",
        outcome: outcome === "ambiguous" ? "uncertain" : "confirmed",
        resumable: outcome !== "ambiguous",
      });
      if (outcome === "ambiguous")
        expect(await connection.handle({ id: 3, type: "keyTransfer.resume", taskId: task.taskId })).toMatchObject({
          type: "engine.error",
          error: { code: "invalidRequest" },
        });
      expect(importChunk).toHaveBeenCalledTimes(2);
      await engine.close();
    },
  );
});
