import type { QueryHistory } from "@table-craft/core";
import { ConnectionUrlError, formatConnectionUrl, parseConnectionUrl } from "@table-craft/plugin-api";
import type { ConsoleFiles } from "@table-craft/desktop/main/consoleFiles.js";
import type { DatasourceConfig, ProbeResult } from "@table-craft/desktop/engine/protocol.js";
import { toDatasource, type DatasourceStore } from "@table-craft/desktop/main/datasources.js";
import type { HostRegistry } from "@table-craft/desktop/main/hosts.js";
import type { SecretStore } from "@table-craft/desktop/main/secrets.js";
import type {
  ConfigValue,
  ConnectionField,
  ConnectResult,
  Datasource,
  DatasourceDraft,
  DatasourceList,
  DatasourceView,
  ParsedUrl,
  PluginInfo,
  SaveDatasourceRequest,
  SecretMode,
} from "@table-craft/desktop/preload/bridge.js";
import { DEFAULT_KEEPALIVE_SECONDS } from "@table-craft/desktop/settings/settings.js";

/** A failure the user can act on; ipc hands its message and hint to the renderer as they are. */
export class DatasourceError extends Error {
  override readonly name = "DatasourceError";
  constructor(
    message: string,
    readonly hint: string,
  ) {
    super(message);
  }
}

/** The `TABLE_CRAFT_DATASOURCE` seam (decision 018, amended): listed, never written to disk. */
export interface EphemeralDatasource {
  readonly id: string;
  readonly pluginId: string;
  readonly config: unknown;
}

export interface DatasourceServiceOptions<Target> {
  readonly store: DatasourceStore;
  readonly secrets: SecretStore;
  readonly hosts: HostRegistry<Target>;
  readonly plugins: readonly PluginInfo[];
  readonly ephemeral: EphemeralDatasource | null;
  readonly newId: () => string;
  /** Deleting a datasource deletes its saved consoles (plan 006, decision 18). */
  readonly consoles: Pick<ConsoleFiles, "deleteAll">;
  /** Deleting a datasource clears its query history (plan 011, decision 5). */
  readonly history: Pick<QueryHistory, "clear">;
  /** Called after every change, with the list every window should now show. */
  readonly onChanged: (list: DatasourceList) => void;
}

export interface DatasourceService<Target> {
  list(): DatasourceList;
  plugins(): readonly PluginInfo[];
  save(request: SaveDatasourceRequest): Promise<DatasourceView>;
  /** Adds imported datasources in one write (plan 035); secret values go straight to the store. */
  importMany(items: readonly ImportedDatasource[]): Promise<string[]>;
  delete(id: string): Promise<void>;
  test(request: SaveDatasourceRequest): Promise<ProbeResult>;
  /** Reads a pasted URL for the plugin's form; the password comes back only to fill the field it was pasted for. */
  parseUrl(pluginId: string, url: string): ParsedUrl;
  /** The saved data source's connection URL, without secrets. */
  url(id: string): string;
  connect(datasourceId: string, typed: Readonly<Record<string, string>>, target: Target): Promise<ConnectResult>;
  disconnect(datasourceId: string): Promise<void>;
}

export interface ImportedDatasource {
  readonly draft: DatasourceDraft;
  /** Secret values by field key; each is kept in the field's default mode. */
  readonly secrets: Readonly<Record<string, string>>;
}

const DRAFT_ID = "draft";

function secretFields(plugin: PluginInfo | undefined): ConnectionField[] {
  return (plugin?.fields ?? []).filter((field) => field.secret === true);
}

function isConfigValue(value: unknown): value is ConfigValue {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function ephemeralRecord(ephemeral: EphemeralDatasource, plugin: PluginInfo | undefined): Datasource {
  const raw = (typeof ephemeral.config === "object" && ephemeral.config !== null ? ephemeral.config : {}) as Record<
    string,
    unknown
  >;
  const secrets = new Set(secretFields(plugin).map((field) => field.key));
  const config: Record<string, ConfigValue> = {};
  for (const field of plugin?.fields ?? []) {
    const value = raw[field.key];
    if (!secrets.has(field.key) && isConfigValue(value)) config[field.key] = value;
  }
  const secretModes: Record<string, SecretMode> = {};
  for (const key of secrets) secretModes[key] = "untilRestart";
  return {
    id: ephemeral.id,
    name: ephemeral.id,
    pluginId: ephemeral.pluginId,
    folder: null,
    color: null,
    readOnly: false,
    comment: "",
    config,
    secretModes,
  };
}

/**
 * Owns the datasource list and its secrets on main's side of the IPC fence (plan 004). Secret
 * values come in from the renderer when typed and leave only towards an engine.
 */
export async function createDatasourceService<Target>(
  options: DatasourceServiceOptions<Target>,
): Promise<DatasourceService<Target>> {
  const { store, secrets, hosts } = options;
  const loaded = await store.load();
  let datasources: Datasource[] = [...loaded.datasources];
  let warning = loaded.warning;
  const pluginOf = (pluginId: string) => options.plugins.find((plugin) => plugin.id === pluginId);
  const ephemeral =
    options.ephemeral === null ? null : ephemeralRecord(options.ephemeral, pluginOf(options.ephemeral.pluginId));

  function defaultMode(): SecretMode {
    return secrets.encryption().available ? "forever" : "untilRestart";
  }

  function view(datasource: Datasource, isEphemeral: boolean): DatasourceView {
    const storedSecrets = Object.entries(datasource.secretModes)
      .filter(([key, mode]) => secrets.get(datasource.id, key, mode) !== undefined)
      .map(([key]) => key);
    return { ...datasource, storedSecrets, ephemeral: isEphemeral };
  }

  function list(): DatasourceList {
    const views = datasources.map((datasource) => view(datasource, false));
    return {
      datasources: ephemeral === null ? views : [view(ephemeral, true), ...views],
      warning,
      encryption: secrets.encryption(),
    };
  }

  function changed(): void {
    options.onChanged(list());
    // The warning is shown once, by whichever window reads it first.
    warning = null;
  }

  function find(id: string): Datasource {
    const found = ephemeral?.id === id ? ephemeral : datasources.find((datasource) => datasource.id === id);
    if (found === undefined) {
      throw new DatasourceError(`No data source with id "${id}".`, "It may have been deleted; pick another one.");
    }
    return found;
  }

  function availablePlugin(pluginId: string): PluginInfo {
    const plugin = pluginOf(pluginId);
    if (plugin === undefined) {
      throw new DatasourceError(`No plugin "${pluginId}" is installed.`, "Install the plugin, or pick another type.");
    }
    if (plugin.unavailableReason !== null) {
      throw new DatasourceError(
        `${plugin.name} is unavailable: ${plugin.unavailableReason}`,
        "Fix the plugin and restart.",
      );
    }
    return plugin;
  }

  function checkRequired(plugin: PluginInfo, config: Readonly<Record<string, ConfigValue>>): void {
    for (const field of plugin.fields) {
      if (field.secret === true || field.required !== true) continue;
      const value = config[field.key];
      if (value === undefined || value === "") {
        throw new DatasourceError(`${field.label} is required.`, `Fill in ${field.label} and save again.`);
      }
    }
  }

  function modesFor(plugin: PluginInfo, requested: Readonly<Record<string, SecretMode>>): Record<string, SecretMode> {
    const modes: Record<string, SecretMode> = {};
    for (const field of secretFields(plugin)) modes[field.key] = requested[field.key] ?? defaultMode();
    return modes;
  }

  async function save(request: SaveDatasourceRequest): Promise<DatasourceView> {
    const draft = request.datasource;
    if (ephemeral !== null && draft.id === ephemeral.id) {
      throw new DatasourceError(
        "This data source comes from TABLE_CRAFT_DATASOURCE and is not saved.",
        "Duplicate it to keep a copy, or unset the variable.",
      );
    }
    const plugin = availablePlugin(draft.pluginId);
    const previous = datasources.find((datasource) => datasource.id === draft.id);
    const id = previous?.id ?? options.newId();
    const modes = modesFor(plugin, draft.secretModes);
    const origin = draft.origin ?? previous?.origin;
    const next = toDatasource({ ...draft, secretModes: modes, origin }, id, plugin.fields);
    checkRequired(plugin, next.config);
    if (Object.values(modes).includes("forever") && !secrets.encryption().available) {
      const { reason } = secrets.encryption();
      throw new DatasourceError(reason ?? "", "Choose Until restart or Never for the secret.");
    }
    for (const [key, mode] of Object.entries(modes)) {
      const change = request.secrets[key] ?? { action: "keep" };
      if (change.action === "set") await secrets.set(id, key, mode, change.value);
      else if (change.action === "clear") await secrets.clear(id, key);
      else if (previous !== undefined) await secrets.changeMode(id, key, previous.secretModes[key] ?? mode, mode);
    }
    datasources = previous === undefined ? [...datasources, next] : datasources.map((d) => (d.id === id ? next : d));
    await store.save(datasources);
    changed();
    return view(next, false);
  }

  async function importMany(items: readonly ImportedDatasource[]): Promise<string[]> {
    const added: Datasource[] = [];
    for (const item of items) {
      const plugin = availablePlugin(item.draft.pluginId);
      const id = options.newId();
      const modes = modesFor(plugin, {});
      const next = toDatasource({ ...item.draft, secretModes: modes }, id, plugin.fields);
      for (const [key, value] of Object.entries(item.secrets)) {
        const mode = modes[key];
        if (mode !== undefined) await secrets.set(id, key, mode, value);
      }
      added.push(next);
    }
    if (added.length === 0) return [];
    datasources = [...datasources, ...added];
    await store.save(datasources);
    changed();
    return added.map((datasource) => datasource.id);
  }

  async function remove(id: string): Promise<void> {
    if (ephemeral?.id === id) {
      throw new DatasourceError(
        "This data source comes from TABLE_CRAFT_DATASOURCE and cannot be deleted.",
        "Unset the variable and restart.",
      );
    }
    find(id);
    await hosts.stop(id);
    await secrets.clearAll(id);
    datasources = datasources.filter((datasource) => datasource.id !== id);
    await store.save(datasources);
    await options.consoles.deleteAll(id);
    options.history.clear(id);
    changed();
  }

  function engineConfig(datasource: Datasource, values: Readonly<Record<string, string>>): DatasourceConfig {
    const keepAliveSeconds = datasource.keepAliveSeconds ?? DEFAULT_KEEPALIVE_SECONDS;
    if (ephemeral !== null && datasource.id === ephemeral.id && options.ephemeral !== null) {
      return {
        id: datasource.id,
        pluginId: datasource.pluginId,
        config: options.ephemeral.config,
        readOnly: false,
        keepAliveSeconds,
      };
    }
    return {
      id: datasource.id,
      pluginId: datasource.pluginId,
      config: { ...datasource.config, ...values },
      readOnly: datasource.readOnly,
      keepAliveSeconds,
    };
  }

  function urlForm(pluginId: string) {
    const plugin = availablePlugin(pluginId);
    if (plugin.url === null) {
      throw new DatasourceError(`${plugin.name} has no connection URL.`, "Fill in the fields instead.");
    }
    return { connection: { fields: plugin.fields, url: plugin.url } };
  }

  function parseUrl(pluginId: string, url: string): ParsedUrl {
    try {
      return parseConnectionUrl(urlForm(pluginId), url);
    } catch (cause) {
      if (cause instanceof ConnectionUrlError) {
        throw new DatasourceError(cause.message, "Paste the whole URL, or fill in the fields instead.");
      }
      throw cause;
    }
  }

  function urlOf(id: string): string {
    const datasource = find(id);
    return formatConnectionUrl(urlForm(datasource.pluginId), datasource.config);
  }

  async function test(request: SaveDatasourceRequest): Promise<ProbeResult> {
    const draft = request.datasource;
    const plugin = availablePlugin(draft.pluginId);
    const previous = draft.id === undefined ? undefined : datasources.find((datasource) => datasource.id === draft.id);
    const values: Record<string, string> = {};
    for (const field of secretFields(plugin)) {
      const change = request.secrets[field.key] ?? { action: "keep" };
      if (change.action === "set") values[field.key] = change.value;
      if (change.action !== "keep" || previous === undefined) continue;
      const stored = secrets.get(previous.id, field.key, previous.secretModes[field.key] ?? "never");
      if (stored !== undefined) values[field.key] = stored;
    }
    const probed = toDatasource(draft, draft.id ?? DRAFT_ID, plugin.fields);
    return hosts.probe(engineConfig(probed, values));
  }

  async function connect(
    datasourceId: string,
    typed: Readonly<Record<string, string>>,
    target: Target,
  ): Promise<ConnectResult> {
    const datasource = find(datasourceId);
    if (hosts.isRunning(datasourceId)) {
      hosts.open(engineConfig(datasource, {}), target);
      return { status: "connected" };
    }
    const plugin = pluginOf(datasource.pluginId);
    if (plugin === undefined || plugin.unavailableReason !== null) {
      const reason = plugin?.unavailableReason ?? `No plugin "${datasource.pluginId}" is installed.`;
      return { status: "failed", message: reason, hint: "Install or fix the plugin, then restart." };
    }
    const values: Record<string, string> = {};
    const missing: string[] = [];
    const isEphemeral = ephemeral?.id === datasourceId;
    for (const field of secretFields(plugin)) {
      const mode = datasource.secretModes[field.key] ?? "never";
      const value = typed[field.key] ?? secrets.get(datasourceId, field.key, mode);
      if (value === undefined) {
        if (!isEphemeral) missing.push(field.key);
        continue;
      }
      values[field.key] = value;
      if (typed[field.key] !== undefined && mode === "untilRestart") {
        await secrets.set(datasourceId, field.key, mode, value);
      }
    }
    if (missing.length > 0) return { status: "needsSecrets", keys: missing };
    hosts.open(engineConfig(datasource, values), target);
    return { status: "connected" };
  }

  return {
    list,
    plugins: () => options.plugins,
    save,
    importMany,
    delete: remove,
    test,
    parseUrl,
    url: urlOf,
    connect,
    disconnect: (datasourceId) => hosts.stop(datasourceId),
  };
}
