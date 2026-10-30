import type {
  AccessChange,
  AccessPermission,
  Capability,
  ClusterAlarm,
  KeyRange,
} from "@table-craft/desktop/engine/protocol.js";
import { defineAction, type AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import { capabilitiesOf, datasourceById, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useTabs } from "@table-craft/desktop/renderer/state/tabs.js";
import { useModal } from "@table-craft/desktop/renderer/state/modal.js";
import { adminHost } from "./host.js";
import { accessChangeBlocked, bytesLabel, memberLag, removalBlocked, useKeyAdmin, type AdminView } from "./store.js";
import { transferDialog } from "./transfer.js";

export const ADMIN_ACTION_IDS = {
  leases: "keyAdmin.leases",
  access: "keyAdmin.access",
  coordination: "keyAdmin.coordination",
  cluster: "keyAdmin.cluster",
  command: "keyAdmin.command",
  import: "keyAdmin.transferImport",
  export: "keyAdmin.transferExport",
} as const;
export interface AdminOpenArgs {
  readonly datasourceId?: string;
  readonly leaseId?: string;
  /** Cluster only: which of its views to open; members when absent. */
  readonly view?: "members" | "alarms" | "maintenance";
}
export interface TransferArgs {
  readonly datasourceId?: string;
  readonly database?: number;
  readonly range?: KeyRange;
}
export type AdminCommand =
  | { readonly kind: "view"; readonly tabId: string; readonly view: AdminView }
  | { readonly kind: "refresh"; readonly view: AdminView }
  | { readonly kind: "grant" }
  | { readonly kind: "once" | "renew" | "revoke" | "keys" | "moreKeys" | "attach"; readonly leaseId: string }
  | { readonly kind: "promote" | "remove"; readonly memberId: string }
  | { readonly kind: "disarm"; readonly alarm: ClusterAlarm }
  | { readonly kind: "compact"; readonly revision: string; readonly physical: boolean }
  | { readonly kind: "defragment"; readonly endpointIds: readonly string[] }
  | { readonly kind: "snapshot"; readonly endpointId: string }
  | { readonly kind: "consistency"; readonly revision: string; readonly endpointIds: readonly string[] }
  | { readonly kind: "access"; readonly change: AccessChange }
  | { readonly kind: "newRole" | "newUser" }
  | { readonly kind: "password"; readonly user: string }
  | { readonly kind: "grantRole"; readonly user: string }
  | { readonly kind: "permission"; readonly role: string; readonly permission: AccessPermission }
  | { readonly kind: "queue" | "moreQueue"; readonly prefixId: string }
  | { readonly kind: "taskCancel" | "taskResume"; readonly taskId: string };
export interface AdminCommandArgs {
  readonly datasourceId: string;
  readonly command: AdminCommand;
}
const VIEW_CAPABILITY: Readonly<Record<AdminView, Capability>> = {
  leases: "leases",
  access: "access",
  coordination: "coordination",
  members: "members",
  alarms: "maintenance",
  maintenance: "maintenance",
};
const TITLES: Readonly<Record<AdminView, string>> = {
  leases: "Leases",
  access: "Users & Roles",
  coordination: "Locks & elections",
  members: "Server",
  alarms: "Server",
  maintenance: "Server",
};
const ask = () => useModal.getState();
export async function openAdmin(datasourceId: string, view: AdminView, leaseId?: string): Promise<void> {
  const existing = Object.entries(useKeyAdmin.getState().tabs).find(
    ([, tab]) =>
      tab.datasourceId === datasourceId &&
      (tab.view === view ||
        (["members", "alarms", "maintenance"].includes(tab.view) &&
          ["members", "alarms", "maintenance"].includes(view))),
  );
  if (existing !== undefined) {
    useTabs.getState().activate(existing[0]);
    await useKeyAdmin.getState().view(existing[0], view);
    if (leaseId !== undefined) useKeyAdmin.getState().selectLease(existing[0], leaseId);
    return;
  }
  const id = `key-admin-${datasourceId}-${view}`;
  useTabs.getState().open({ id, kind: "keyAdmin", title: TITLES[view] });
  await useKeyAdmin.getState().open(id, datasourceId, view);
  if (leaseId !== undefined) useKeyAdmin.getState().selectLease(id, leaseId);
}
export async function settleAdminRenewals(ids: readonly string[], verb: string): Promise<boolean> {
  const sources = new Set(
    ids.flatMap((id) => {
      const tab = useKeyAdmin.getState().tabs[id];
      return tab === undefined || tab.view !== "leases" ? [] : [tab.datasourceId];
    }),
  );
  for (const source of sources) {
    const renewals = Object.keys(useKeyAdmin.getState().data[source]?.renewals ?? {});
    if (renewals.length === 0) continue;
    if (
      (await ask().ask({
        kind: "confirm",
        title: "Stop keeping leases alive?",
        message: `To ${verb}, TableCraft will stop renewing ${renewals.length} leases. It will not revoke them, but they may expire and delete their attached keys.`,
        confirm: "Stop Renewing",
        destructive: true,
      })) === null
    )
      return false;
    await useKeyAdmin.getState().stopRenewals(source);
  }
  return true;
}
export async function revokeLease(id: string, leaseId: string): Promise<void> {
  const store = useKeyAdmin.getState();
  const preview = await store.call(id, "leases.prepareRevoke", { leaseId });
  const lease = preview.lease;
  const total = lease.totalKeyCount ?? "an unknown number of";
  const outside = lease.outsideNamespaceKeyCount;
  const result = await ask().ask({
    kind: "confirm",
    title: `Revoke lease ${leaseId}?`,
    message: `This is cluster-global. ${total} keys will be deleted at once, including ${outside ?? "an unknown number of"} keys outside this namespace. This cannot be undone. Type the lease ID to continue.`,
    items: preview.sampleKeys
      .slice(0, 10)
      .map((key) => ({ label: bytesLabel(key), detail: "Sample of globally attached keys", tone: "info" })),
    typed: leaseId,
    confirm: `Revoke and Delete ${total} Keys`,
    destructive: true,
  });
  if (result !== null) {
    await store.call(id, "leases.revokePrepared", { token: preview.token });
    await store.refresh(id, "leases");
  }
}
export function accessBlocked(id: string, change: AccessChange): string | null {
  return accessChangeBlocked(useKeyAdmin.getState().data[id], change);
}
async function applyAccess(id: string, change: AccessChange): Promise<void> {
  await useKeyAdmin.getState().refresh(id, "access");
  if (useKeyAdmin.getState().data[id]?.error != null)
    throw new Error("Could not refresh current access. No change was submitted.");
  const blocked = accessBlocked(id, change);
  if (blocked !== null) throw new Error(blocked);
  const data = useKeyAdmin.getState().data[id];
  const datasource = datasourceById(useDatasources.getState(), id);
  const transition = change.kind === "enableAuth" || change.kind === "disableAuth";
  const self = "user" in change && change.user === data?.auth?.currentUser;
  const root = "role" in change && change.role === "root";
  if (
    (await ask().ask({
      kind: "confirm",
      title: transition ? "Change cluster authentication?" : "Change cluster access?",
      message: transition
        ? "This affects the entire cluster, not just this namespace. Existing connections may lose access and must reconnect with suitable credentials. Enabling requires a root connection; disabling allows anyone who can reach the cluster to read and write every key."
        : `${JSON.stringify(change)}${root ? " Root grants full cluster administration." : ""}${self ? " This changes your own access and may disconnect or lock you out." : ""} This is cluster-global.`,
      confirm: "Apply Change",
      destructive: true,
      ...(change.kind === "disableAuth" || self ? { typed: datasource?.name ?? id } : {}),
    })) === null
  )
    return;
  await useKeyAdmin.getState().call(id, "access.apply", { change });
  await useKeyAdmin.getState().refresh(id, "access");
}
async function command(id: string, value: AdminCommand): Promise<void> {
  const store = useKeyAdmin.getState();
  const datasource = datasourceById(useDatasources.getState(), id);
  if (datasource === undefined) return;
  const reads = ["view", "refresh", "keys", "moreKeys", "queue", "moreQueue", "consistency", "taskCancel"];
  if (!reads.includes(value.kind) && datasource.readOnly) throw new Error("Read-only data source");
  switch (value.kind) {
    case "view":
      await store.view(value.tabId, value.view);
      return;
    case "refresh":
      await store.refresh(id, value.view);
      return;
    case "keys":
    case "moreKeys":
      await store.keys(id, value.leaseId, value.kind === "moreKeys");
      return;
    case "queue":
    case "moreQueue":
      await store.readQueue(id, value.prefixId, value.kind === "moreQueue");
      return;
    case "grant": {
      const preset = await ask().ask({
        kind: "pick",
        title: "Grant Lease",
        searchLabel: "TTL preset",
        items: [
          { id: "10", label: "10 seconds", detail: "" },
          { id: "60", label: "60 seconds", detail: "" },
          { id: "300", label: "5 minutes", detail: "" },
          { id: "3600", label: "1 hour", detail: "" },
          { id: "custom", label: "Custom…", detail: "TTL in seconds" },
        ],
        empty: "Choose Custom for another TTL.",
        confirm: "Continue",
      });
      const ttl =
        preset === "custom"
          ? await ask().ask({
              kind: "text",
              title: "Grant Lease",
              label: "TTL in seconds",
              initial: "60",
              confirm: "Grant Lease",
            })
          : preset;
      if (ttl === null) return;
      if (!/^[1-9]\d{0,18}$/.test(ttl)) throw new Error("Enter a positive whole number of seconds.");
      await store.call(id, "leases.grant", { ttlSeconds: ttl });
      await store.refresh(id, "leases");
      return;
    }
    case "once":
      await store.call(id, "leases.keepAliveOnce", { leaseId: value.leaseId });
      await store.refresh(id, "leases");
      return;
    case "renew":
      await store.renew(id, value.leaseId);
      return;
    case "revoke":
      await revokeLease(id, value.leaseId);
      return;
    case "attach": {
      const encoding = await ask().ask({
        kind: "pick",
        title: "Attach Key to Lease",
        searchLabel: "Key encoding",
        items: [
          { id: "text", label: "UTF-8 text", detail: "Namespace-relative key" },
          { id: "hex", label: "Hex bytes", detail: "Binary key" },
        ],
        empty: "Choose a key encoding.",
        confirm: "Continue",
      });
      if (encoding === null) return;
      const name = await ask().ask({
        kind: "text",
        title: "Attach Key to Lease",
        label: encoding === "hex" ? "Key as hex byte pairs" : "Namespace-relative key",
        initial: "",
        confirm: "Read Key",
      });
      if (name === null) return;
      if (encoding === "hex" && !/^(?:[a-f\d]{2})+$/i.test(name)) throw new Error("Enter complete hex byte pairs.");
      const key = encoding === "hex" ? { text: "", hex: name.toLowerCase() } : { text: name, hex: null };
      const history = await store.call(id, "keyspace.history", {
        database: 0,
        key,
        cursor: null,
        count: 1,
        maxBytes: 1_048_576,
        timeoutMs: 5_000,
      });
      const event = history.events[0];
      if (event === undefined || event.kind !== "PUT")
        throw new Error("This key does not currently exist. Refresh the key before assigning a lease.");
      const options = {
        type: "string" as const,
        guard: true,
        revisionGuard: { modRevision: event.modRevision },
        lease: { kind: "attach" as const, leaseId: value.leaseId },
      };
      const preview = await store.call(id, "keyspace.preview", { key, changes: [], options });
      if (
        (await ask().ask({
          kind: "confirm",
          title: `Attach ${bytesLabel(key)} to lease ${value.leaseId}?`,
          message: `The value is preserved. Assignment is guarded at modified revision ${event.modRevision}; the key will be deleted if this lease expires or is revoked.\n${preview.join("\n")}`,
          confirm: "Attach Key",
          destructive: true,
        })) === null
      )
        return;
      await store.call(id, "keyspace.apply", { database: 0, key, changes: [], options });
      await store.keys(id, value.leaseId);
      await store.refresh(id, "leases");
      return;
    }
    case "access":
      await applyAccess(id, value.change);
      return;
    case "permission":
      await applyAccess(id, { kind: "grantPermission", role: value.role, permission: value.permission });
      return;
    case "newUser":
    case "newRole": {
      const name = await ask().ask({
        kind: "text",
        title: value.kind === "newUser" ? "New User" : "New Role",
        label: "Name",
        initial: "",
        confirm: "Continue",
      });
      if (!name) return;
      if (value.kind === "newUser") await adminHost().applySecret(id, name, "createUser");
      else await applyAccess(id, { kind: "createRole", role: name });
      await store.refresh(id, "access");
      return;
    }
    case "password":
      await adminHost().applySecret(id, value.user, "changePassword");
      return;
    case "grantRole": {
      const role = await ask().ask({
        kind: "pick",
        title: "Grant Role",
        searchLabel: "Role",
        items: (store.data[id]?.roles ?? []).map((role) => ({
          id: role.name,
          label: role.name,
          detail: role.name === "root" ? "Full cluster administration" : "",
        })),
        empty: "No roles. Create one first.",
        confirm: "Grant Role",
      });
      if (role !== null) await applyAccess(id, { kind: "grantRole", user: value.user, role });
      return;
    }
    case "remove":
    case "promote": {
      await store.refresh(id, "members");
      const data = useKeyAdmin.getState().data[id];
      const member = data?.members.find((member) => member.id === value.memberId);
      if (data === undefined || member === undefined) return;
      if (data.error !== null)
        throw new Error("Could not refresh quorum and member status. No membership change was submitted.");
      if (value.kind === "remove") {
        const blocked = removalBlocked(member.id, data);
        if (blocked !== null) throw new Error(blocked);
      } else {
        const status = data.statuses.find((status) => status.memberId === member.id);
        if (!member.learner || status === undefined || memberLag(status, data.statuses) !== "0")
          throw new Error("The learner has not caught up, or its lag is unknown. Refresh before promoting.");
      }
      if (
        (await ask().ask({
          kind: "confirm",
          title: `${value.kind === "remove" ? "Remove" : "Promote"} ${member.name}?`,
          message:
            "This changes cluster membership globally. Check healthy voting members and quorum before continuing.",
          typed: member.name || member.id,
          confirm: value.kind === "remove" ? "Remove Member" : "Promote Member",
          destructive: true,
        })) === null
      )
        return;
      await store.refresh(id, "members");
      const fresh = useKeyAdmin.getState().data[id];
      if (fresh === undefined || fresh.error !== null)
        throw new Error("The final member health check failed. No change was submitted.");
      if (value.kind === "remove") {
        const blocked = removalBlocked(member.id, fresh);
        if (blocked !== null) throw new Error(blocked);
      } else {
        const status = fresh.statuses.find((item) => item.memberId === member.id);
        if (
          !fresh.members.some((item) => item.id === member.id && item.learner) ||
          status === undefined ||
          memberLag(status, fresh.statuses) !== "0"
        )
          throw new Error("The learner's current lag is unknown or it has fallen behind. No change was submitted.");
      }
      if (value.kind === "remove") await store.call(id, "cluster.remove", { memberId: member.id });
      else await store.call(id, "cluster.promote", { memberId: member.id });
      await store.refresh(id, "members");
      return;
    }
    case "disarm":
      if (
        (await ask().ask({
          kind: "confirm",
          title: `Disarm ${value.alarm.kind}?`,
          message:
            "Disarming does not repair the cause. For NOSPACE, compact and defragment every member first. For CORRUPT, stop writing and restore from a snapshot.",
          confirm: "Disarm Alarm",
          destructive: true,
        })) !== null
      ) {
        await store.call(id, "cluster.disarm", { alarm: value.alarm });
        await store.refresh(id, "alarms");
      }
      return;
    case "compact":
      if (!/^[1-9]\d{0,19}$/.test(value.revision)) throw new Error("Enter a positive revision.");
      if (
        (await ask().ask({
          kind: "confirm",
          title: `Compact to revision ${value.revision}?`,
          message:
            "History before this revision is gone for every key in the entire cluster, for good. Watches starting from older revisions will fail. The namespace does not limit compaction.",
          typed: value.revision,
          confirm: "Compact Cluster History",
          destructive: true,
        })) !== null
      )
        await store.call(id, "cluster.compact", { revision: value.revision, physical: value.physical });
      return;
    case "defragment":
      if (
        (await ask().ask({
          kind: "confirm",
          title: "Defragment members?",
          message:
            "A member blocks reads and writes while it defragments. Members run sequentially, followers first and leader last. Only configured endpoints are used.",
          confirm: "Defragment",
          destructive: true,
        })) !== null
      )
        await store.call(id, "maintenance.defragmentStart", { endpointIds: value.endpointIds });
      break;
    case "snapshot": {
      if (
        (await ask().ask({
          kind: "confirm",
          title: "Save full cluster snapshot?",
          message:
            "This sensitive backend contains all namespaces, credentials and cluster data, not just the keys visible here. The host verifies the trailing checksum before publishing the file.",
          confirm: "Choose Snapshot File",
        })) === null
      )
        return;
      const fileGrantId = await adminHost().chooseFile(id, "cluster.snapshot");
      if (fileGrantId !== null)
        await store.call(id, "maintenance.snapshotStart", { endpointId: value.endpointId, fileGrantId });
      break;
    }
    case "consistency":
      await store.call(id, "maintenance.consistencyStart", {
        endpointIds: value.endpointIds,
        revision: value.revision,
      });
      break;
    case "taskResume": {
      const task = store.data[id]?.tasks.find((task) => task.taskId === value.taskId);
      if (task?.resumable !== true || task.outcome !== "confirmed")
        throw new Error(
          "The last chunk is not confirmed. Inspect the imported keys; do not blindly resume an uncertain write.",
        );
      await store.call(id, "keyTransfer.resume", { taskId: value.taskId });
      break;
    }
    case "taskCancel": {
      const task = store.data[id]?.tasks.find((task) => task.taskId === value.taskId);
      if (task?.kind === "import" || task?.kind === "export")
        await store.call(id, "keyTransfer.cancel", { taskId: value.taskId });
      else await store.call(id, "maintenance.cancel", { taskId: value.taskId });
      break;
    }
  }
  await store.tasks(id);
}
export const ADMIN_ACTIONS: readonly AnyAction[] = [
  ...(["leases", "access", "coordination", "members"] as const).map((view) =>
    defineAction<AdminOpenArgs | undefined>({
      id: view === "members" ? ADMIN_ACTION_IDS.cluster : ADMIN_ACTION_IDS[view],
      title: TITLES[view],
      category: "Database",
      icon: "server",
      available: (context) => context.datasource?.capabilities.includes(VIEW_CAPABILITY[view]) === true,
      run: async (context, args) => {
        const id = args?.datasourceId ?? context.datasource?.view.id;
        if (id !== undefined) await openAdmin(id, view === "members" ? (args?.view ?? view) : view, args?.leaseId);
      },
    }),
  ),
  defineAction<AdminCommandArgs | undefined>({
    id: ADMIN_ACTION_IDS.command,
    title: "Manage Key Service",
    category: "Database",
    run: async (_context, args) => {
      if (args === undefined) return;
      const ds = datasourceById(useDatasources.getState(), args.datasourceId);
      if (ds === undefined) return;
      const caps = capabilitiesOf(useDatasources.getState().plugins, ds.pluginId);
      if (!caps.some((cap) => Object.values(VIEW_CAPABILITY).includes(cap))) return;
      try {
        await command(args.datasourceId, args.command);
      } catch (cause) {
        await ask().ask({
          kind: "notice",
          title: "Operation could not be confirmed",
          message: cause instanceof Error ? cause.message : "The operation failed.",
          hint: "Refresh to inspect the current state before retrying a mutation.",
        });
      }
    },
  }),
  ...(["import", "export"] as const).map((kind) =>
    defineAction<TransferArgs | undefined>({
      id: ADMIN_ACTION_IDS[kind],
      title: kind === "import" ? "Import Keys from JSON…" : "Export Key Range to JSON…",
      category: "Database",
      icon: kind,
      available: (context) => context.datasource?.capabilities.includes("bulkTransfer") === true,
      when: (context) => kind === "export" || context.datasource?.view.readOnly !== true,
      run: async (context, args) => {
        const id = args?.datasourceId ?? context.datasource?.view.id;
        if (id !== undefined) await transferDialog(id, kind, args?.database ?? 0, args?.range ?? { kind: "all" });
      },
    }),
  ),
];
