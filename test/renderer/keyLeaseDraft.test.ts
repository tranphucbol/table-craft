import { describe, expect, it, vi } from "vitest";
import { EngineRequestError, type EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import type { EngineError, KeyDetails } from "@table-craft/desktop/engine/protocol.js";
import { createKeyTabsStore, pendingKeyCount } from "@table-craft/desktop/renderer/state/keyTabs.js";

const KEY = { text: "/config/a", hex: null };
const REVISION = { createRevision: "1", modRevision: "7", version: "3", lease: "42" };
const DETAILS: KeyDetails = {
  key: KEY,
  type: "string",
  typeName: "string",
  ttlMs: 60_000,
  length: 4,
  memoryBytes: null,
  encoding: null,
  idleSeconds: null,
  revision: REVISION,
};

function fixture(options: { readonly assignment?: boolean; readonly readOnly?: boolean } = {}) {
  let conflict: EngineError | null = null;
  const call = vi.fn(async (method: string) => {
    await Promise.resolve();
    if (method === "session.open") return { sessionId: "session", capabilities: ["keyValue", "leases", "revisions"] };
    if (method === "keyspace.open") return { details: DETAILS, statement: null, value: "same", readOnly: null };
    if (method === "keyspace.databases")
      return {
        features: { revisionGuard: true, history: true, leaseAssignment: options.assignment ?? true },
        databases: [],
        delimiter: "/",
      };
    if (method === "keyspace.preview") return ["guarded lease change"];
    if (method === "keyspace.apply" && conflict !== null) {
      const failure = conflict;
      conflict = null;
      throw new EngineRequestError(failure);
    }
    return null;
  });
  const store = createKeyTabsStore({
    connect: () => Promise.resolve({ call } as unknown as EngineClient),
    readOnly: () => options.readOnly === true,
  });
  return {
    store,
    call,
    fail: (error: EngineError) => {
      conflict = error;
    },
    open: () => store.getState().open("key", { datasourceId: "source", database: 0, key: KEY }),
  };
}

describe("key editor lease drafts", () => {
  it("givenLeaseOnlyChange_whenPreviewedAndSubmitted_thenEmptyChangesAndRevisionGuardWithoutFakeValue", async () => {
    const { store, call, open } = fixture();
    await open();
    store.getState().setLease("key", { kind: "attach", leaseId: "123" });
    const tab = store.getState().tabs.key;
    expect(tab !== undefined && pendingKeyCount(tab)).toBe(1);
    await store.getState().preview("key");
    expect(call).toHaveBeenCalledWith(
      "keyspace.preview",
      expect.objectContaining({
        changes: [],
        options: {
          type: "string",
          guard: true,
          revisionGuard: { modRevision: "7" },
          lease: { kind: "attach", leaseId: "123" },
        },
      }),
    );
    await store.getState().submit("key");
    expect(call).toHaveBeenCalledWith(
      "keyspace.apply",
      expect.objectContaining({
        changes: [],
        options: expect.objectContaining({ lease: { kind: "attach", leaseId: "123" } }) as unknown,
      }),
    );
    expect(store.getState().tabs.key?.leaseDraft).toBeNull();
    store.getState().close("key");
  });

  it("givenValueEdit_whenDefaultKeep_thenLeaseOmittedAndNeverTtlTogether", async () => {
    const { store, call, open } = fixture();
    await open();
    store.getState().setStringValue("key", { text: "changed", hex: null });
    await store.getState().preview("key");
    const request = call.mock.calls.find(([method]) => method === "keyspace.preview");
    expect(request).toBeDefined();
    expect(call).toHaveBeenCalledWith(
      "keyspace.preview",
      expect.objectContaining({ options: { type: "string", guard: true, revisionGuard: { modRevision: "7" } } }),
    );
    store.getState().setLease("key", { kind: "detach" });
    store.getState().revertAll("key");
    expect(store.getState().tabs.key?.leaseDraft).toBeNull();
    store.getState().close("key");
  });

  it("givenSameValueAndLeaseDraft_whenConflict_thenRebasesLeaseOnlyWithoutWritingOldValue", async () => {
    const { store, call, open, fail } = fixture();
    await open();
    store.getState().setStringValue("key", { text: "same", hex: null });
    store.getState().setLease("key", { kind: "detach" });
    fail({
      code: "conflict",
      message: "Changed",
      hint: "Review",
      keyConflict: {
        database: 0,
        key: KEY,
        value: { text: "new server value", hex: null },
        revision: { ...REVISION, modRevision: "8", version: "4", lease: "99" },
        snapshotRevision: "8",
      },
    });
    expect(await store.getState().submit("key")).toBe(false);
    expect(store.getState().tabs.key).toMatchObject({
      stringValue: null,
      value: "new server value",
      leaseDraft: { kind: "detach" },
      details: { revision: { modRevision: "8" } },
    });
    await store.getState().preview("key");
    expect(call).toHaveBeenLastCalledWith(
      "keyspace.preview",
      expect.objectContaining({
        changes: [],
        options: expect.objectContaining({ revisionGuard: { modRevision: "8" } }) as unknown,
      }),
    );
    store.getState().close("key");
  });

  it("givenUnsupportedOrReadOnly_whenLeaseStaged_thenNoPendingMutation", async () => {
    for (const options of [{ assignment: false }, { readOnly: true }]) {
      const { store, open } = fixture(options);
      await open();
      store.getState().setLease("key", { kind: "attach", leaseId: "123" });
      expect(store.getState().tabs.key?.leaseDraft).toBeNull();
      expect(await store.getState().submit("key")).toBe(false);
      store.getState().close("key");
    }
  });

  it("givenRepeatedValueConflict_whenMerged_thenKeepsAssignmentAndAdvancesOnlyToTypedSnapshotGuard", async () => {
    const { store, call, open, fail } = fixture();
    await open();
    store.getState().setStringValue("key", { text: "mine", hex: null });
    store.getState().setLease("key", { kind: "attach", leaseId: "123" });
    const changed = (revision: string): EngineError => ({
      code: "conflict",
      message: "Changed",
      hint: "Review",
      keyConflict: {
        database: 0,
        key: KEY,
        value: { text: `server ${revision}`, hex: null },
        revision: { ...REVISION, modRevision: revision, lease: "99" },
        snapshotRevision: revision,
      },
    });
    fail(changed("8"));
    await store.getState().submit("key");
    store.getState().editMerge("key", "reviewed merge");
    store.getState().acknowledgeMerge("key");
    fail(changed("9"));
    expect(await store.getState().saveMerge("key")).toBe(false);
    expect(call).toHaveBeenLastCalledWith(
      "keyspace.apply",
      expect.objectContaining({
        options: expect.objectContaining({
          revisionGuard: { modRevision: "8" },
          lease: { kind: "attach", leaseId: "123" },
        }) as unknown,
      }),
    );
    expect(store.getState().tabs.key).toMatchObject({
      leaseDraft: { kind: "attach", leaseId: "123" },
      merge: { snapshot: { revision: { modRevision: "9" } }, changedAgain: true },
    });
    store.getState().editMerge("key", "reviewed again");
    store.getState().acknowledgeMerge("key");
    await store.getState().preview("key");
    expect(call).toHaveBeenLastCalledWith(
      "keyspace.preview",
      expect.objectContaining({ options: expect.objectContaining({ revisionGuard: { modRevision: "9" } }) as unknown }),
    );
    store.getState().close("key");
  });
});
