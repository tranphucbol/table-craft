import { create } from "zustand";
import type {
  AccessChange,
  AccessRole,
  AccessStatus,
  AccessUser,
  ClusterAlarm,
  ClusterEndpoint,
  ClusterMember,
  ClusterStatus,
  CoordinationPage,
  CoordinationPrefix,
  EngineCalls,
  KeyBytes,
  KeyTask,
  LeaseInfo,
  LeaseKeyPage,
} from "@table-craft/desktop/engine/protocol.js";
import type { EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";

export type AdminView = "leases" | "access" | "coordination" | "members" | "alarms" | "maintenance";
export interface AdminTab {
  readonly datasourceId: string;
  readonly view: AdminView;
  readonly leaseId?: string;
  /** Counts lease requests, so asking again for the same lease re-selects it after the user moved on. */
  readonly leaseFocus?: number;
}
export interface AdminData {
  readonly loading: boolean;
  readonly error: string | null;
  readonly leases: readonly LeaseInfo[];
  readonly leaseReadAt: number;
  readonly leaseKeys: Readonly<Record<string, LeaseKeyPage>>;
  readonly renewals: Readonly<Record<string, string>>;
  readonly renewalStops: Readonly<Record<string, string>>;
  readonly endpoints: readonly ClusterEndpoint[];
  readonly members: readonly ClusterMember[];
  readonly statuses: readonly ClusterStatus[];
  readonly alarms: readonly ClusterAlarm[];
  readonly auth: AccessStatus | null;
  readonly users: readonly AccessUser[];
  readonly roles: readonly AccessRole[];
  readonly prefixes: readonly CoordinationPrefix[];
  readonly queues: Readonly<Record<string, CoordinationPage>>;
  readonly coordinationLeases: Readonly<Record<string, { readonly lease: LeaseInfo; readonly readAt: number }>>;
  readonly tasks: readonly KeyTask[];
}
export const EMPTY_ADMIN: AdminData = {
  loading: false,
  error: null,
  leases: [],
  leaseReadAt: 0,
  leaseKeys: {},
  renewals: {},
  renewalStops: {},
  endpoints: [],
  members: [],
  statuses: [],
  alarms: [],
  auth: null,
  users: [],
  roles: [],
  prefixes: [],
  queues: {},
  coordinationLeases: {},
  tasks: [],
};
const PAGE_SIZE = 100;
type Call = <M extends keyof EngineCalls>(
  datasourceId: string,
  method: M,
  params: EngineCalls[M]["params"],
) => Promise<EngineCalls[M]["result"]>;
interface AdminState {
  readonly tabs: Readonly<Record<string, AdminTab>>;
  readonly data: Readonly<Record<string, AdminData>>;
  readonly open: (id: string, datasourceId: string, view: AdminView) => Promise<void>;
  readonly view: (id: string, view: AdminView) => Promise<void>;
  readonly selectLease: (id: string, leaseId: string) => void;
  readonly refresh: (datasourceId: string, view: AdminView) => Promise<void>;
  readonly call: Call;
  readonly keys: (datasourceId: string, leaseId: string, more?: boolean) => Promise<void>;
  readonly renew: (datasourceId: string, leaseId: string) => Promise<void>;
  readonly stopRenewals: (datasourceId: string) => Promise<void>;
  readonly close: (id: string) => void;
  readonly detach: (datasourceId: string) => void;
  readonly tasks: (datasourceId: string) => Promise<void>;
  readonly readQueue: (datasourceId: string, prefixId: string, more?: boolean) => Promise<void>;
  readonly pollQueues: (datasourceId: string) => Promise<void>;
}
export function createAdminStore(connect: (id: string) => Promise<EngineClient>) {
  const generations = new Map<string, number>();
  const queueWatches = new Map<
    string,
    { readonly datasourceId: string; readonly prefixId: string; readonly watchId: string; cursor: string | null }
  >();
  const refreshes = new Set<string>();
  const polling = new Set<string>();
  const renewing = new Set<string>();
  return create<AdminState>()((set, get) => {
    const patch = (id: string, change: Partial<AdminData>) =>
      set({ data: { ...get().data, [id]: { ...(get().data[id] ?? EMPTY_ADMIN), ...change } } });
    const call: Call = async (id, method, params) => (await connect(id)).call(method, params);
    async function refresh(id: string, view: AdminView) {
      const refreshId = `${id}:${view}`;
      if (refreshes.has(refreshId)) return;
      refreshes.add(refreshId);
      const generation = generations.get(id) ?? 0;
      patch(id, { loading: true, error: null });
      try {
        let change: Partial<AdminData>;
        if (view === "leases") {
          const leases = await call(id, "leases.list", {});
          const renewals = { ...get().data[id]?.renewals };
          const renewalStops = { ...get().data[id]?.renewalStops };
          for (const lease of leases) {
            if (lease.renewal?.state === "stopped") {
              delete renewals[lease.id];
              renewalStops[lease.id] = lease.renewal.reason ?? "Renewal was not confirmed. Inspect the remaining TTL.";
            } else if (lease.renewal?.state === "active") {
              renewals[lease.id] = lease.renewal.keepAliveId;
              delete renewalStops[lease.id];
            }
          }
          change = { leases, renewals, renewalStops, leaseReadAt: Date.now() };
        } else if (view === "access") {
          const [auth, users, roles] = await Promise.all([
            call(id, "access.status", {}),
            call(id, "access.users", {}),
            call(id, "access.roles", {}),
          ]);
          change = { auth, users, roles };
        } else if (view === "coordination") {
          const prefixes = await call(id, "coordination.prefixes", {});
          change = { prefixes };
          for (const prefix of prefixes) {
            const key = `${id}:${prefix.id}`;
            if (queueWatches.has(key)) continue;
            const watch = await call(id, "watch.start", {
              database: 0,
              range: { kind: "prefix", prefix: prefix.prefix },
              from: { kind: "now" },
              maxEvents: PAGE_SIZE,
              maxBytes: 1_048_576,
            });
            if ((generations.get(id) ?? 0) !== generation) {
              await call(id, "watch.stop", { watchId: watch.watchId });
              break;
            }
            queueWatches.set(key, { datasourceId: id, prefixId: prefix.id, watchId: watch.watchId, cursor: null });
            await get().readQueue(id, prefix.id);
          }
        } else {
          const [endpoints, members, alarms] = await Promise.all([
            call(id, "cluster.endpoints", {}),
            call(id, "cluster.members", {}),
            call(id, "cluster.alarms", {}),
          ]);
          const results = await Promise.allSettled(
            endpoints.map((endpoint) => call(id, "cluster.status", { endpointId: endpoint.id })),
          );
          change = {
            endpoints,
            members,
            alarms,
            statuses: results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])),
          };
        }
        if ((generations.get(id) ?? 0) === generation) patch(id, { ...change, loading: false });
      } catch (cause) {
        if ((generations.get(id) ?? 0) === generation)
          patch(id, { loading: false, error: cause instanceof Error ? cause.message : String(cause) });
      } finally {
        refreshes.delete(refreshId);
      }
    }
    return {
      tabs: {},
      data: {},
      call,
      refresh,
      selectLease(id, leaseId) {
        const tab = get().tabs[id];
        if (tab !== undefined)
          set({ tabs: { ...get().tabs, [id]: { ...tab, leaseId, leaseFocus: (tab.leaseFocus ?? 0) + 1 } } });
      },
      async open(id, datasourceId, view) {
        set({ tabs: { ...get().tabs, [id]: { datasourceId, view } } });
        await refresh(datasourceId, view);
      },
      async view(id, view) {
        const tab = get().tabs[id];
        if (tab === undefined) return;
        set({ tabs: { ...get().tabs, [id]: { ...tab, view } } });
        await refresh(tab.datasourceId, view);
      },
      async keys(id, leaseId, more = false) {
        const previous = get().data[id]?.leaseKeys[leaseId];
        const page = await call(id, "leases.keys", {
          leaseId,
          cursor: more ? (previous?.cursor ?? null) : null,
          count: PAGE_SIZE,
        });
        patch(id, {
          leaseKeys: {
            ...get().data[id]?.leaseKeys,
            [leaseId]: { ...page, keys: more ? [...(previous?.keys ?? []), ...page.keys] : page.keys },
          },
        });
      },
      async renew(id, leaseId) {
        const key = `${id}:${leaseId}`;
        if (renewing.has(key)) return;
        renewing.add(key);
        try {
          const current = get().data[id]?.renewals[leaseId];
          if (current !== undefined) {
            await call(id, "leases.keepAliveStop", { keepAliveId: current });
            const { [leaseId]: _gone, ...renewals } = get().data[id]?.renewals ?? {};
            patch(id, { renewals });
            return;
          }
          const generation = generations.get(id) ?? 0;
          const client = await connect(id);
          const started = await client.call("leases.keepAliveStart", { leaseId });
          if ((generations.get(id) ?? 0) !== generation) {
            await client.call("leases.keepAliveStop", { keepAliveId: started.keepAliveId });
            return;
          }
          const { [leaseId]: _stopped, ...renewalStops } = get().data[id]?.renewalStops ?? {};
          patch(id, { renewals: { ...get().data[id]?.renewals, [leaseId]: started.keepAliveId }, renewalStops });
          await refresh(id, "leases");
        } finally {
          renewing.delete(key);
        }
      },
      async stopRenewals(id) {
        generations.set(id, (generations.get(id) ?? 0) + 1);
        for (const keepAliveId of Object.values(get().data[id]?.renewals ?? {}))
          await call(id, "leases.keepAliveStop", { keepAliveId });
        patch(id, { renewals: {} });
      },
      close(id) {
        const tab = get().tabs[id];
        const { [id]: _gone, ...tabs } = get().tabs;
        set({ tabs });
        if (tab?.view === "coordination")
          for (const [key, watch] of queueWatches)
            if (watch.datasourceId === tab.datasourceId) {
              queueWatches.delete(key);
              void call(watch.datasourceId, "watch.stop", { watchId: watch.watchId }).catch(() => undefined);
            }
      },
      detach(id) {
        generations.set(id, (generations.get(id) ?? 0) + 1);
        for (const [key, watch] of queueWatches) if (watch.datasourceId === id) queueWatches.delete(key);
        patch(id, {
          renewals: {},
          loading: false,
          error: "Disconnected. Renewals stopped; leases may expire. Refresh after reconnecting.",
        });
      },
      async tasks(id) {
        const [maintenance, transfer] = await Promise.all([
          call(id, "maintenance.list", {}).catch(() => []),
          call(id, "keyTransfer.list", {}).catch(() => []),
        ]);
        patch(id, { tasks: [...maintenance, ...transfer] });
      },
      async readQueue(id, prefixId, more = false) {
        const generation = generations.get(id) ?? 0;
        const old = get().data[id]?.queues[prefixId];
        const page = await call(id, "coordination.read", {
          prefixId,
          cursor: more ? (old?.cursor ?? null) : null,
          count: PAGE_SIZE,
        });
        const leaseIds = [
          ...new Set(
            page.queues.flatMap((queue) =>
              queue.complete
                ? [...queue.candidates]
                    .sort((a, b) =>
                      BigInt(a.createRevision) < BigInt(b.createRevision)
                        ? -1
                        : BigInt(a.createRevision) > BigInt(b.createRevision)
                          ? 1
                          : 0,
                    )
                    .slice(0, 1)
                    .map((candidate) => candidate.leaseId)
                : [],
            ),
          ),
        ];
        const leases = await Promise.allSettled(leaseIds.map((leaseId) => call(id, "leases.get", { leaseId })));
        if ((generations.get(id) ?? 0) !== generation) return;
        const readAt = Date.now();
        const coordinationLeases = { ...get().data[id]?.coordinationLeases };
        for (const result of leases)
          if (result.status === "fulfilled") coordinationLeases[result.value.id] = { lease: result.value, readAt };
        patch(id, {
          coordinationLeases,
          queues: {
            ...get().data[id]?.queues,
            [prefixId]: { ...page, queues: more ? [...(old?.queues ?? []), ...page.queues] : page.queues },
          },
        });
      },
      async pollQueues(id) {
        if (polling.has(id)) return;
        polling.add(id);
        try {
          for (const watch of queueWatches.values()) {
            if (watch.datasourceId !== id) continue;
            const window = await call(id, "watch.window", {
              watchId: watch.watchId,
              afterSequence: watch.cursor,
              count: PAGE_SIZE,
              maxBytes: 1_048_576,
            });
            watch.cursor = window.rows.at(-1)?.sequence ?? watch.cursor;
            if (window.rows.length > 0 || window.gap !== null) await get().readQueue(id, watch.prefixId);
            if (window.state === "gap" || window.state === "stopped")
              patch(id, {
                error:
                  "The coordination watch has a gap or stopped. Refresh to read a new queue snapshot; do not infer ownership from stale rows.",
              });
          }
        } catch (cause) {
          patch(id, { error: cause instanceof Error ? cause.message : String(cause) });
        } finally {
          polling.delete(id);
        }
      },
    };
  });
}
export const useKeyAdmin = createAdminStore((id) => useDatasources.getState().connect(id));
export function bytesLabel(bytes: KeyBytes): string {
  return bytes.hex === null ? bytes.text : bytes.hex.replace(/../g, "\\x$&");
}
export function remainingTtl(lease: LeaseInfo, readAt: number, now: number): string {
  if (lease.remainingTtlSeconds === null) return "Unknown";
  const left = BigInt(lease.remainingTtlSeconds) - BigInt(Math.max(0, Math.floor((now - readAt) / 1000)));
  return left > 0n ? `${left} s` : "Expired";
}
export function memberLag(status: ClusterStatus, statuses: readonly ClusterStatus[]): string | null {
  const leader = statuses.find((item) => item.memberId === status.leaderId);
  if (leader?.appliedIndex == null || status.appliedIndex === null) return null;
  return String(
    BigInt(leader.appliedIndex) > BigInt(status.appliedIndex)
      ? BigInt(leader.appliedIndex) - BigInt(status.appliedIndex)
      : 0n,
  );
}
export function removalBlocked(memberId: string, data: AdminData): string | null {
  const voters = data.members.filter((member) => !member.learner);
  const remaining = voters.filter((member) => member.id !== memberId);
  const healthy = remaining.filter((member) =>
    data.statuses.some((status) => status.memberId === member.id && status.leaderId !== null),
  );
  if (remaining.length === 0 || healthy.length < Math.floor(voters.length / 2) + 1)
    return "Removing this member could lose quorum. Restore healthy voting members first.";
  return null;
}
export function accessChangeBlocked(data: AdminData | undefined, change: AccessChange): string | null {
  if (data === undefined) return "Refresh users and roles first.";
  const roots = data.users.filter((user) => user.roles.includes("root"));
  const losesRoot = change.kind === "deleteUser" || (change.kind === "revokeRole" && change.role === "root");
  if (losesRoot && "user" in change && change.user === data.auth?.currentUser)
    return "This would remove your own administrative access. Use another administrator connection.";
  if (losesRoot && "user" in change && roots.some((root) => root.name === change.user) && roots.length <= 1)
    return "Auth would have no administrator.";
  if (change.kind === "deleteRole" && change.role === "root") return "The root role cannot be deleted.";
  if (change.kind === "enableAuth" && !data.users.some((user) => user.name === "root" && user.roles.includes("root")))
    return "Create the root user and grant it the root role first.";
  return null;
}
