/**
 * The plugin store wired to Electron (decision 110): `net` honours the system proxy as the
 * app updater does, the dialogs are native, and the background update rides the updater's 2-hour
 * schedule.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BrowserWindow, dialog, type OpenDialogOptions, type WebContents } from "electron";
import {
  confirmationText,
  createPluginChannels,
  privateConfirmationText,
} from "@table-craft/desktop/main/pluginStore/channels.js";
import type { PrivateInstallRequest } from "@table-craft/desktop/main/pluginStore/installer.js";
import { MANAGED_PLUGINS_DIRECTORY } from "@table-craft/desktop/main/pluginStore/managed.js";
import { netFetch } from "@table-craft/desktop/main/pluginStore/netFetch.js";
import { createPluginService, type PluginService } from "@table-craft/desktop/main/pluginStore/service.js";
import type { PluginChannels } from "@table-craft/desktop/main/ipc.js";
import { CHECK_INTERVAL_MS } from "@table-craft/desktop/main/update/overrides.js";
import { createUpdateSchedule, type UpdateSchedule } from "@table-craft/desktop/main/update/schedule.js";
import type { SecretStore } from "@table-craft/desktop/main/secrets.js";
import type { ReleaseChannel } from "@table-craft/desktop/settings/channel.js";
import type { PluginRegistry } from "@table-craft/desktop/settings/settings.js";
import type { Logger } from "@table-craft/desktop/log/record.js";
import type { PluginsState } from "@table-craft/desktop/preload/bridge.js";

/** `0` leaves the development optional plugins out, so a test sees what a packaged app sees (decision 108). */
export const DEVELOPMENT_PLUGINS_ENV = "TABLE_CRAFT_DEVELOPMENT_PLUGINS";

/** Milliseconds to the first background plugin check in a development run; unset, a development run never checks. */
export const PLUGIN_CHECK_ENV = "TABLE_CRAFT_PLUGIN_CHECK_MS";
const USER_PLUGINS_DIRECTORY = "plugins";
/** After the app's own first check, so the two never race for the network at launch. */
const FIRST_PLUGIN_CHECK_MS = 60_000;
const INSTALL_BUTTON = 0;
const PLUGIN_FILE_FILTERS = [{ name: "Plugin package", extensions: ["tgz"] }];
const FILE_DIALOG_TITLE = "Install Plugin from File";
const REGISTRY_DIALOG_TITLE = "Install Plugin from Registry";

export interface PluginStoreOptions {
  readonly userData: string;
  readonly builtInRoot: string;
  /** `dist/optional-plugins` in a development run; null when packaged. */
  readonly developmentRoot: string | null;
  readonly packaged: boolean;
  readonly environment: NodeJS.ProcessEnv;
  readonly registryUrl: () => string;
  /** The app's update channel; plugins follow it. */
  readonly channel: () => ReleaseChannel;
  readonly checkAutomatically: () => boolean;
  readonly registries: () => readonly PluginRegistry[];
  /** Where each private registry's token is kept (decision 158). */
  readonly secrets: Pick<SecretStore, "registryToken" | "setRegistryToken" | "clearRegistryToken">;
  /** Adds a package installed by name to its registry's `packages` in settings. */
  readonly addPackage: (registryId: string, packageName: string) => Promise<void>;
  /** The saved data sources, read when a plugin is removed or found missing. */
  readonly datasources: () => readonly { readonly pluginId: string; readonly name: string }[];
  readonly onChanged: (state: PluginsState) => void;
  readonly log: Logger;
}

export interface PluginStore {
  readonly service: PluginService;
  readonly channels: PluginChannels<WebContents>;
  /** Prunes and discovers, logging each plugin; before any engine starts. */
  start(): Promise<void>;
  /**
   * Right after `start`, whatever `checkAutomatically` says: downloads plugins saved data sources
   * miss and updates outdated ones, so a launch after an app update installs them before a data
   * source is opened (decision 155); then starts the 2-hour check.
   */
  startBackground(): void;
  setAutomatic(enabled: boolean): void;
  stop(): void;
}

function parentOf(contents: WebContents): BrowserWindow | null {
  return BrowserWindow.fromWebContents(contents);
}

async function choosePackage(contents: WebContents): Promise<string | null> {
  const parent = parentOf(contents);
  const options: OpenDialogOptions = {
    title: FILE_DIALOG_TITLE,
    properties: ["openFile"],
    filters: PLUGIN_FILE_FILTERS,
  };
  const picked = parent === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(parent, options);
  return picked.canceled ? null : (picked.filePaths[0] ?? null);
}

export function createPluginStore(options: PluginStoreOptions): PluginStore {
  const log = options.log;
  const usedBy = (pluginId: string) =>
    options
      .datasources()
      .filter((datasource) => datasource.pluginId === pluginId)
      .map((datasource) => datasource.name);
  const developmentRoots =
    options.developmentRoot !== null && options.environment[DEVELOPMENT_PLUGINS_ENV] !== "0"
      ? [options.developmentRoot]
      : [];
  async function confirmPrivate(request: PrivateInstallRequest): Promise<boolean> {
    const parent = BrowserWindow.getFocusedWindow();
    const box = {
      type: "warning" as const,
      title: REGISTRY_DIALOG_TITLE,
      buttons: ["Install", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      ...privateConfirmationText(request),
    };
    const answer = parent === null ? await dialog.showMessageBox(box) : await dialog.showMessageBox(parent, box);
    return answer.response === INSTALL_BUTTON;
  }
  const service = createPluginService({
    builtInRoot: options.builtInRoot,
    developmentRoots,
    managedRoot: join(options.userData, MANAGED_PLUGINS_DIRECTORY),
    userRoot: join(options.userData, USER_PLUGINS_DIRECTORY),
    registryUrl: options.registryUrl,
    channel: options.channel,
    fetch: netFetch,
    registries: options.registries,
    registryToken: (registryId) => options.secrets.registryToken(registryId),
    storeToken: (registryId, token) =>
      token === null
        ? options.secrets.clearRegistryToken(registryId)
        : options.secrets.setRegistryToken(registryId, token),
    confirm: confirmPrivate,
    addPackage: options.addPackage,
    usedBy,
    onChanged: options.onChanged,
    log,
  });
  const channels = createPluginChannels<WebContents>({
    service,
    choose: choosePackage,
    readFile: (path) => readFile(path),
    async confirm(contents, choice) {
      const parent = parentOf(contents);
      const box = {
        type: "warning" as const,
        title: FILE_DIALOG_TITLE,
        buttons: ["Install", "Cancel"],
        defaultId: 1,
        cancelId: 1,
        ...confirmationText(choice),
      };
      const answer = parent === null ? await dialog.showMessageBox(box) : await dialog.showMessageBox(parent, box);
      return answer.response === INSTALL_BUTTON;
    },
  });
  const testDelay = Number(options.environment[PLUGIN_CHECK_ENV]);
  const overridden =
    Number.isFinite(testDelay) && testDelay >= 0 && options.environment[PLUGIN_CHECK_ENV] !== undefined;
  const allowed = options.packaged || overridden;
  let schedule: UpdateSchedule | null = null;
  let started = false;
  return {
    service,
    channels,
    async start() {
      for (const plugin of await service.start()) {
        if (plugin.status === "available") log.info("plugin found", { ...plugin });
        else log.warn("plugin unavailable", { ...plugin });
      }
    },
    startBackground() {
      if (started) return;
      started = true;
      void service.installMissing(options.datasources().map((datasource) => datasource.pluginId));
      schedule = createUpdateSchedule({
        check: () => void service.updateAll(),
        enabled: allowed && options.checkAutomatically(),
        firstDelayMs: overridden ? testDelay : FIRST_PLUGIN_CHECK_MS,
        intervalMs: CHECK_INTERVAL_MS,
        timers: {
          setTimeout: (run, ms) => setTimeout(run, ms),
          clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout),
          setInterval: (run, ms) => setInterval(run, ms),
          clearInterval: (timer) => clearInterval(timer as NodeJS.Timeout),
        },
      });
      schedule.start();
    },
    setAutomatic: (enabled) => schedule?.setEnabled(allowed && enabled),
    stop: () => schedule?.stop(),
  };
}
