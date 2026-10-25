import { defineAction, type AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import { bridge } from "@table-craft/desktop/renderer/bridge.js";
import { pluginOf, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useModal } from "@table-craft/desktop/renderer/state/modal.js";
import { useSettingsDialog } from "@table-craft/desktop/renderer/state/settingsDialog.js";

export const PLUGIN_ACTION_IDS = {
  show: "plugins.show",
  install: "plugins.install",
  installFile: "plugins.installFile",
  remove: "plugins.remove",
} as const;

export interface PluginArgs {
  readonly pluginId: string;
}

function isPluginArgs(args: unknown): args is PluginArgs {
  return typeof args === "object" && args !== null && typeof (args as { pluginId?: unknown }).pluginId === "string";
}

function nameOf(pluginId: string): string {
  const state = useDatasources.getState();
  return (
    pluginOf(state.plugins, pluginId)?.name ?? state.catalog.find((entry) => entry.id === pluginId)?.name ?? pluginId
  );
}

async function notice(title: string, message: string, hint: string, tone?: "info"): Promise<void> {
  await useModal.getState().ask({ kind: "notice", title, message, hint, ...(tone === undefined ? {} : { tone }) });
}

function showPlugins(): void {
  useSettingsDialog.getState().show("plugins");
}

/** Downloads a catalog plugin; its progress and any failure show where it was asked for. */
async function install(pluginId: string): Promise<void> {
  const answer = await bridge().installPlugin(pluginId);
  if (answer.ok) return;
  const entry = useDatasources.getState().catalog.find((candidate) => candidate.id === pluginId);
  if (entry?.install.status !== "failed") {
    await notice(`Could not install ${nameOf(pluginId)}`, answer.error.message, answer.error.hint);
  }
}

async function installFile(): Promise<void> {
  const answer = await bridge().installPluginFile();
  if (!answer.ok) {
    await notice("Could not install the plugin", answer.error.message, answer.error.hint);
    return;
  }
  if (answer.value.status === "cancelled") return;
  const { pluginId, version } = answer.value;
  await notice(
    "Plugin installed",
    `${nameOf(pluginId)} ${version} is installed.`,
    "New Data Source lists it now; TableCraft does not update a plugin installed from a file.",
    "info",
  );
}

async function remove(pluginId: string): Promise<void> {
  const name = nameOf(pluginId);
  const confirmed = await useModal.getState().ask({
    kind: "confirm",
    title: "Remove Plugin",
    message: `Remove ${name}? You can download it again from Settings → Plugins.`,
    confirm: "Remove",
    destructive: true,
  });
  if (confirmed === null) return;
  const answer = await bridge().removePlugin(pluginId);
  if (!answer.ok) await notice(`Could not remove ${name}`, answer.error.message, answer.error.hint);
}

/** Settings → Plugins and the downloads it starts (decision 110); main decides, these only ask. */
export const PLUGIN_ACTIONS: readonly AnyAction[] = [
  defineAction({
    id: PLUGIN_ACTION_IDS.show,
    title: "Plugins…",
    category: "App",
    icon: "settings",
    run: showPlugins,
  }),
  defineAction<PluginArgs | undefined>({
    id: PLUGIN_ACTION_IDS.install,
    title: "Install Plugin",
    category: "App",
    icon: "download",
    run: (_context, args) => (isPluginArgs(args) ? install(args.pluginId) : showPlugins()),
  }),
  defineAction({
    id: PLUGIN_ACTION_IDS.installFile,
    title: "Install Plugin from File…",
    category: "App",
    icon: "download",
    run: installFile,
  }),
  defineAction<PluginArgs | undefined>({
    id: PLUGIN_ACTION_IDS.remove,
    title: "Remove Plugin",
    category: "App",
    icon: "delete",
    run: (_context, args) => (isPluginArgs(args) ? remove(args.pluginId) : showPlugins()),
  }),
];
