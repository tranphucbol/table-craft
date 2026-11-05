import type { RegistryTestRequest, RemovablePluginSource } from "@table-craft/desktop/preload/bridge.js";
import { defineAction, type AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import { bridge } from "@table-craft/desktop/renderer/bridge.js";
import { pluginOf, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useModal } from "@table-craft/desktop/renderer/state/modal.js";
import { useRegistryTests } from "@table-craft/desktop/renderer/state/registryTests.js";
import { useSettings } from "@table-craft/desktop/renderer/state/settings.js";
import { useSettingsDialog } from "@table-craft/desktop/renderer/state/settingsDialog.js";
import {
  isScopedPackageName,
  registryEntryError,
  type PluginRegistry,
} from "@table-craft/desktop/settings/settings.js";

export const PLUGIN_ACTION_IDS = {
  show: "plugins.show",
  install: "plugins.install",
  installFile: "plugins.installFile",
  remove: "plugins.remove",
  installPackage: "plugins.installPackage",
  saveRegistry: "plugins.registry.save",
  removeRegistry: "plugins.registry.remove",
  testRegistry: "plugins.registry.test",
  setRegistryToken: "plugins.registryToken.set",
  clearRegistryToken: "plugins.registryToken.clear",
} as const;

export interface PluginArgs {
  readonly pluginId: string;
}

/** Remove's arguments; `user` takes the folder of your own plugin rather than the downloaded copy. */
export interface PluginRemoveArgs extends PluginArgs {
  readonly source?: RemovablePluginSource;
}

export interface PackageArgs {
  readonly packageName: string;
}

/** A registry to add, or to replace the one with its id; `token` null keeps the stored one. */
export interface RegistrySaveArgs {
  readonly registry: PluginRegistry;
  readonly token: string | null;
}

export interface RegistryArgs {
  readonly registryId: string;
}

export interface RegistryTestArgs {
  /** The registry's id for its card, `REGISTRY_FORM_KEY` for the form. */
  readonly key: string;
  readonly request: RegistryTestRequest;
}

export interface RegistryTokenArgs {
  readonly registryId: string;
  readonly token: string;
}

function hasString<K extends string>(args: unknown, key: K): args is Record<K, string> {
  return typeof args === "object" && args !== null && typeof (args as Record<K, unknown>)[key] === "string";
}

function isPluginArgs(args: unknown): args is PluginArgs {
  return hasString(args, "pluginId");
}

function sourceOf(args: PluginArgs): RemovablePluginSource {
  return (args as PluginRemoveArgs).source === "user" ? "user" : "managed";
}

function isRegistrySaveArgs(args: unknown): args is RegistrySaveArgs {
  return typeof args === "object" && args !== null && "registry" in args && "token" in args;
}

function isRegistryTestArgs(args: unknown): args is RegistryTestArgs {
  return hasString(args, "key") && "request" in args;
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

/**
 * Downloads a catalog plugin; its progress and any failure show where it was asked for, so only a
 * plugin outside the catalog gets a notice. The answer can arrive before the failed state's
 * broadcast, so the catalog's state cannot tell whether the failure is already on screen.
 */
async function install(pluginId: string): Promise<void> {
  const answer = await bridge().installPlugin(pluginId);
  if (answer.ok) return;
  if (!useDatasources.getState().catalog.some((candidate) => candidate.id === pluginId)) {
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

async function remove(pluginId: string, source: RemovablePluginSource): Promise<void> {
  const name = nameOf(pluginId);
  const confirmed = await useModal.getState().ask({
    kind: "confirm",
    title: "Remove Plugin",
    message:
      source === "user"
        ? `Remove ${name}? Its folder in your plugins folder moves to the Trash.`
        : `Remove ${name}? You can download it again from Settings → Plugins.`,
    confirm: "Remove",
    destructive: true,
  });
  if (confirmed === null) return;
  const answer = await bridge().removePlugin(pluginId, source);
  if (!answer.ok) await notice(`Could not remove ${name}`, answer.error.message, answer.error.hint);
}

/**
 * Installs a package typed into Settings → Plugins from the registry its scope routes to (plan
 * 154). Its progress and any failure show on the page, as a download row's do.
 */
async function installPackage(packageName: string): Promise<void> {
  if (!isScopedPackageName(packageName)) return;
  await bridge().installPluginPackage(packageName);
}

function registriesOf(): readonly PluginRegistry[] {
  return useSettings.getState().settings.plugins.registries;
}

function registryName(registryId: string): string {
  return registriesOf().find((registry) => registry.id === registryId)?.name ?? registryId;
}

async function saveRegistry({ registry, token }: RegistrySaveArgs): Promise<void> {
  const others = registriesOf().filter((other) => other.id !== registry.id);
  const entry: PluginRegistry = {
    ...registry,
    packages: registry.packages.filter((name) => registry.scopes.some((scope) => name.startsWith(`${scope}/`))),
  };
  const error = registryEntryError(entry, others);
  if (error !== null) {
    await notice("Could not save the registry", error, "Correct it in Settings → Plugins.");
    return;
  }
  await useSettings.getState().update((current) => {
    const existing = current.plugins.registries.some((other) => other.id === entry.id);
    const registries = existing
      ? current.plugins.registries.map((other) => (other.id === entry.id ? entry : other))
      : [...current.plugins.registries, entry];
    return { ...current, plugins: { ...current.plugins, registries } };
  });
  if (token !== null && registriesOf().some((saved) => saved.id === entry.id)) {
    await setRegistryToken({ registryId: entry.id, token });
  }
}

async function removeRegistry(registryId: string): Promise<void> {
  const name = registryName(registryId);
  const confirmed = await useModal.getState().ask({
    kind: "confirm",
    title: "Remove Registry",
    message: `Remove ${name}? Plugins installed from it stay installed but stop updating, and its token is forgotten.`,
    confirm: "Remove",
    destructive: true,
  });
  if (confirmed === null) return;
  useRegistryTests.getState().forget(registryId);
  await useSettings.getState().update((current) => ({
    ...current,
    plugins: {
      ...current.plugins,
      registries: current.plugins.registries.filter((registry) => registry.id !== registryId),
    },
  }));
}

async function testRegistry({ key, request }: RegistryTestArgs): Promise<void> {
  const tests = useRegistryTests.getState();
  tests.start(key);
  const answer = await bridge().testPluginRegistry(request);
  tests.finish(key, answer.ok ? answer.value : { status: "failed", at: Date.now(), message: answer.error.message });
}

async function setRegistryToken({ registryId, token }: RegistryTokenArgs): Promise<void> {
  const answer = await bridge().setRegistryToken(registryId, token);
  if (!answer.ok)
    await notice(`Could not save the token of ${registryName(registryId)}`, answer.error.message, answer.error.hint);
}

async function clearRegistryToken(registryId: string): Promise<void> {
  const answer = await bridge().clearRegistryToken(registryId);
  if (!answer.ok)
    await notice(`Could not forget the token of ${registryName(registryId)}`, answer.error.message, answer.error.hint);
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
  defineAction<PluginRemoveArgs | undefined>({
    id: PLUGIN_ACTION_IDS.remove,
    title: "Remove Plugin",
    category: "App",
    icon: "delete",
    run: (_context, args) => (isPluginArgs(args) ? remove(args.pluginId, sourceOf(args)) : showPlugins()),
  }),
  defineAction<PackageArgs | undefined>({
    id: PLUGIN_ACTION_IDS.installPackage,
    title: "Install Plugin by Package Name",
    category: "App",
    icon: "download",
    run: (_context, args) => (hasString(args, "packageName") ? installPackage(args.packageName) : showPlugins()),
  }),
  defineAction<RegistrySaveArgs | undefined>({
    id: PLUGIN_ACTION_IDS.saveRegistry,
    title: "Save Plugin Registry",
    category: "App",
    icon: "settings",
    run: (_context, args) => (isRegistrySaveArgs(args) ? saveRegistry(args) : showPlugins()),
  }),
  defineAction<RegistryArgs | undefined>({
    id: PLUGIN_ACTION_IDS.removeRegistry,
    title: "Remove Plugin Registry",
    category: "App",
    icon: "delete",
    run: (_context, args) => (hasString(args, "registryId") ? removeRegistry(args.registryId) : showPlugins()),
  }),
  defineAction<RegistryTestArgs | undefined>({
    id: PLUGIN_ACTION_IDS.testRegistry,
    title: "Test Plugin Registry",
    category: "App",
    icon: "settings",
    run: (_context, args) => (isRegistryTestArgs(args) ? testRegistry(args) : showPlugins()),
  }),
  defineAction<RegistryTokenArgs | undefined>({
    id: PLUGIN_ACTION_IDS.setRegistryToken,
    title: "Replace Plugin Registry Token",
    category: "App",
    icon: "settings",
    run: (_context, args) =>
      hasString(args, "registryId") && hasString(args, "token") ? setRegistryToken(args) : showPlugins(),
  }),
  defineAction<RegistryArgs | undefined>({
    id: PLUGIN_ACTION_IDS.clearRegistryToken,
    title: "Forget Plugin Registry Token",
    category: "App",
    icon: "delete",
    run: (_context, args) => (hasString(args, "registryId") ? clearRegistryToken(args.registryId) : showPlugins()),
  }),
];
