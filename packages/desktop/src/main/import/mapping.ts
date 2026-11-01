import { ConnectionUrlError, parseConnectionUrl, type ConnectionForm } from "@table-craft/plugin-api";
import { normalizeFolder } from "@table-craft/desktop/datasourceTree/arrange.js";
import { pluginUrl, urlScheme } from "@table-craft/desktop/main/import/jdbc.js";
import { catalogEntryForScheme } from "@table-craft/desktop/main/pluginStore/catalog.js";
import type { ForeignApp, ForeignConnection, ForeignSsl } from "@table-craft/desktop/main/import/types.js";
import {
  DATASOURCE_COLORS,
  type ConfigValue,
  type Datasource,
  type DatasourceColor,
  type DatasourceDraft,
  type ImportPasswordState,
  type ImportRow,
  type PluginInfo,
} from "@table-craft/desktop/preload/bridge.js";

/** The folder an app's imports go under when the dialog's top-level folder option is on. */
export const TOP_FOLDERS: Readonly<Record<ForeignApp, string>> = { datagrip: "DataGrip", tablepro: "TablePro" };

/**
 * TablePro names a database type rather than a URL; this is the URL scheme each type speaks, so the
 * plugin is still found by its manifest's schemes (decision 007), never by id.
 */
const SCHEME_OF_TYPE: Readonly<Record<string, string>> = {
  mysql: "mysql",
  mariadb: "mysql",
  tidb: "mysql",
  postgresql: "postgresql",
  redshift: "postgresql",
  cockroachdb: "postgresql",
  sqlite: "sqlite",
  oracle: "oracle",
  sqlserver: "sqlserver",
  mssql: "sqlserver",
  azure: "sqlserver",
};

/** Each named colour another app offers, to the nearest TableCraft tint (decision 011). */
const NEAREST_COLOR: Readonly<Record<string, DatasourceColor>> = {
  red: "red",
  pink: "red",
  orange: "orange",
  yellow: "yellow",
  green: "green",
  blue: "blue",
  purple: "violet",
  violet: "violet",
};

const DEFAULT_SSH_PORT = 22;
const SSL_DISABLE = "disable";
const SSL_REQUIRE = "require";
const SSL_VERIFY_CA = "verify-ca";
const SSL_VERIFY_FULL = "verify-full";

/** Whether the other app kept the password, and where; `bundle` values are read in main only. */
export type PasswordAvailability = "store" | "found" | "inFile" | "none" | "locked" | "elsewhere";

/** A mapped connection: what the preview shows, and what main imports. */
export interface MappedConnection {
  readonly row: ImportRow;
  /** Null when no installed plugin speaks the connection's scheme. */
  readonly draft: DatasourceDraft | null;
  /** The secret field the password goes into; null when the plugin has none. */
  readonly passwordKey: string | null;
}

function formOf(plugin: PluginInfo): ConnectionForm {
  return { connection: { fields: plugin.fields, url: plugin.url ?? undefined } };
}

function schemeOf(connection: ForeignConnection): string | null {
  if (connection.url !== null) return urlScheme(connection.url);
  return SCHEME_OF_TYPE[(connection.driver ?? "").toLowerCase().replace(/\s+/g, "")] ?? null;
}

function pluginFor(connection: ForeignConnection, plugins: readonly PluginInfo[]): PluginInfo | undefined {
  const scheme = schemeOf(connection);
  if (scheme === null) return undefined;
  return plugins.find((plugin) => plugin.unavailableReason === null && plugin.url?.schemes.includes(scheme) === true);
}

function defaults(plugin: PluginInfo): Record<string, ConfigValue> {
  const config: Record<string, ConfigValue> = {};
  for (const field of plugin.fields) {
    if (field.secret !== true && field.default !== undefined) config[field.key] = field.default;
  }
  return config;
}

function separateFields(connection: ForeignConnection, plugin: PluginInfo): Record<string, ConfigValue> {
  const parts = plugin.url?.parts ?? {};
  const config: Record<string, ConfigValue> = {};
  const set = (key: string | undefined, value: ConfigValue | null) => {
    if (key !== undefined && value !== null && value !== "") config[key] = value;
  };
  set(parts.host, connection.host);
  set(parts.port, connection.port);
  set(parts.database, connection.database);
  set(parts.user, connection.user);
  set(parts.path, connection.path);
  return config;
}

/** The select param whose values include `require`: the plugin's SSL mode field, if it has one. */
function sslField(plugin: PluginInfo): { key: string; values: ReadonlySet<string> } | null {
  for (const param of plugin.url?.params ?? []) {
    const values = new Set(Object.values(param.values ?? {}));
    if (values.has(SSL_REQUIRE)) return { key: param.key, values };
  }
  return null;
}

function applySsl(
  connection: ForeignConnection,
  plugin: PluginInfo,
  config: Record<string, ConfigValue>,
  warnings: string[],
): void {
  const { ssl } = connection;
  if (ssl === null) return;
  const field = sslField(plugin);
  if (ssl.mode === "disabled") {
    if (field?.values.has(SSL_DISABLE) === true) config[field.key] = SSL_DISABLE;
    return;
  }
  if (field === null) {
    warnings.push(`${plugin.name} has no SSL setting; the connection's SSL mode was not imported.`);
    return;
  }
  const wanted =
    ssl.mode === "preferred" || ssl.mode === "required"
      ? SSL_REQUIRE
      : ssl.mode === "verifyCa" && field.values.has(SSL_VERIFY_CA)
        ? SSL_VERIFY_CA
        : SSL_VERIFY_FULL;
  config[field.key] = field.values.has(wanted) ? wanted : SSL_REQUIRE;
  if (ssl.mode === "preferred") {
    warnings.push("SSL Preferred became Require: TableCraft does not fall back to an unencrypted connection.");
  }
  if (ssl.mode === "verifyCa" && wanted !== SSL_VERIFY_CA) {
    warnings.push("SSL Verify CA became Verify full, which also checks the host name.");
  }
  applyCertificateFiles(ssl, plugin, config, warnings);
}

/** Carries the CA, client certificate and key paths into the plugin's certificate fields (decision 072). */
function applyCertificateFiles(
  ssl: ForeignSsl,
  plugin: PluginInfo,
  config: Record<string, ConfigValue>,
  warnings: string[],
): void {
  const pairs = [
    [ssl.caFile, plugin.tls?.caFile],
    [ssl.certFile, plugin.tls?.certFile],
    [ssl.keyFile, plugin.tls?.keyFile],
  ] as const;
  let dropped = false;
  for (const [path, key] of pairs) {
    if (path === null) continue;
    if (key === undefined) dropped = true;
    else config[key] = path;
  }
  if (dropped) {
    warnings.push("SSL certificate files were not imported; TableCraft uses the system's trusted certificates.");
  }
}

function comparable(config: Readonly<Record<string, ConfigValue>>, plugin: PluginInfo): string {
  const parts = plugin.url?.parts ?? {};
  const keys = [parts.host, parts.port, parts.database, parts.user, parts.path];
  return [plugin.id, ...keys.map((key) => (key === undefined ? "" : String(config[key] ?? "")))].join("\u0000");
}

/** Where the connection points, for the preview: `host:port/database`, or the file. */
function targetOf(config: Readonly<Record<string, ConfigValue>>, plugin: PluginInfo | undefined): string {
  if (plugin === undefined) return "";
  const parts = plugin.url?.parts ?? {};
  const value = (key: string | undefined) => (key === undefined ? "" : String(config[key] ?? ""));
  if (parts.path !== undefined) return value(parts.path);
  const port = value(parts.port);
  const database = value(parts.database);
  return `${value(parts.host)}${port === "" ? "" : `:${port}`}${database === "" ? "" : `/${database}`}`;
}

function rowKey(connection: ForeignConnection): string {
  return `${connection.app}:${connection.id}`;
}

export interface MappingContext {
  readonly plugins: readonly PluginInfo[];
  readonly existing: readonly Datasource[];
  /** How each password source reads at preview time; KeePass entries are known already. */
  readonly availability: (connection: ForeignConnection) => PasswordAvailability;
}

function passwordState(availability: PasswordAvailability, hasSecret: boolean): ImportPasswordState {
  if (!hasSecret) return "notNeeded";
  switch (availability) {
    case "store":
      return "keychain";
    case "found":
      return "found";
    case "inFile":
      return "inFile";
    case "locked":
      return "locked";
    case "elsewhere":
      return "askOnConnect";
    case "none":
      return "notSaved";
  }
}

/** Maps one connection to a draft TableCraft datasource and its preview row. */
export function mapConnection(connection: ForeignConnection, context: MappingContext): MappedConnection {
  const plugin = pluginFor(connection, context.plugins);
  const warnings: string[] = [];
  const base = {
    key: rowKey(connection),
    app: connection.app,
    name: connection.name,
    user: connection.user,
    folder: connection.folder,
  };
  if (plugin === undefined) {
    const scheme = schemeOf(connection);
    return {
      row: {
        ...base,
        // A plugin TableCraft can download keeps its id, so the preview can offer to install it.
        pluginId: scheme === null ? null : (catalogEntryForScheme(scheme)?.id ?? null),
        pluginName: connection.driver ?? scheme ?? "Unknown",
        target: connection.url === null ? "" : pluginUrl(connection.url),
        password: "notNeeded",
        warnings: [`No installed plugin reads ${scheme === null ? "this connection" : `${scheme}: URLs`}.`],
        status: "unsupported",
        selected: false,
      },
      draft: null,
      passwordKey: null,
    };
  }
  const config = defaults(plugin);
  if (connection.url !== null) {
    try {
      const parsed = parseConnectionUrl(formOf(plugin), pluginUrl(connection.url));
      Object.assign(config, parsed.values);
      if (parsed.ignored.length > 0) warnings.push(`Ignored URL parameters: ${parsed.ignored.join(", ")}.`);
    } catch (cause) {
      const reason = cause instanceof ConnectionUrlError ? cause.message : String(cause);
      return {
        row: {
          ...base,
          pluginId: plugin.id,
          pluginName: plugin.name,
          target: pluginUrl(connection.url),
          password: "notNeeded",
          warnings: [`The URL could not be read: ${reason}`],
          status: "unsupported",
          selected: false,
        },
        draft: null,
        passwordKey: null,
      };
    }
    const userKey = plugin.url?.parts.user;
    if (userKey !== undefined && connection.user !== null && connection.user !== "") config[userKey] = connection.user;
  } else {
    Object.assign(config, separateFields(connection, plugin));
  }
  applySsl(connection, plugin, config, warnings);
  const passwordKey = plugin.url?.parts.password ?? plugin.fields.find((field) => field.secret === true)?.key ?? null;
  const color = NEAREST_COLOR[(connection.color ?? "").toLowerCase()] ?? null;
  const draft: DatasourceDraft = {
    name: connection.name,
    pluginId: plugin.id,
    folder: normalizeFolder(connection.folder),
    color: color !== null && DATASOURCE_COLORS.includes(color) ? color : null,
    readOnly: connection.readOnly,
    comment: connection.comment,
    config,
    secretModes: {},
    origin: { app: connection.app, id: connection.id },
  };
  let status: ImportRow["status"] = "ready";
  if (connection.ssh !== null) {
    const port = connection.ssh.port ?? DEFAULT_SSH_PORT;
    warnings.unshift(
      `SSH tunnel through ${connection.ssh.host}:${String(port)} was not imported; TableCraft has no SSH tunnels yet.`,
    );
    status = "sshTunnel";
  }
  const key = comparable(config, plugin);
  const duplicate = context.existing.some(
    (existing) =>
      (existing.origin?.app === connection.app && existing.origin.id === connection.id) ||
      (existing.pluginId === plugin.id && comparable(existing.config, plugin) === key),
  );
  if (duplicate) status = "duplicate";
  return {
    row: {
      ...base,
      user: plugin.url?.parts.user === undefined ? null : String(config[plugin.url.parts.user] ?? "") || null,
      pluginId: plugin.id,
      pluginName: plugin.name,
      target: targetOf(config, plugin),
      password: passwordState(context.availability(connection), passwordKey !== null),
      warnings,
      status,
      selected: status === "ready",
    },
    draft,
    passwordKey,
  };
}

/** `name`, or `name (2)`, `name (3)`, … whichever no datasource in `folder` uses yet. */
export function freeName(
  name: string,
  folder: string | null,
  taken: readonly Pick<Datasource, "name" | "folder">[],
): string {
  const used = new Set(taken.filter((datasource) => datasource.folder === folder).map((datasource) => datasource.name));
  if (!used.has(name)) return name;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${name} (${String(suffix)})`;
    if (!used.has(candidate)) return candidate;
  }
}

/** The folder a datasource lands in, under the app's own top folder when asked. */
export function importFolder(app: ForeignApp, folder: string | null, topFolder: boolean): string | null {
  return normalizeFolder(topFolder ? [TOP_FOLDERS[app], folder ?? ""].join("/") : folder);
}
