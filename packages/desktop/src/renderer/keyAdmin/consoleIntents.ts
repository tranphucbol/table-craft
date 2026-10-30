import type { Capability } from "@table-craft/desktop/engine/protocol.js";
import { defineAction, type AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import { capabilitiesOf, datasourceById, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useModal } from "@table-craft/desktop/renderer/state/modal.js";
import { ADMIN_ACTIONS, ADMIN_ACTION_IDS, type AdminOpenArgs } from "./actions.js";
import { WATCH_ACTIONS, WATCH_ACTION_IDS, type WatchStartArgs } from "@table-craft/desktop/renderer/watch/actions.js";

/**
 * The inspection ids a key-value plugin's `language.inspect` puts on a console command that must
 * open a manager instead of running as a statement (plan 110 console). The prefix is the
 * inspection namespace, not a plugin id; the UI still branches only on the suffix.
 */
export const MANAGED_INTENT_INSPECTION_PREFIX = "EtcdConsoleIntent.";
export const MANAGED_INTENT_KINDS = [
  "credentials",
  "watch",
  "snapshot",
  "keepAlive",
  "access",
  "cluster",
  "leaseRevoke",
  "leaseGrant",
  "admin",
] as const;
export type ManagedIntentKind = (typeof MANAGED_INTENT_KINDS)[number];

/** The one action console admission invokes for a managed command; it never receives console text. */
export const MANAGED_INTENT_ACTION_ID = "console.openManagedIntent";
export interface ManagedIntentArgs {
  readonly datasourceId: string;
  /** The `inspection` id of the plugin's Problem, such as `EtcdConsoleIntent.watch`. */
  readonly inspection: string;
}

export interface ManagedIntentRoute {
  readonly kind: ManagedIntentKind;
  readonly actionId: string;
  readonly args: AdminOpenArgs | WatchStartArgs;
  /** The datasource must declare this for the manager to exist. */
  readonly capability: Capability;
  /** Shown to the user in place of the command's output; never echoes the command text. */
  readonly message: string;
}

/** The managed intent an inspection id names, or null when it is not one. */
export function managedIntentOf(inspection: string): ManagedIntentKind | null {
  if (!inspection.startsWith(MANAGED_INTENT_INSPECTION_PREFIX)) return null;
  const kind = inspection.slice(MANAGED_INTENT_INSPECTION_PREFIX.length);
  return (MANAGED_INTENT_KINDS as readonly string[]).includes(kind) ? (kind as ManagedIntentKind) : null;
}

/**
 * Where a managed command goes. Watch opens without a range, so the Watch prompt asks for it:
 * the inspection carries no trusted arguments and the renderer does not parse command text.
 */
export function managedIntentRoute(inspection: string, datasourceId: string): ManagedIntentRoute | null {
  const kind = managedIntentOf(inspection);
  if (kind === null) return null;
  switch (kind) {
    case "watch":
      return {
        kind,
        actionId: WATCH_ACTION_IDS.start,
        capability: "watch",
        args: { datasourceId },
        message: "Watch runs in the Watch tool window. Choose the key or prefix there.",
      };
    case "credentials":
      return {
        kind,
        actionId: ADMIN_ACTION_IDS.access,
        capability: "access",
        args: { datasourceId },
        message:
          "Passwords are never accepted in the console. Use New User or Change Password in Users & Roles; the command was not recorded.",
      };
    case "access":
      return {
        kind,
        actionId: ADMIN_ACTION_IDS.access,
        capability: "access",
        args: { datasourceId },
        message: "Access changes are cluster-global. Review and confirm them in Users & Roles.",
      };
    case "leaseGrant":
      return {
        kind,
        actionId: ADMIN_ACTION_IDS.leases,
        capability: "leases",
        args: { datasourceId },
        message: "Grant leases in the Leases manager, where you set the TTL.",
      };
    case "keepAlive":
    case "leaseRevoke":
      return {
        kind,
        actionId: ADMIN_ACTION_IDS.leases,
        capability: "leases",
        args: { datasourceId },
        message:
          kind === "keepAlive"
            ? "Keeping a lease alive runs in the Leases manager, where you can stop it."
            : "Revoking a lease deletes every attached key in the cluster. Review and confirm it in Leases.",
      };
    case "cluster":
      return {
        kind,
        actionId: ADMIN_ACTION_IDS.cluster,
        capability: "members",
        args: { datasourceId, view: "members" },
        message: "Membership changes are cluster-global. Review quorum and confirm them in Server.",
      };
    case "snapshot":
    case "admin":
      return {
        kind,
        actionId: ADMIN_ACTION_IDS.cluster,
        capability: "maintenance",
        args: { datasourceId, view: "maintenance" },
        message: "This maintenance operation is cluster-global. Review and confirm it in Server › Maintenance.",
      };
  }
}

const TARGETS: readonly AnyAction[] = [...ADMIN_ACTIONS, ...WATCH_ACTIONS];

export const CONSOLE_INTENT_ACTIONS: readonly AnyAction[] = [
  defineAction<ManagedIntentArgs | undefined>({
    id: MANAGED_INTENT_ACTION_ID,
    title: "Open Manager for Console Command",
    category: "Console",
    run: async (context, args) => {
      if (args === undefined) return;
      const route = managedIntentRoute(args.inspection, args.datasourceId);
      const state = useDatasources.getState();
      const datasource = datasourceById(state, args.datasourceId);
      if (route === null || datasource === undefined) return;
      const target = TARGETS.find((action) => action.id === route.actionId);
      if (target === undefined || !capabilitiesOf(state.plugins, datasource.pluginId).includes(route.capability)) {
        await useModal.getState().ask({
          kind: "notice",
          title: "This command needs a manager",
          message: route.message,
          hint: "This data source does not offer that manager. Nothing ran.",
        });
        return;
      }
      await target.run(context, route.args as never);
    },
  }),
];
