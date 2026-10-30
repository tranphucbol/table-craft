import type { KeyRange, KeyWatchRequest } from "@table-craft/desktop/engine/protocol.js";
import { defineAction, type AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import { useModal } from "@table-craft/desktop/renderer/state/modal.js";
import { useLayout } from "@table-craft/desktop/renderer/state/layout.js";
import { useSettings } from "@table-craft/desktop/renderer/state/settings.js";
import { capabilitiesOf, datasourceById, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { adminHost } from "@table-craft/desktop/renderer/keyAdmin/host.js";
import { exportRunning, useWatch } from "./store.js";

export const WATCH_ACTION_IDS = {
  toggle: "window.watch",
  start: "watch.start",
  command: "watch.command",
  pause: "watch.pause",
} as const;
export interface WatchStartArgs {
  readonly datasourceId?: string;
  readonly database?: number;
  readonly range?: KeyRange;
  readonly from?: KeyWatchRequest["from"];
}
export interface WatchCommandArgs {
  readonly id: string;
  readonly kind: "select" | "pause" | "clear" | "stop" | "close" | "export" | "exportCancel" | "poll";
}
export const WATCH_ACTIONS: readonly AnyAction[] = [
  defineAction({
    id: WATCH_ACTION_IDS.toggle,
    title: "Watch",
    category: "Tool Windows",
    icon: "services",
    shortcut: "Mod+6",
    run: () => useLayout.getState().toggle("watch"),
  }),
  defineAction<WatchStartArgs | undefined>({
    id: WATCH_ACTION_IDS.start,
    title: "Watch Key or Prefix…",
    category: "Database",
    icon: "services",
    shortcut: "Mod+Alt+W",
    available: (context) => context.datasource?.capabilities.includes("watch") === true,
    run: async (context, args) => {
      const source = args?.datasourceId ?? context.datasource?.view.id;
      if (source === undefined) return;
      const datasource = datasourceById(useDatasources.getState(), source);
      if (
        datasource === undefined ||
        !capabilitiesOf(useDatasources.getState().plugins, datasource.pluginId).includes("watch")
      )
        return;
      let range = args?.range;
      if (range === undefined && context.keyTab !== null) range = { kind: "key", key: context.keyTab.key };
      if (range === undefined) {
        const prefix = await useModal.getState().ask({
          kind: "text",
          title: "Watch Prefix",
          label: "Namespace-relative prefix (empty watches all keys)",
          initial: "",
          confirm: "Continue",
        });
        if (prefix === null) return;
        range = { kind: "prefix", prefix: { text: prefix, hex: null } };
      }
      let from = args?.from;
      if (from === undefined) {
        const revision = await useModal.getState().ask({
          kind: "text",
          title: "Watch From",
          label: "Revision, or leave empty to start now",
          initial: "",
          confirm: "Start Watch",
        });
        if (revision === null) return;
        if (revision !== "" && !/^[1-9]\d{0,19}$/.test(revision))
          throw new Error("Enter a positive revision, or leave empty for Now.");
        from = revision === "" ? { kind: "now" } : { kind: "revision", revision };
      }
      await useWatch
        .getState()
        .start(
          source,
          { database: args?.database ?? context.keyTab?.database ?? 0, range, from },
          useSettings.getState().settings.data.watchRetention,
        );
      useLayout.getState().show("watch");
    },
  }),
  defineAction<WatchCommandArgs | undefined>({
    id: WATCH_ACTION_IDS.command,
    title: "Manage Watch",
    category: "Database",
    run: async (_context, args) => {
      if (args === undefined) return;
      const store = useWatch.getState();
      const entry = store.entries[args.id];
      if (entry === undefined) return;
      if (args.kind === "select") {
        store.select(args.id);
        useLayout.getState().show("watch");
      } else if (args.kind === "pause") store.pause(args.id);
      else if (args.kind === "clear") await store.clear(args.id);
      else if (args.kind === "poll") await store.poll(args.id);
      else if (args.kind === "export") {
        if (exportRunning(store.exports[args.id])) return;
        try {
          const grant = await adminHost().chooseFile(entry.datasourceId, "watch.export");
          if (grant !== null) await store.exportStart(args.id, grant);
        } catch (cause) {
          await useModal.getState().ask({
            kind: "notice",
            title: "Watch export did not start",
            message: cause instanceof Error ? cause.message : "The export could not be started.",
            hint: "No file was written. Live watching continues.",
          });
        }
      } else if (args.kind === "exportCancel") await store.exportCancel(args.id);
      else await store.stop(args.id, args.kind === "close");
    },
  }),
  defineAction({
    id: WATCH_ACTION_IDS.pause,
    title: "Pause or Resume Watch",
    category: "Database",
    shortcut: "Space",
    shortcutRegion: "watch",
    when: (context) => context.focus === "watch" && useWatch.getState().activeId !== null,
    run: () => {
      const store = useWatch.getState();
      if (store.activeId !== null) store.pause(store.activeId);
    },
  }),
];
