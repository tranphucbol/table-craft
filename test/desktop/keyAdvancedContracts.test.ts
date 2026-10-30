import { describe, expect, expectTypeOf, it } from "vitest";
import type * as api from "@table-craft/plugin-api";
import type * as wire from "@table-craft/desktop/engine/protocol.js";
import { engineRequestSchema } from "@table-craft/desktop/engine/requests.js";

const key = { text: "/app/a", hex: null } as const;
const range = { kind: "prefix", prefix: key } as const;
const transaction = { compare: [], success: [{ kind: "get", range }], failure: [] } as const;

describe("advanced key contracts", () => {
  it.each(["keyspace.preview", "keyspace.apply"])(
    "givenLeaseOnlyEdit_whenParsing%s_thenAllowAttachDetachButRejectEmptyNoop",
    (type) => {
      const request = { id: 1, type, key, changes: [], ...(type === "keyspace.apply" ? { database: 0 } : {}) };
      const options = { type: "string", guard: true };
      for (const lease of [{ kind: "attach", leaseId: "42" }, { kind: "detach" }])
        expect(engineRequestSchema.safeParse({ ...request, options: { ...options, lease } }).success).toBe(true);
      expect(engineRequestSchema.safeParse({ ...request, options }).success).toBe(false);
      expect(
        engineRequestSchema.safeParse({ ...request, options: { ...options, lease: { kind: "preserve" } } }).success,
      ).toBe(false);
    },
  );
  it("givenOptionalAdditions_whenOldSessionUsed_thenNoServiceIsRequired", () => {
    type AddedServices = Pick<api.Session, "watch" | "leases" | "cluster" | "access" | "coordination" | "keyTransfer">;
    expectTypeOf<Record<never, never>>().toExtend<AddedServices>();
    expectTypeOf<Record<never, never>>().toExtend<Pick<api.CommandLanguage, "transactionBuilder">>();
    expectTypeOf<Record<never, never>>().toExtend<Pick<api.ConnectOptions, "transports">>();
    expectTypeOf<Record<never, never>>().toExtend<Pick<api.DatasourcePlugin, "connectionEndpoints">>();
    expectTypeOf<Record<never, never>>().toExtend<
      Pick<api.Keyspace, "children" | "countRange" | "prepareDelete" | "deletePrepared">
    >();
  });

  it("givenNewWireTypes_whenComparedWithPluginApi_thenIdentical", () => {
    expectTypeOf<wire.KeyRange>().toEqualTypeOf<api.KeyRange>();
    expectTypeOf<wire.KeyRecord>().toEqualTypeOf<api.KeyRecord>();
    expectTypeOf<wire.KeyLeaseAssignment>().toEqualTypeOf<api.KeyLeaseAssignment>();
    expectTypeOf<wire.KeyChildrenRequest>().toEqualTypeOf<api.KeyChildrenRequest>();
    expectTypeOf<wire.KeyChildrenPage>().toEqualTypeOf<api.KeyChildrenPage>();
    expectTypeOf<wire.KeyRangeCount>().toEqualTypeOf<api.KeyRangeCount>();
    expectTypeOf<wire.KeyDeletePreview>().toEqualTypeOf<api.KeyDeletePreview>();
    expectTypeOf<wire.KeyDeleteResult>().toEqualTypeOf<api.KeyDeleteResult>();
    expectTypeOf<wire.LeaseInfo>().toEqualTypeOf<api.LeaseInfo>();
    expectTypeOf<wire.LeaseKeyPage>().toEqualTypeOf<api.LeaseKeyPage>();
    expectTypeOf<wire.LeaseRevokePreview>().toEqualTypeOf<api.LeaseRevokePreview>();
    expectTypeOf<wire.KeyWatchRequest>().toEqualTypeOf<api.KeyWatchRequest>();
    expectTypeOf<wire.KeyWatchEvent>().toEqualTypeOf<api.KeyWatchEvent>();
    expectTypeOf<wire.KeyWatchBatch>().toEqualTypeOf<api.KeyWatchBatch>();
    expectTypeOf<wire.ClusterEndpoint>().toEqualTypeOf<api.ClusterEndpoint>();
    expectTypeOf<wire.ClusterMember>().toEqualTypeOf<api.ClusterMember>();
    expectTypeOf<wire.ClusterStatus>().toEqualTypeOf<api.ClusterStatus>();
    expectTypeOf<wire.ClusterHash>().toEqualTypeOf<api.ClusterHash>();
    expectTypeOf<wire.AccessChange>().toEqualTypeOf<api.AccessChange>();
    expectTypeOf<wire.AccessRole>().toEqualTypeOf<api.AccessRole>();
    expectTypeOf<wire.CoordinationPage>().toEqualTypeOf<api.CoordinationPage>();
    expectTypeOf<wire.CommandTransaction>().toEqualTypeOf<api.CommandTransaction>();
    expectTypeOf<wire.CommandTransactionParsed>().toEqualTypeOf<api.CommandTransactionParsed>();
    expectTypeOf<wire.CommandTransactionSerialized>().toEqualTypeOf<api.CommandTransactionSerialized>();
    expectTypeOf<wire.KeyTransferExportPage>().toEqualTypeOf<api.KeyTransferExportPage>();
    expectTypeOf<wire.KeyTransferInspection>().toEqualTypeOf<api.KeyTransferInspection>();
    expectTypeOf<wire.KeyTransferImported>().toEqualTypeOf<api.KeyTransferImported>();
    expectTypeOf<wire.KeyApplyOptions>().toEqualTypeOf<api.KeyApplyOptions>();
  });

  const requests = [
    { type: "keyspace.features" },
    { type: "keyspace.children", database: 0, range, parent: key, cursor: null, count: 20, timeoutMs: 100 },
    { type: "keyspace.countRange", database: 0, range },
    { type: "keyspace.prepareDelete", database: 0, range },
    { type: "keyspace.deletePrepared", token: "preview" },
    { type: "leases.list" },
    { type: "leases.get", leaseId: "9007199254740993" },
    { type: "leases.keys", leaseId: "9007199254740993", cursor: null, count: 20 },
    { type: "leases.grant", ttlSeconds: "60" },
    { type: "leases.keepAliveOnce", leaseId: "1" },
    { type: "leases.keepAliveStart", leaseId: "1" },
    { type: "leases.keepAliveStop", keepAliveId: "renewal" },
    { type: "leases.prepareRevoke", leaseId: "1" },
    { type: "leases.revokePrepared", token: "revoke" },
    {
      type: "watch.start",
      database: 0,
      range,
      from: { kind: "revision", revision: "9007199254740993" },
      maxEvents: 1000,
      maxBytes: 1000000,
    },
    { type: "watch.window", watchId: "watch", afterSequence: null, count: 20, maxBytes: 10000 },
    { type: "watch.stop", watchId: "watch" },
    { type: "watch.clear", watchId: "watch" },
    { type: "watch.list" },
    { type: "cluster.endpoints" },
    { type: "cluster.members" },
    { type: "cluster.status", endpointId: "configured-1" },
    { type: "cluster.alarms" },
    { type: "cluster.disarm", alarm: { memberId: "1", kind: "NOSPACE" } },
    { type: "cluster.compact", revision: "9007199254740993", physical: false },
    { type: "cluster.promote", memberId: "1" },
    { type: "cluster.remove", memberId: "1" },
    { type: "maintenance.defragmentStart", endpointIds: ["configured-1"] },
    { type: "maintenance.snapshotStart", endpointId: "configured-1", fileGrantId: "save-grant" },
    { type: "maintenance.consistencyStart", endpointIds: ["configured-1"], revision: "9007199254740993" },
    { type: "maintenance.list" },
    { type: "maintenance.cancel", taskId: "task" },
    { type: "access.status" },
    { type: "access.users" },
    { type: "access.roles" },
    {
      type: "access.apply",
      change: { kind: "grantPermission", role: "reader", permission: { access: "read", range } },
    },
    { type: "coordination.prefixes" },
    { type: "coordination.read", prefixId: "locks", cursor: null, count: 20 },
    { type: "commandTxn.parse", text: "txn", offset: 3 },
    { type: "commandTxn.serialize", transaction },
    { type: "keyTransfer.previewImport", fileGrantId: "open-grant", database: 0, range },
    { type: "keyTransfer.importStart", fileGrantId: "open-grant", database: 0, range, policy: "ifUnchanged" },
    { type: "keyTransfer.exportStart", fileGrantId: "save-grant", database: 0, range },
    { type: "keyTransfer.resume", taskId: "task" },
    { type: "keyTransfer.list" },
    { type: "keyTransfer.cancel", taskId: "task" },
  ] satisfies readonly {
    [K in keyof wire.KeyAdvancedCalls]: { readonly type: K } & wire.KeyAdvancedCalls[K]["params"];
  }[keyof wire.KeyAdvancedCalls][];

  it.each(requests)("givenValidRequest_whenParsed_thenAccepts $type", (request) => {
    expect(engineRequestSchema.safeParse({ id: 1, ...request }).success).toBe(true);
    expect(engineRequestSchema.safeParse({ id: 1, ...request, password: "must-not-enter-rpc" }).success).toBe(false);
  });

  it.each([
    { type: "leases.get", leaseId: 9007199254740992 },
    { type: "leases.grant", ttlSeconds: "0" },
    { type: "leases.grant", ttlSeconds: "1e3" },
    { type: "cluster.compact", revision: "01", physical: false },
    { type: "watch.window", watchId: "watch", afterSequence: "-1", count: 20, maxBytes: 20 },
    { type: "watch.window", watchId: "watch", afterSequence: null, count: 501, maxBytes: 20 },
    { type: "watch.window", watchId: "watch", afterSequence: null, count: 20, maxBytes: 1048577 },
    { type: "watch.start", database: 0, range, from: { kind: "now" }, maxEvents: 100001, maxBytes: 1000 },
    { type: "keyspace.children", database: 0, range, parent: key, cursor: "x".repeat(8193), count: 20, timeoutMs: 100 },
    { type: "keyspace.children", database: 0, range, parent: key, cursor: null, count: 20, timeoutMs: 5001 },
    { type: "maintenance.defragmentStart", endpointIds: ["one", "one"] },
    { type: "maintenance.snapshotStart", endpointId: "one", path: "/arbitrary/path.db" },
    { type: "keyTransfer.exportStart", database: 0, range, path: "/arbitrary/path.json" },
    { type: "access.apply", change: { kind: "createUser", user: "root", password: "secret" } },
    { type: "access.apply", change: { kind: "changePassword", user: "root", password: "secret" } },
    { type: "access.applySecret", change: { kind: "createUser", user: "root", password: "secret" } },
    { type: "commandTxn.parse", text: "txn", offset: 4 },
    {
      type: "commandTxn.serialize",
      transaction: { ...transaction, success: Array.from({ length: 129 }, () => ({ kind: "get", range })) },
    },
    {
      type: "commandTxn.serialize",
      transaction: { ...transaction, compare: [{ range, target: "value", operator: "=", operand: "123" }] },
    },
    {
      type: "commandTxn.serialize",
      transaction: { ...transaction, compare: [{ range, target: "modRevision", operator: "=", operand: key }] },
    },
  ])("givenUnsafeRequest_whenParsed_thenRejects $type", (request) => {
    expect(engineRequestSchema.safeParse({ id: 1, ...request }).success).toBe(false);
  });

  it("givenNestedTransaction_whenBudgetOrDepthExceeded_thenRejects", () => {
    let nested: wire.CommandTransaction = transaction;
    for (let depth = 0; depth < 9; depth += 1) {
      nested = { compare: [], success: [{ kind: "txn", transaction: nested }], failure: [] };
    }
    expect(engineRequestSchema.safeParse({ id: 1, type: "commandTxn.serialize", transaction: nested }).success).toBe(
      false,
    );
    const wide = { compare: [], success: Array.from({ length: 100 }, () => ({ kind: "get", range })), failure: [] };
    expect(
      engineRequestSchema.safeParse({
        id: 1,
        type: "commandTxn.serialize",
        transaction: {
          compare: [],
          success: [{ kind: "txn", transaction: wide }],
          failure: [{ kind: "txn", transaction: wide }],
        },
      }).success,
    ).toBe(false);
  });

  it.each([{ kind: "preserve" }, { kind: "detach" }, { kind: "attach", leaseId: "9007199254740993" }])(
    "givenLeaseAssignment_whenApplyingKey_thenAccepts $kind",
    (lease) => {
      expect(
        engineRequestSchema.safeParse({
          id: 1,
          type: "keyspace.apply",
          database: 0,
          key,
          changes: [{ kind: "setString", value: key, original: key }],
          options: { type: "string", guard: true, lease },
        }).success,
      ).toBe(true);
    },
  );
});
