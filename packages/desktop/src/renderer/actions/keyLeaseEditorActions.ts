import type { ActionContext } from "./context.js";
import { defineAction, type AnyAction } from "./registry.js";
import { useKeyTabs } from "@table-craft/desktop/renderer/state/keyTabs.js";
import { datasourceById, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useModal } from "@table-craft/desktop/renderer/state/modal.js";

export const KEY_LEASE_EDITOR_IDS = {
  keep: "key.lease.keep",
  detach: "key.lease.detach",
  attach: "key.lease.attach",
  grant: "key.lease.grant",
} as const;

function available(context: ActionContext): boolean {
  return context.capabilities.includes("leases") && context.keyTab?.leaseAssignmentAvailable === true;
}
function writable(context: ActionContext): boolean {
  return (
    available(context) &&
    context.keyTab?.revisionGuardAvailable === true &&
    context.keyTab.status === "ready" &&
    context.keyTab.readOnly === null &&
    context.datasource?.view.readOnly !== true
  );
}

export const KEY_LEASE_EDITOR_ACTIONS: readonly AnyAction[] = [
  ...(["keep", "detach"] as const).map((kind) =>
    defineAction({
      id: KEY_LEASE_EDITOR_IDS[kind],
      title: kind === "keep" ? "Keep Lease" : "Detach Lease on Save",
      category: "Key Editor",
      tabKind: "key",
      available,
      when: writable,
      run: (context) => {
        if (context.activeTab !== null)
          useKeyTabs.getState().setLease(context.activeTab.id, { kind: kind === "keep" ? "preserve" : "detach" });
      },
    }),
  ),
  defineAction({
    id: KEY_LEASE_EDITOR_IDS.attach,
    title: "Attach to Lease…",
    category: "Key Editor",
    tabKind: "key",
    available,
    when: writable,
    run: async (context) => {
      const tab = context.keyTab;
      const id = context.activeTab?.id;
      if (tab == null || id === undefined) return;
      const client = await useDatasources.getState().connect(tab.datasourceId);
      const leases = await client.call("leases.list", {});
      const leaseId = await useModal.getState().ask({
        kind: "pick",
        title: "Attach to Lease on Save",
        searchLabel: "Lease ID (cluster-wide)",
        items: leases
          .filter((lease) => lease.state === "active")
          .map((lease) => ({
            id: lease.id,
            label: lease.id,
            detail: `${lease.remainingTtlSeconds ?? "Unknown"} seconds left · ${lease.totalKeyCount ?? "Unknown"} keys in the cluster`,
          })),
        empty: "No active leases. Grant a lease first.",
        confirm: "Stage Attachment",
      });
      if (leaseId === null || useKeyTabs.getState().tabs[id] !== tab) return;
      const lease = await client.call("leases.get", { leaseId });
      if (lease.state !== "active" || useKeyTabs.getState().tabs[id] !== tab) return;
      useKeyTabs.getState().setLease(id, { kind: "attach", leaseId });
    },
  }),
  defineAction({
    id: KEY_LEASE_EDITOR_IDS.grant,
    title: "Grant Lease and Stage Attachment…",
    category: "Key Editor",
    tabKind: "key",
    available,
    when: writable,
    run: async (context) => {
      const tab = context.keyTab;
      const id = context.activeTab?.id;
      if (tab == null || id === undefined) return;
      const ttlSeconds = await useModal.getState().ask({
        kind: "text",
        title: "Grant Cluster-wide Lease",
        label: "TTL in whole seconds. The lease is created now; key attachment waits for Submit.",
        initial: "60",
        confirm: "Grant Lease",
      });
      if (ttlSeconds === null || useKeyTabs.getState().tabs[id] !== tab) return;
      if (!/^[1-9]\d{0,19}$/.test(ttlSeconds)) {
        await useModal.getState().ask({
          kind: "notice",
          title: "Invalid TTL",
          message: "Enter a positive whole number of seconds.",
          hint: "No lease was created.",
        });
        return;
      }
      const client = await useDatasources.getState().connect(tab.datasourceId);
      if (
        useKeyTabs.getState().tabs[id] !== tab ||
        datasourceById(useDatasources.getState(), tab.datasourceId)?.readOnly === true
      )
        return;
      const lease = await client.call("leases.grant", { ttlSeconds });
      if (useKeyTabs.getState().tabs[id] === tab)
        useKeyTabs.getState().setLease(id, { kind: "attach", leaseId: lease.id });
    },
  }),
];
