/**
 * The `plugins.*` channels over the plugin service. Electron's dialogs arrive as options, so the
 * Install from File flow and its trust confirmation (decision 006) are tested without a window.
 */
import { OFFICIAL_SCOPE } from "@table-craft/desktop/main/pluginStore/catalog.js";
import { inspectPackage, type PackageJson } from "@table-craft/desktop/main/pluginStore/installer.js";
import type { PluginService } from "@table-craft/desktop/main/pluginStore/service.js";
import type { PluginChannels } from "@table-craft/desktop/main/ipc.js";
import type { InstallFileResult } from "@table-craft/desktop/preload/bridge.js";

export interface PluginFileChoice {
  readonly name: string;
  readonly version: string;
  readonly pluginId: string;
  /** Published under `@table-craft/`; the confirmation still asks, as for any file. */
  readonly official: boolean;
}

export interface PluginChannelOptions<Sender> {
  readonly service: PluginService;
  /** The native open dialog for one `.tgz`; null when cancelled. */
  readonly choose: (sender: Sender) => Promise<string | null>;
  readonly readFile: (path: string) => Promise<Uint8Array>;
  /** The native confirmation naming the package; true to install. */
  readonly confirm: (sender: Sender, choice: PluginFileChoice) => Promise<boolean>;
}

const CANCELLED: InstallFileResult = { status: "cancelled" };

function choiceOf(meta: PackageJson): PluginFileChoice {
  return { name: meta.name, version: meta.version, pluginId: meta.id, official: meta.name.startsWith(OFFICIAL_SCOPE) };
}

export function createPluginChannels<Sender>(options: PluginChannelOptions<Sender>): PluginChannels<Sender> {
  const { service } = options;
  return {
    state: () => service.state(),
    async install(pluginId) {
      await service.install(pluginId);
      return service.state();
    },
    async installFile(sender) {
      const path = await options.choose(sender);
      if (path === null) return CANCELLED;
      const bytes = await options.readFile(path);
      const choice = choiceOf(inspectPackage(bytes));
      if (!(await options.confirm(sender, choice))) return CANCELLED;
      const outcome = await service.installFile(bytes);
      return { status: "installed", pluginId: outcome.id, version: outcome.version };
    },
    async remove(pluginId) {
      await service.remove(pluginId);
      return service.state();
    },
  };
}

/** The confirmation's text (decision 006): a plugin runs with the app's access, so only trusted ones go in. */
export function confirmationText(choice: PluginFileChoice): { message: string; detail: string } {
  return {
    message: `Install the plugin ${choice.name} ${choice.version}?`,
    detail:
      "A plugin runs inside TableCraft with the same access to your files, network and saved connections as the app. " +
      (choice.official
        ? "This package is named as an official TableCraft plugin, but it came from a file, so TableCraft cannot check where it was made. "
        : "It is not an official TableCraft plugin. ") +
      "Install it only if you trust where it came from.",
  };
}
