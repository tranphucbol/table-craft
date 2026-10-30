import { describe, expect, it } from "vitest";
import type {
  ClusterStatus,
  KeyWatchEvent,
  KeyWatchSummary,
  KeyWatchWindow,
  LeaseInfo,
} from "@table-craft/desktop/engine/protocol.js";
import type { EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import {
  accessChangeBlocked,
  bytesLabel,
  createAdminStore,
  EMPTY_ADMIN,
  memberLag,
  remainingTtl,
  removalBlocked,
} from "@table-craft/desktop/renderer/keyAdmin/store.js";
import {
  appendWatchRows,
  createWatchStore,
  WATCH_WINDOW_BYTES,
  WATCH_WINDOW_COUNT,
} from "@table-craft/desktop/renderer/watch/store.js";
import { DEFAULT_SETTINGS, readSettings, watchRetentionError } from "@table-craft/desktop/settings/settings.js";

const lease: LeaseInfo = {
  id: "9007199254740993",
  state: "active",
  grantedTtlSeconds: "60",
  remainingTtlSeconds: "20",
  scopedKeyCount: null,
  totalKeyCount: null,
  outsideNamespaceKeyCount: null,
};
const request = {
  database: 0,
  range: { kind: "prefix" as const, prefix: { text: "/config/", hex: null } },
  from: { kind: "now" as const },
};
const summary: KeyWatchSummary = {
  watchId: "watch-1",
  request,
  state: "live",
  completedRevision: null,
  gap: null,
  evictedEvents: "0",
};
const event: KeyWatchEvent = {
  kind: "PUT",
  key: { text: "/config/a", hex: null },
  value: { text: "new", hex: null },
  previous: null,
  revision: { createRevision: "9007199254740993", modRevision: "9007199254740993", version: "1", lease: "0" },
};
const row = (sequence: string) => ({ sequence, event });
const windowOf = (sequences: readonly string[]): KeyWatchWindow => ({
  watchId: summary.watchId,
  rows: sequences.map(row),
  oldestSequence: sequences[0] ?? null,
  newestSequence: sequences.at(-1) ?? null,
  evictedEvents: "0",
  state: "live",
  completedRevision: event.revision.modRevision,
  gap: null,
});
function client(call: (method: string, params: unknown) => Promise<unknown>): EngineClient {
  return { call } as unknown as EngineClient;
}
function status(memberId: string, appliedIndex: string): ClusterStatus {
  return {
    endpointId: memberId,
    memberId,
    clusterId: "1",
    revision: "9007199254740999",
    leaderId: "a",
    version: null,
    dbBytes: null,
    inUseBytes: null,
    quotaBytes: null,
    raftTerm: null,
    raftIndex: null,
    appliedIndex,
  };
}

describe("advanced key UI safety", () => {
  it("givenRenewalDies_whenLeaseStatusPolled_thenToggleOffAndKeepStoppedReason", async () => {
    let dead = false;
    const store = createAdminStore(() =>
      Promise.resolve(
        client(async (method) => {
          await Promise.resolve();
          if (method === "leases.keepAliveStart") return { keepAliveId: "renew-1", lease };
          if (method === "leases.list")
            return [
              {
                ...lease,
                renewal: {
                  keepAliveId: "renew-1",
                  state: dead ? "stopped" : "active",
                  reason: dead ? "Stream ended; inspect TTL." : null,
                },
              },
            ];
          return null;
        }),
      ),
    );
    await store.getState().renew("source", lease.id);
    expect(store.getState().data.source?.renewals[lease.id]).toBe("renew-1");
    dead = true;
    await store.getState().refresh("source", "leases");
    expect(store.getState().data.source?.renewals[lease.id]).toBeUndefined();
    expect(store.getState().data.source?.renewalStops[lease.id]).toBe("Stream ended; inspect TTL.");
  });
  it("givenUnknownGlobalLeaseCounts_whenRendering_thenNeverInventsZeros", () => {
    expect(lease.totalKeyCount).toBeNull();
    expect(remainingTtl(lease, 1000, 5000)).toBe("16 s");
    expect(remainingTtl({ ...lease, remainingTtlSeconds: null }, 1000, 5000)).toBe("Unknown");
    expect(remainingTtl(lease, 1000, 30000)).toBe("Expired");
    expect(bytesLabel({ text: "", hex: "009fff" })).toBe("\\x00\\x9f\\xff");
  });
  it("givenLargeRaftIndices_whenCalculatingLag_thenUsesExactIntegers", () => {
    const leader = status("a", "9007199254740999");
    const follower = status("b", "9007199254740993");
    expect(memberLag(follower, [leader, follower])).toBe("6");
    expect(memberLag(follower, [follower])).toBeNull();
  });
  it("givenMissingReachableMajority_whenRemoving_thenBlocksQuorumLoss", () => {
    const members = ["a", "b", "c"].map((id) => ({ id, name: id, learner: false, peerUrls: [], clientUrls: [] }));
    expect(removalBlocked("a", { ...EMPTY_ADMIN, members, statuses: [status("a", "1"), status("b", "1")] })).toContain(
      "quorum",
    );
    expect(removalBlocked("c", { ...EMPTY_ADMIN, members, statuses: [status("a", "1"), status("b", "1")] })).toBeNull();
  });
  it("givenCurrentOrLastAdministrator_whenRevokingRoot_thenBlocksLockout", () => {
    const data = {
      ...EMPTY_ADMIN,
      auth: { enabled: true, revision: "1", currentUser: "me" },
      users: [
        { name: "me", roles: ["root"] },
        { name: "other", roles: ["root"] },
      ],
    };
    expect(accessChangeBlocked(data, { kind: "revokeRole", user: "me", role: "root" })).toContain("own");
    expect(
      accessChangeBlocked(
        { ...data, users: [{ name: "other", roles: ["root"] }] },
        { kind: "deleteUser", user: "other" },
      ),
    ).toContain("no administrator");
    expect(accessChangeBlocked(data, { kind: "enableAuth" })).toContain("root user");
    expect(accessChangeBlocked(data, { kind: "deleteRole", role: "root" })).not.toBeNull();
  });
  it("givenActiveRenewal_whenStopping_thenStopsWithoutRevoking", async () => {
    const methods: string[] = [];
    const store = createAdminStore(() =>
      Promise.resolve(
        client(async (method) => {
          await Promise.resolve();
          methods.push(method);
          if (method === "leases.keepAliveStart") return { keepAliveId: "renew-1", lease };
          if (method === "leases.list") return [lease];
          return null;
        }),
      ),
    );
    await store.getState().renew("source", lease.id);
    await store.getState().stopRenewals("source");
    expect(methods).toEqual(["leases.keepAliveStart", "leases.list", "leases.keepAliveStop"]);
    expect(store.getState().data.source?.renewals).toEqual({});
  });
  it("givenLateRenewalStart_whenDetached_thenClosesLateResource", async () => {
    let release: ((value: unknown) => void) | undefined;
    const stopped: unknown[] = [];
    const store = createAdminStore(() =>
      Promise.resolve(
        client(async (method, params) => {
          if (method === "leases.keepAliveStart")
            return new Promise((resolve) => {
              release = resolve;
            });
          if (method === "leases.keepAliveStop") stopped.push(params);
          return null;
        }),
      ),
    );
    const starting = store.getState().renew("source", lease.id);
    await Promise.resolve();
    await Promise.resolve();
    store.getState().detach("source");
    release?.({ keepAliveId: "late", lease });
    await starting;
    expect(stopped).toEqual([{ keepAliveId: "late" }]);
    expect(store.getState().data.source?.renewals).toEqual({});
  });
  it("givenRepeatedSequences_whenAppending_thenDeduplicatesAndBounds", () => {
    expect(
      appendWatchRows(
        [row("9007199254740993")],
        [row("9007199254740993"), row("9007199254740994"), row("9007199254740995")],
        2,
      ).map((item) => item.sequence),
    ).toEqual(["9007199254740994", "9007199254740995"]);
  });
  it("givenPausedPresentation_whenPolling_thenKeepsPullingAndAdvancesCursor", async () => {
    let next = ["1"];
    const params: unknown[] = [];
    const store = createWatchStore(() =>
      Promise.resolve(
        client(async (method, value) => {
          await Promise.resolve();
          if (method === "watch.start") return summary;
          if (method === "watch.window") {
            params.push(value);
            return windowOf(next);
          }
          return null;
        }),
      ),
    );
    await store.getState().start("source", request, 2);
    store.getState().pause("watch-1");
    next = ["2", "3"];
    await store.getState().poll("watch-1");
    expect(store.getState().entries["watch-1"]?.rows.map((item) => item.sequence)).toEqual(["1"]);
    expect(store.getState().entries["watch-1"]?.retained.map((item) => item.sequence)).toEqual(["2", "3"]);
    expect(params[1]).toEqual({
      watchId: "watch-1",
      afterSequence: "1",
      count: WATCH_WINDOW_COUNT,
      maxBytes: WATCH_WINDOW_BYTES,
    });
    store.getState().pause("watch-1");
    expect(store.getState().entries["watch-1"]?.rows.map((item) => item.sequence)).toEqual(["2", "3"]);
    expect(store.getState().entries["watch-1"]?.summary.gap).toBeNull();
  });
  it("givenDetachedWatch_whenClosingTab_thenDoesNotReconnect", async () => {
    let connects = 0;
    const store = createWatchStore(async () => {
      await Promise.resolve();
      connects++;
      return client((method) => Promise.resolve(method === "watch.start" ? summary : windowOf([])));
    });
    await store.getState().start("source", request);
    store.getState().detach("source");
    const before = connects;
    await store.getState().stop("watch-1", true);
    expect(connects).toBe(before);
    expect(store.getState().entries).toEqual({});
  });
  it("givenRetentionSetting_whenOutsideBounds_thenUsesDefault", () => {
    expect(watchRetentionError(999)).not.toBeNull();
    expect(watchRetentionError(100000)).toBeNull();
    expect(readSettings({ data: { watchRetention: 999 } }).data.watchRetention).toBe(
      DEFAULT_SETTINGS.data.watchRetention,
    );
  });
});
