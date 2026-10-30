import { keyNeedsPassphrase, type QueryHistory } from "@table-craft/core";
import { ConnectionUrlError, formatConnectionUrl, parseConnectionUrl } from "@table-craft/plugin-api";
import type { ConsoleFiles } from "@table-craft/desktop/main/consoleFiles.js";
import type { DatasourceConfig, ProbeResult, SshTunnelConfig } from "@table-craft/desktop/engine/protocol.js";
import { toDatasource, type DatasourceStore } from "@table-craft/desktop/main/datasources.js";
import type { HostRegistry } from "@table-craft/desktop/main/hosts.js";
import type { SecretStore } from "@table-craft/desktop/main/secrets.js";
import { SSH_SECRET_KEYS } from "@table-craft/desktop/preload/bridge.js";
import type {
  ConfigValue,
  ConnectionField,
  ConnectResult,
  Datasource,
  DatasourceDraft,
  DatasourceList,
  DatasourceView,
  LastServer,
  ParsedUrl,
  PluginInfo,
  SaveDatasourceRequest,
  SecretMode,
  ServerSeen,
  SshSettings,
} from "@table-craft/desktop/preload/bridge.js";
import { PRODUCTION_COLOR, type AgentAccess, type AgentPolicy } from "@table-craft/desktop/settings/mcp.js";
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
  /** Read on every use, so a plugin installed while the app runs is usable at once (decision 110). */
  readonly plugins: () => readonly PluginInfo[];
  readonly ephemeral: EphemeralDatasource | null;
  readonly newId: () => string;
  /** Deleting a datasource deletes its saved consoles (plan 006, decision 18). */
  readonly consoles: Pick<ConsoleFiles, "deleteAll">;
  /** Deleting a datasource clears its query history (plan 011, decision 5). */
  readonly history: Pick<QueryHistory, "clear">;
  /** Called after every change, with the list every window should now show. */
  readonly onChanged: (list: DatasourceList) => void;
  /** Reads an SSH private key, so a passphrase is asked for only when it is encrypted; null when unreadable. */
  readonly readKeyFile?: (path: string) => Promise<string | null>;
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
  /**
   * Settings › MCP Server's access column (decision 127). It never raises a production-coloured
   * datasource to Ask before writes; its Data Sources page, through `save`, can.
   */
  setAgentAccess(datasourceId: string, access: AgentAccess): Promise<void>;
  /** A datasource's schema list and row limit for agents; a null field clears it. */
  setAgentPolicy(datasourceId: string, policy: AgentPolicy): Promise<void>;
  /**
   * Remembers the product and limits a connection reported (decision 131). Writes nothing for the
   * ephemeral or an unknown datasource, or when the facts are unchanged and were seen within a day.
   * The connection has worked, so the secrets typed for it are kept in their modes first.
   */
  rememberServer(datasourceId: string, seen: ServerSeen): Promise<void>;
}

export interface ImportedDatasource {
  readonly draft: DatasourceDraft;
  /** Secret values by field key; each is kept in the field's default mode. */
  readonly secrets: Readonly<Record<string, string>>;
}

const DRAFT_ID = "draft";
/** How stale `lastServer.seenAt` may grow before unchanged facts are written again, so "seen" stays recent. */
export const SEEN_REFRESH_MS = 86_400_000;

function sameServer(a: LastServer, b: LastServer): boolean {
  return (
    a.version === b.version &&
    a.timeout?.setting === b.timeout?.setting &&
    a.timeout?.covers === b.timeout?.covers &&
    a.timeout?.counts === b.timeout?.counts &&
    (a.timeout === null) === (b.timeout === null) &&
    a.cancel?.method === b.cancel?.method &&
    a.cancel?.reaches === b.cancel?.reaches
  );
}

function secretFields(plugin: PluginInfo | undefined): ConnectionField[] {
  return (plugin?.fields ?? []).filter((field) => field.secret === true);
}

const SSH_KEYS: readonly string[] = Object.values(SSH_SECRET_KEYS);

/** The tunnel the data source goes through; undefined when it has none or its plugin offers none. */
function tunnelOf(plugin: PluginInfo | undefined, ssh: SshSettings | undefined): SshSettings | undefined {
  return plugin?.network !== null && plugin?.network !== undefined && ssh?.enabled === true ? ssh : undefined;
}

/** The client key passphrase's key once the data source names a client key file, which is all it unlocks. */
function keyPassphraseOf(plugin: PluginInfo, config: Readonly<Record<string, ConfigValue>>): string | undefined {
  const tls = plugin.tls;
  if (tls?.keyPassphrase === undefined || tls.keyFile === undefined) return undefined;
  const keyFile = config[tls.keyFile];
  return typeof keyFile === "string" && keyFile !== "" ? tls.keyPassphrase : undefined;
}

/**
 * Every secret kept for the data source: the plugin's, the client key passphrase once there is a
 * client key, and both SSH secrets once it has SSH settings.
 */
function storedKeysOf(
  plugin: PluginInfo,
  ssh: SshSettings | undefined,
  config: Readonly<Record<string, ConfigValue>>,
): string[] {
  const passphrase = plugin.tls?.keyPassphrase;
  const own = secretFields(plugin)
    .map((field) => field.key)
    .filter((key) => key !== passphrase || keyPassphraseOf(plugin, config) !== undefined);
  return plugin.network !== null && ssh !== undefined ? [...own, ...SSH_KEYS] : own;
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
  /** Secrets typed at the prompt for a connection not yet known to work, by datasource. */
  const unconfirmed = new Map<string, Readonly<Record<string, string>>>();
  const pluginOf = (pluginId: string) => options.plugins().find((plugin) => plugin.id === pluginId);
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

  /** The form's rule (`fieldVisible`): a field hidden by `visibleWhen` is never sent, so never required. */
  function shown(plugin: PluginInfo, field: ConnectionField, config: Readonly<Record<string, ConfigValue>>): boolean {
    const rule = field.visibleWhen;
    if (rule === undefined) return true;
    const value = config[rule.key] ?? plugin.fields.find((other) => other.key === rule.key)?.default;
    return value === rule.equals;
  }

  function checkRequired(plugin: PluginInfo, config: Readonly<Record<string, ConfigValue>>): void {
    for (const field of plugin.fields) {
      if (field.secret === true || field.required !== true || !shown(plugin, field, config)) continue;
      const value = config[field.key];
      if (value === undefined || value === "") {
        throw new DatasourceError(`${field.label} is required.`, `Fill in ${field.label} and save again.`);
      }
    }
  }

  function modesFor(
    plugin: PluginInfo,
    ssh: SshSettings | undefined,
    config: Readonly<Record<string, ConfigValue>>,
    requested: Readonly<Record<string, SecretMode>>,
  ): Record<string, SecretMode> {
    const modes: Record<string, SecretMode> = {};
    for (const key of storedKeysOf(plugin, ssh, config)) modes[key] = requested[key] ?? defaultMode();
    return modes;
  }

  async function keyIsEncrypted(path: string): Promise<boolean> {
    const text = path === "" ? null : await (options.readKeyFile?.(path) ?? Promise.resolve(null));
    return text !== null && keyNeedsPassphrase(text);
  }

  /** The SSH secrets connecting needs: the password, or the passphrase of an encrypted key. */
  async function sshKeysNeeded(tunnel: SshSettings | undefined): Promise<string[]> {
    if (tunnel?.auth === "password") return [SSH_SECRET_KEYS.password];
    if (tunnel?.auth === "key" && (await keyIsEncrypted(tunnel.keyPath))) return [SSH_SECRET_KEYS.passphrase];
    return [];
  }

  /** The plugin's secrets connecting needs: all but the client key passphrase, which only an encrypted key needs. */
  async function pluginKeysNeeded(
    plugin: PluginInfo,
    config: Readonly<Record<string, ConfigValue>>,
  ): Promise<string[]> {
    const passphrase = keyPassphraseOf(plugin, config);
    const own = secretFields(plugin)
      .map((field) => field.key)
      .filter((key) => key !== plugin.tls?.keyPassphrase);
    if (passphrase === undefined || plugin.tls?.keyFile === undefined) return own;
    const encrypted = await keyIsEncrypted(String(config[plugin.tls.keyFile]));
    return encrypted ? [...own, passphrase] : own;
  }

  /** Set in Settings › MCP Server, not in the form, so a form save keeps them. */
  function agentPolicyOf(datasource: Datasource | undefined): Partial<Datasource> {
    if (datasource === undefined) return {};
    const { agentSchemas, agentRowCap, agentTimeoutSeconds } = datasource;
    return {
      ...(agentSchemas === undefined ? {} : { agentSchemas }),
      ...(agentRowCap === undefined ? {} : { agentRowCap }),
      ...(agentTimeoutSeconds === undefined ? {} : { agentTimeoutSeconds }),
    };
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
    const modes = modesFor(plugin, draft.ssh, draft.config, draft.secretModes);
    const origin = draft.origin ?? previous?.origin;
    const next = toDatasource(
      { ...agentPolicyOf(previous), ...draft, secretModes: modes, origin },
      id,
      plugin.fields,
      plugin.network !== null,
      previous,
    );
    checkRequired(plugin, next.config);
    checkTunnel(next.ssh);
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
    if (previous?.ssh !== undefined && next.ssh === undefined) {
      for (const key of SSH_KEYS) await secrets.clear(id, key);
    }
    const passphrase = plugin.tls?.keyPassphrase;
    if (
      passphrase !== undefined &&
      previous?.secretModes[passphrase] !== undefined &&
      modes[passphrase] === undefined
    ) {
      await secrets.clear(id, passphrase);
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
      const modes = modesFor(plugin, undefined, item.draft.config, {});
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
    unconfirmed.delete(id);
    await hosts.stop(id);
    await secrets.clearAll(id);
    datasources = datasources.filter((datasource) => datasource.id !== id);
    await store.save(datasources);
    await options.consoles.deleteAll(id);
    options.history.clear(id);
    changed();
  }

  function checkTunnel(ssh: SshSettings | undefined): void {
    if (ssh?.enabled !== true) return;
    if (ssh.host === "")
      throw new DatasourceError("SSH host is required.", "Fill in the SSH host, or clear Use SSH tunnel.");
    if (ssh.user === "")
      throw new DatasourceError("SSH user is required.", "Fill in the SSH user, or clear Use SSH tunnel.");
  }

  function sshConfig(tunnel: SshSettings, values: Readonly<Record<string, string>>): SshTunnelConfig {
    const { host, port, user, auth } = tunnel;
    const password = values[SSH_SECRET_KEYS.password];
    const passphrase = values[SSH_SECRET_KEYS.passphrase];
    if (auth === "password") return { host, port, user, auth, ...(password === undefined ? {} : { password }) };
    if (auth === "agent") return { host, port, user, auth };
    return { host, port, user, auth, keyPath: tunnel.keyPath, ...(passphrase === undefined ? {} : { passphrase }) };
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
    const own = Object.fromEntries(Object.entries(values).filter(([key]) => !SSH_KEYS.includes(key)));
    const tunnel = tunnelOf(pluginOf(datasource.pluginId), datasource.ssh);
    return {
      id: datasource.id,
      pluginId: datasource.pluginId,
      config: { ...datasource.config, ...own },
      readOnly: datasource.readOnly,
      keepAliveSeconds,
      ...(tunnel === undefined ? {} : { ssh: sshConfig(tunnel, values) }),
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
    for (const key of storedKeysOf(plugin, draft.ssh, draft.config)) {
      const change = request.secrets[key] ?? { action: "keep" };
      if (change.action === "set") values[key] = change.value;
      if (change.action !== "keep" || previous === undefined) continue;
      const stored = secrets.get(previous.id, key, previous.secretModes[key] ?? "never");
      if (stored !== undefined) values[key] = stored;
    }
    const probed = toDatasource(draft, draft.id ?? DRAFT_ID, plugin.fields, plugin.network !== null);
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
    const toKeep: Record<string, string> = {};
    const missing: string[] = [];
    const isEphemeral = ephemeral?.id === datasourceId;
    const needed = [
      ...(await pluginKeysNeeded(plugin, datasource.config)),
      ...(await sshKeysNeeded(tunnelOf(plugin, datasource.ssh))),
    ];
    for (const key of needed) {
      const mode = datasource.secretModes[key] ?? "never";
      const value = typed[key] ?? secrets.get(datasourceId, key, mode);
      if (value === undefined) {
        if (!isEphemeral) missing.push(key);
        continue;
      }
      values[key] = value;
      if (typed[key] !== undefined && mode !== "never") toKeep[key] = value;
    }
    if (missing.length > 0) return { status: "needsSecrets", keys: missing };
    if (Object.keys(toKeep).length > 0) unconfirmed.set(datasourceId, toKeep);
    else unconfirmed.delete(datasourceId);
    hosts.open(engineConfig(datasource, values), target);
    return { status: "connected" };
  }

  /**
   * Keeps what was typed at the prompt once the engine has reached the server, which main learns
   * from `rememberServer`; storing at `connect` would keep a mistyped password.
   */
  async function keepConfirmed(datasourceId: string): Promise<void> {
    const typed = unconfirmed.get(datasourceId);
    unconfirmed.delete(datasourceId);
    const datasource = datasources.find((candidate) => candidate.id === datasourceId);
    if (typed === undefined || datasource === undefined) return;
    let kept = false;
    for (const [key, value] of Object.entries(typed)) {
      const mode = datasource.secretModes[key] ?? "never";
      if (mode === "never") continue;
      try {
        await secrets.set(datasourceId, key, mode, value);
        kept = true;
      } catch {
        // The connection works without it; the prompt simply comes back next time.
      }
    }
    if (kept) changed();
  }

  async function disconnect(datasourceId: string): Promise<void> {
    unconfirmed.delete(datasourceId);
    await hosts.stop(datasourceId);
  }

  async function setAgentAccess(datasourceId: string, access: AgentAccess): Promise<void> {
    if (ephemeral?.id === datasourceId) {
      throw new DatasourceError(
        "This data source comes from TABLE_CRAFT_DATASOURCE and is not saved, so agents cannot reach it.",
        "Duplicate it to keep a copy, and give the copy access.",
      );
    }
    const previous = find(datasourceId);
    if (access === "ask" && previous.color === PRODUCTION_COLOR && previous.agentAccess !== "ask") {
      throw new DatasourceError(
        `${previous.name} is marked red for production, so agents stay at Read only here.`,
        "To let agents ask before writes, set AI agent access on its page in the Data Sources dialog.",
      );
    }
    const { agentAccess: _previous, ...rest } = previous;
    const next: Datasource = access === "off" ? rest : { ...rest, agentAccess: access };
    datasources = datasources.map((datasource) => (datasource.id === datasourceId ? next : datasource));
    await store.save(datasources);
    changed();
  }

  async function setAgentPolicy(datasourceId: string, policy: AgentPolicy): Promise<void> {
    const { agentSchemas: _schemas, agentRowCap: _rowCap, agentTimeoutSeconds: _timeout, ...rest } = find(datasourceId);
    const next: Datasource = {
      ...rest,
      ...(policy.schemas === null ? {} : { agentSchemas: [...policy.schemas] }),
      ...(policy.rowCap === null ? {} : { agentRowCap: policy.rowCap }),
      ...(policy.timeoutSeconds === null ? {} : { agentTimeoutSeconds: policy.timeoutSeconds }),
    };
    datasources = datasources.map((datasource) => (datasource.id === datasourceId ? next : datasource));
    await store.save(datasources);
    changed();
  }

  async function rememberServer(datasourceId: string, seen: ServerSeen): Promise<void> {
    await keepConfirmed(datasourceId);
    if (ephemeral?.id === datasourceId) return;
    const previous = datasources.find((datasource) => datasource.id === datasourceId);
    if (previous === undefined) return;
    const brand = seen.brand ?? previous.brand;
    const known = previous.lastServer;
    if (
      brand === previous.brand &&
      known !== undefined &&
      sameServer(known, seen.lastServer) &&
      seen.lastServer.seenAt - known.seenAt < SEEN_REFRESH_MS
    ) {
      return;
    }
    const next: Datasource = { ...previous, ...(brand === undefined ? {} : { brand }), lastServer: seen.lastServer };
    datasources = datasources.map((datasource) => (datasource.id === datasourceId ? next : datasource));
    await store.save(datasources);
    changed();
  }

  return {
    list,
    plugins: () => options.plugins(),
    save,
    importMany,
    delete: remove,
    test,
    parseUrl,
    url: urlOf,
    connect,
    disconnect,
    setAgentAccess,
    setAgentPolicy,
    rememberServer,
  };
}
