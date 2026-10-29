/**
 * What main, preload and renderer agree on. Declarations only, so the sandboxed renderer can
 * import it without pulling in `electron` or zod. The types that mirror plugin-api are pinned to
 * their originals by `test/desktop/protocol.test.ts`.
 */
import type { UserThemeEntry } from "@table-craft/desktop/appearance/themes.js";
import type {
  Capability,
  HostKeyOffer,
  LastServer,
  ProbeResult,
  ServerSeen,
  SshAuthMethod,
} from "@table-craft/desktop/engine/protocol.js";

export type { LastServer, ServerSeen } from "@table-craft/desktop/engine/protocol.js";
import type { LogRecord } from "@table-craft/desktop/log/record.js";
import type {
  AgentAccess,
  AgentPolicy,
  McpActiveConsole,
  McpClient,
  McpConsoleRequest,
  McpContextRequest,
  McpStatus,
  McpUserControl,
} from "@table-craft/desktop/settings/mcp.js";
import type { Settings } from "@table-craft/desktop/settings/settings.js";
import type { TextSnippet } from "@table-craft/desktop/snippets/snippets.js";

export const CHANNELS = {
  /** Main to preload: here is a fresh engine port for the datasource the payload names. */
  enginePort: "table-craft:engine-port",
  /** Main to preload: the user picked a native menu item; the payload is its action id. */
  invokeAction: "table-craft:invoke-action",
  /** Main to every window: the datasource list changed; the payload is a `DatasourceList`. */
  datasourcesChanged: "table-craft:datasources.changed",
  /** Main to every window: an engine host ended; the payload is an `EngineExited`. */
  engineExited: "table-craft:engine.exited",
  /** Main to a window: the user asked to close it or quit; answer with `answerClose`. */
  closeRequested: "table-craft:window.close-requested",
  /** Main to every window: settings were saved or the themes reread; the payload is a `SettingsChanged`. */
  settingsChanged: "table-craft:settings.changed",
  snippetsChanged: "table-craft:snippets.changed",
  /** Main to a window: it entered or left full screen; the payload is its `WindowState`. */
  windowState: "table-craft:window.state-changed",
  /** Main to every window: records were written to the log; the payload is a `LogRecord[]`. */
  logAppended: "table-craft:log.appended",
  /** Main to every window: the updater moved; the payload is the whole `UpdateState` (plan 020). */
  updateState: "table-craft:update.state",
  /** Main to the importing window: one more connection done; the payload is an `ImportProgress`. */
  importProgress: "table-craft:import.progress",
  /** Main to a window: an SSH server offered an unknown host key; the payload is a `HostKeyPrompt`. */
  hostKeyPrompt: "table-craft:ssh.host-key-prompt",
  /** Main to a window: a File → Recent Files item was picked; the payload is its absolute path (plan 041). */
  openRecentFile: "table-craft:sql-files.open-recent",
  /** Main to every window: a plugin was installed, removed or is downloading; the payload is a `PluginsState`. */
  pluginsChanged: "table-craft:plugins.changed",
  /** Main to every window: the MCP server, its clients or its approvals changed; the payload is an `McpStatus`. */
  mcpStatus: "table-craft:mcp.status-changed",
  mcpContextRequest: "table-craft:mcp.context-request",
  mcpOpenConsole: "table-craft:mcp.open-console",
} as const;

/** Renderer to main, through `ipcRenderer.invoke`; each answers with an `InvokeResult`. */
export const INVOKE_CHANNELS = {
  listDatasources: "table-craft:datasources.list",
  saveDatasource: "table-craft:datasources.save",
  deleteDatasource: "table-craft:datasources.delete",
  testDatasource: "table-craft:datasources.test",
  parseDatasourceUrl: "table-craft:datasources.parse-url",
  datasourceUrl: "table-craft:datasources.url",
  listPlugins: "table-craft:plugins.list",
  pluginsState: "table-craft:plugins.state",
  installPlugin: "table-craft:plugins.install",
  installPluginFile: "table-craft:plugins.install-file",
  removePlugin: "table-craft:plugins.remove",
  connectEngine: "table-craft:engine.connect",
  disconnectEngine: "table-craft:engine.disconnect",
  chooseFile: "table-craft:dialog.choose-file",
  openFile: "table-craft:dialog.open-file",
  openAnyFile: "table-craft:dialog.open-any-file",
  saveFile: "table-craft:dialog.save-file",
  revealFile: "table-craft:shell.reveal-file",
  listConsoles: "table-craft:consoles.list",
  readConsole: "table-craft:consoles.read",
  writeConsole: "table-craft:consoles.write",
  deleteConsole: "table-craft:consoles.delete",
  renameConsole: "table-craft:consoles.rename",
  consolePath: "table-craft:consoles.path",
  chooseSqlFiles: "table-craft:sql-files.choose",
  openSqlFile: "table-craft:sql-files.open",
  readSqlFile: "table-craft:sql-files.read",
  writeSqlFile: "table-craft:sql-files.write",
  renameSqlFile: "table-craft:sql-files.rename",
  statSqlFiles: "table-craft:sql-files.stat",
  attachSqlFile: "table-craft:sql-files.attach",
  recentSqlFiles: "table-craft:sql-files.recent",
  historyRecord: "table-craft:history.record",
  historySearch: "table-craft:history.search",
  historyClear: "table-craft:history.clear",
  answerClose: "table-craft:window.answer-close",
  readSettings: "table-craft:settings.read",
  readSnippets: "table-craft:snippets.read",
  saveSnippet: "table-craft:snippets.save",
  deleteSnippet: "table-craft:snippets.delete",
  importSnippets: "table-craft:snippets.import",
  exportSnippets: "table-craft:snippets.export",
  writeSettings: "table-craft:settings.write",
  reloadThemes: "table-craft:themes.reload",
  openThemesFolder: "table-craft:themes.open-folder",
  appInfo: "table-craft:app.info",
  popupMenu: "table-craft:menu.popup",
  windowState: "table-craft:window.state",
  relaunch: "table-craft:app.relaunch",
  logWrite: "table-craft:log.write",
  logRead: "table-craft:log.read",
  logReveal: "table-craft:log.reveal",
  exportDiagnostics: "table-craft:diagnostics.export",
  updateState: "table-craft:update.state",
  updateCheck: "table-craft:update.check",
  updateDownload: "table-craft:update.download",
  updateCancel: "table-craft:update.cancel",
  updateInstall: "table-craft:update.install",
  updateSkip: "table-craft:update.skip",
  updateDismiss: "table-craft:update.dismiss",
  updateOpenNotes: "table-craft:update.open-notes",
  importScan: "table-craft:import.scan",
  importPreview: "table-craft:import.preview",
  importRun: "table-craft:import.run",
  importCancel: "table-craft:import.cancel",
  answerHostKey: "table-craft:ssh.answer-host-key",
  setAgentAccess: "table-craft:datasources.set-agent-access",
  rememberServer: "table-craft:datasources.remember-server",
  setAgentPolicy: "table-craft:datasources.set-agent-policy",
  mcpCopyToken: "table-craft:mcp.copy-token",
  mcpContextReply: "table-craft:mcp.context-reply",
  mcpStatus: "table-craft:mcp.status",
  mcpControl: "table-craft:mcp.control",
  mcpCopyClientConfig: "table-craft:mcp.copy-client-config",
  mcpRegenerateToken: "table-craft:mcp.regenerate-token",
} as const;

/** The `window.postMessage` kind preload uses to hand a port on; contextBridge cannot carry one. */
export const ENGINE_PORT_WINDOW_MESSAGE = "table-craft:engine-port";

export interface EnginePortWindowMessage {
  readonly kind: typeof ENGINE_PORT_WINDOW_MESSAGE;
  readonly datasourceId: string;
}

export const BRIDGE_KEY = "tableCraft";

/** How long a secret is kept (decision 020). */
export const SECRET_MODES = ["forever", "untilRestart", "never"] as const;
export type SecretMode = (typeof SECRET_MODES)[number];

/** The named tints a datasource can carry (decision 011); the values are design tokens. */
export const DATASOURCE_COLORS = ["red", "orange", "yellow", "green", "blue", "violet"] as const;
export type DatasourceColor = (typeof DATASOURCE_COLORS)[number];

/** Mirrors `ConnectionField` in plugin-api (decision 019). */
export interface ConnectionField {
  readonly key: string;
  readonly label: string;
  readonly kind: "text" | "number" | "password" | "file" | "select" | "checkbox";
  readonly default?: string | number | boolean | undefined;
  readonly required?: boolean | undefined;
  readonly placeholder?: string | undefined;
  readonly options?: readonly { readonly value: string; readonly label: string }[] | undefined;
  readonly group?: "general" | "advanced" | undefined;
  readonly secret?: boolean | undefined;
  /** Drawn only while the named select or checkbox holds `equals` (plan 058). */
  readonly visibleWhen?: { readonly key: string; readonly equals: string | boolean } | undefined;
}

export type ConfigValue = string | number | boolean;

/** Mirrors `ConnectionUrlSpec` in plugin-api: how the plugin's connection URLs read (decision 055). */
export interface ConnectionUrlSpec {
  readonly schemes: readonly string[];
  readonly form: "server" | "file";
  readonly parts: Readonly<Partial<Record<"host" | "port" | "database" | "user" | "password" | "path", string>>>;
  readonly params?:
    | readonly {
        readonly name: string;
        readonly key: string;
        readonly values?: Readonly<Record<string, string>> | undefined;
      }[]
    | undefined;
  readonly sets?: Readonly<Record<string, Readonly<Record<string, ConfigValue>>>> | undefined;
  readonly semicolonParams?: boolean | undefined;
}

/** What a pasted connection URL fills in; `secrets` is what the user pasted, for the secret fields. */
export interface ParsedUrl {
  readonly values: Readonly<Record<string, ConfigValue>>;
  readonly secrets: Readonly<Record<string, string>>;
  readonly ignored: readonly string[];
}

/**
 * Where an installed plugin came from (decision 110): inside the app, the development build's
 * optional plugins, downloaded or installed from a file into `<userData>/managed-plugins/`, or a
 * folder the user put in `<userData>/plugins/`.
 */
export type PluginSource = "builtIn" | "development" | "managed" | "user";

/** Mirrors `Brand` in plugin-api: a database product a plugin speaks, by its simple-icons slug. */
export interface Brand {
  readonly id: string;
  readonly name: string;
}

/** An installed plugin as the Data Sources dialog lists it; read from its manifest only. */
export interface PluginInfo {
  readonly id: string;
  readonly name: string;
  readonly source: PluginSource;
  /** The manifest's version; null when the manifest is unreadable. */
  readonly version: string | null;
  /** Null when the plugin can be used; otherwise why not, in a sentence. */
  readonly unavailableReason: string | null;
  readonly capabilities: readonly Capability[];
  readonly fields: readonly ConnectionField[];
  /** The manifest's SQL dialect for the editor, e.g. `postgresql`; null when the manifest is unreadable. */
  readonly highlight: string | null;
  /** The products it speaks, the default first; empty when the manifest names none or is unreadable. */
  readonly brands: readonly Brand[];
  /** The manifest's connection URL; null when the plugin reads none. */
  readonly url: ConnectionUrlSpec | null;
  /** Mirrors `NetworkSpec` in plugin-api; null when the data source is not reached over the network, so it has no SSH tunnel. */
  readonly network: {
    readonly host: string;
    readonly port: string;
    readonly connectTimeout?: string | undefined;
  } | null;
  /** Mirrors `TlsSpec` in plugin-api; null when the plugin has no certificate fields (decision 072). */
  readonly tls: {
    readonly mode: string;
    readonly verifyModes: readonly string[];
    readonly caFile?: string | undefined;
    readonly certFile?: string | undefined;
    readonly keyFile?: string | undefined;
    readonly keyPassphrase?: string | undefined;
  } | null;
}

/** One downloadable plugin's install, pushed on every progress step (decision 110). */
export type PluginInstallState =
  | { readonly status: "idle" }
  | { readonly status: "installing"; readonly received: number; readonly total: number | null }
  | { readonly status: "failed"; readonly message: string; readonly hint: string };

/** A plugin TableCraft can download, from the catalog compiled into the app. */
export interface CatalogPlugin {
  readonly id: string;
  readonly name: string;
  readonly packageName: string;
  /** The URL schemes it reads, so the import can offer it for a connection no plugin reads. */
  readonly schemes: readonly string[];
  /** The products it speaks, the default first, for the picker's rows before it is installed. */
  readonly brands: readonly Brand[];
  readonly approximateBytes: number;
  /** The version loaded from any root; null when the plugin is not installed. */
  readonly installedVersion: string | null;
  readonly install: PluginInstallState;
}

export interface PluginsState {
  readonly plugins: readonly PluginInfo[];
  readonly catalog: readonly CatalogPlugin[];
}

/** Install from File: what was installed, or nothing when the user cancelled the dialog or the confirmation. */
export type InstallFileResult =
  | { readonly status: "installed"; readonly pluginId: string; readonly version: string }
  | { readonly status: "cancelled" };

/** The SSH tunnel's settings as `datasources.json` holds them (decision 070); its secrets are in `secretModes`. */
export interface SshSettings {
  readonly enabled: boolean;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly auth: SshAuthMethod;
  /** The private key file, for `key` authentication. */
  readonly keyPath: string;
}

export const DEFAULT_SSH_PORT = 22;

/**
 * The secret keys of the SSH tunnel, beside the plugin's own in `secretModes` and the secret
 * store. Dotted, so no connection field (camelCase, decision 019) can share one.
 */
export const SSH_SECRET_KEYS = { password: "ssh.password", passphrase: "ssh.passphrase" } as const;

/** How the SSH secrets are labelled where they are asked for. */
export const SSH_SECRET_LABELS: Readonly<Record<string, string>> = {
  [SSH_SECRET_KEYS.password]: "SSH password",
  [SSH_SECRET_KEYS.passphrase]: "Key passphrase",
};

/** Main asks a window whether to trust an unknown SSH host key; answer with `answerHostKey`. */
export interface HostKeyPrompt {
  readonly requestId: number;
  readonly offer: HostKeyOffer;
}

/** A datasource as `datasources.json` holds it: no secret value, ever (decision 010). */
export interface Datasource {
  readonly id: string;
  readonly name: string;
  readonly pluginId: string;
  /** A `/`-separated folder path, such as `Docker/Main`; null at the top level. */
  readonly folder: string | null;
  readonly color: DatasourceColor | null;
  readonly readOnly: boolean;
  /** Seconds before TCP keepalive and the idle ping (decision 054); absent is 30, 0 is off. */
  readonly keepAliveSeconds?: number | undefined;
  /** Overrides Settings → Editor → Running's statement timeout; absent follows it, 0 is no limit. */
  readonly statementTimeoutSeconds?: number | undefined;
  /** The console, grid and Explain also ask the database to stop at that limit (decision 129); absent, the app alone. */
  readonly enforceTimeoutOnServer?: true | undefined;
  readonly comment: string;
  /** The non-secret connection fields, by key. */
  readonly config: Readonly<Record<string, ConfigValue>>;
  /** How each secret field is kept, by key. */
  readonly secretModes: Readonly<Record<string, SecretMode>>;
  /** The app and id it was imported from (decision 068); absent for one made in TableCraft. */
  readonly origin?: DatasourceOrigin | undefined;
  /** Only for a plugin whose manifest declares `network`; absent is no tunnel. */
  readonly ssh?: SshSettings | undefined;
  /**
   * The top-level namespaces the Database pane shows, by name (decision 117); absent shows them all.
   * An allow-list, so a database created later on a shared server stays hidden until picked.
   */
  readonly shownNamespaces?: readonly string[] | undefined;
  /** What agents may do here over MCP (decision 127); absent is `off`. */
  readonly agentAccess?: AgentAccess | undefined;
  /** The top-level namespaces agents see; absent, the shown ones. */
  readonly agentSchemas?: readonly string[] | undefined;
  /** Rows per agent answer here; absent, Settings › MCP Server's row limit. */
  readonly agentRowCap?: number | undefined;
  /**
   * The product it is, one of its plugin's `brands` ids: picked in New Data Source, then what the
   * server last reported. Absent is the plugin's default.
   */
  readonly brand?: string | undefined;
  /** Seconds an agent's statement may run here; absent, Settings › MCP Server's statement timeout. */
  readonly agentTimeoutSeconds?: number | undefined;
  /** What the server last said about itself and its limits (decision 131); absent until it is reached. */
  readonly lastServer?: LastServer | undefined;
}

/** The apps whose saved connections TableCraft imports (plan 035). */
export const IMPORT_APPS = ["datagrip", "tablepro"] as const;
export type ImportApp = (typeof IMPORT_APPS)[number];

export interface DatasourceOrigin {
  readonly app: ImportApp;
  /** The other app's id for it: a DataGrip uuid, a TablePro connection id or bundle ref. */
  readonly id: string;
}

/** What the import preview says of a connection's password; never the password itself. */
export type ImportPasswordState =
  /** In the system credential store; reading it may show the system's prompt. */
  | "keychain"
  /** Read already, from DataGrip's KeePass file. */
  | "found"
  /** In the decrypted `.tablepro` bundle. */
  | "inFile"
  | "notSaved"
  | "locked"
  /** Kept where TableCraft cannot read it; asked for on the first connect. */
  | "askOnConnect"
  /** The datasource type has no password, or the row is not importable. */
  | "notNeeded";

export interface ImportRow {
  /** `<app>:<id>`, unique within a preview. */
  readonly key: string;
  readonly app: ImportApp;
  readonly name: string;
  /** Null when no plugin reads it; on an `unsupported` row, a plugin TableCraft can download. */
  readonly pluginId: string | null;
  /** The plugin's name, or the other app's driver when no plugin reads it. */
  readonly pluginName: string;
  /** `host:port/database` or the file path. */
  readonly target: string;
  readonly user: string | null;
  /** The folder within the other app, before the top-level folder option. */
  readonly folder: string | null;
  readonly password: ImportPasswordState;
  readonly warnings: readonly string[];
  /** `unsupported` cannot be ticked; `duplicate` and `sshTunnel` start unticked. */
  readonly status: "ready" | "duplicate" | "sshTunnel" | "unsupported";
  readonly selected: boolean;
}

export interface ImportSource {
  readonly app: ImportApp;
  readonly label: string;
  readonly found: boolean;
  /** Connections found; 0 when not found. */
  readonly count: number;
  /** The configuration read, or where it was looked for when not found. */
  readonly locations: readonly string[];
  /** The store its passwords are in, such as "macOS Keychain", or why they cannot be read. */
  readonly passwords: string;
}

export type ImportPreviewRequest =
  | { readonly source: ImportApp }
  /** A `.tablepro` bundle or a `dataSources.xml` the user picked; the passphrase is used once. */
  | { readonly source: "file"; readonly path: string; readonly passphrase?: string | undefined };

export type ImportPreview =
  | {
      readonly status: "ready";
      readonly previewId: number;
      readonly app: ImportApp;
      /** The folder the top-level option puts everything under, such as `DataGrip`. */
      readonly topFolder: string;
      readonly rows: readonly ImportRow[];
    }
  | { readonly status: "needsPassphrase" | "wrongPassphrase"; readonly message: string };

export interface ImportRunRequest {
  readonly previewId: number;
  readonly keys: readonly string[];
  readonly importPasswords: boolean;
  readonly topFolder: boolean;
}

export interface ImportProgress {
  readonly done: number;
  readonly total: number;
  /** What is happening now, such as "Reading keychain 3 of 14…". */
  readonly message: string;
}

export interface ImportSummary {
  readonly imported: number;
  readonly withPasswords: number;
  readonly skipped: number;
  /** The new datasources, for the tree to select. */
  readonly ids: readonly string[];
  readonly cancelled: boolean;
  /** The user denied the keychain; the rest were imported without passwords. */
  readonly keychainDenied: boolean;
}

/** What the renderer sees of a datasource: its record, and which secrets have a stored value. */
export interface DatasourceView extends Datasource {
  /** Secret keys with a value main can use without asking; never the values themselves. */
  readonly storedSecrets: readonly string[];
  /** From `TABLE_CRAFT_DATASOURCE` (decision 018): never written to disk, and not editable. */
  readonly ephemeral: boolean;
}

export interface DatasourceList {
  readonly datasources: readonly DatasourceView[];
  /** Set once when `datasources.json` could not be read and was backed up. */
  readonly warning: string | null;
  /** Whether Forever can be offered; when not, why (decision 020). */
  readonly encryption: { readonly available: boolean; readonly reason: string | null };
}

/** What a secret field asks main to do on save. A blank field on edit is `keep`. */
export type SecretChange =
  { readonly action: "keep" } | { readonly action: "set"; readonly value: string } | { readonly action: "clear" };

/** A datasource from the dialog; `id` is absent for a new one. */
export type DatasourceDraft = Omit<Datasource, "id"> & { readonly id?: string | undefined };

export interface SaveDatasourceRequest {
  readonly datasource: DatasourceDraft;
  readonly secrets: Readonly<Record<string, SecretChange>>;
}

export type ConnectResult =
  | { readonly status: "connected" }
  /** Secrets kept `never`, or lost from the keychain, that the user must type to connect now. */
  | { readonly status: "needsSecrets"; readonly keys: readonly string[] }
  | { readonly status: "failed"; readonly message: string; readonly hint: string };

export interface EngineExited {
  readonly datasourceId: string;
  readonly code: number;
  /** True when main asked it to stop or it closed its last port; false when it crashed. */
  readonly clean: boolean;
}

/** Mirrors core's `HISTORY_OUTCOMES` and `HISTORY_SOURCES` (decision 030). */
export const HISTORY_OUTCOMES = ["success", "error", "cancelled"] as const;
export type HistoryOutcome = (typeof HISTORY_OUTCOMES)[number];
export const HISTORY_SOURCES = ["console", "table", "agent"] as const;
export type HistorySource = (typeof HISTORY_SOURCES)[number];

/** Mirrors core's `HistoryEntry`: one statement run, as the renderer saw it end. */
export interface HistoryEntry {
  readonly datasourceId: string;
  readonly sql: string;
  /** Epoch milliseconds. */
  readonly startedAt: number;
  readonly durationMs: number;
  readonly outcome: HistoryOutcome;
  /** Rows returned for a result set, rows affected otherwise; null when unknown. */
  readonly rowCount: number | null;
  /** The error's message for a failure. */
  readonly message: string | null;
  readonly source: HistorySource;
  /** The values it was bound with, by parameter name; absent or null when none. */
  readonly parameters?: Readonly<Record<string, string | null>> | null;
  /** How many warnings the server left, never their text; absent or null when none. */
  readonly warnings?: number | null;
  /** The MCP client that ran it; absent or null for the user's own runs. */
  readonly client?: string | null;
}

/** Mirrors core's `HistoryStatement`: every run of one exact text, described by its newest. */
export interface HistoryStatement {
  readonly sql: string;
  readonly lastStartedAt: number;
  readonly lastDurationMs: number;
  readonly lastOutcome: HistoryOutcome;
  readonly lastRowCount: number | null;
  readonly lastMessage: string | null;
  readonly lastParameters: Readonly<Record<string, string | null>> | null;
  readonly lastSource: HistorySource;
  /** The MCP client behind the newest run; null for the user's own. */
  readonly lastClient: string | null;
  readonly runs: number;
}

/** The saved settings and the user themes main read beside them (decision 032). */
export interface SettingsChanged {
  readonly settings: Settings;
  readonly themes: readonly UserThemeEntry[];
}

export interface SettingsSnapshot extends SettingsChanged {
  /** Why `settings.json` was set aside at launch, for a one-time notice; null when it read cleanly. */
  readonly warning: string | null;
}

/** A failure main can explain; anything else is a bug. */
export interface BridgeFailure {
  readonly message: string;
  readonly hint: string;
}

export type InvokeResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: BridgeFailure };

/** What Help → About shows (plan 014 decision 9); `version` is `0.0.0` in development. */
export interface AppInfo {
  readonly name: string;
  readonly version: string;
  readonly electron: string;
  readonly chromium: string;
}

/** The release an update offers; its URLs stay in main, which opens them itself (plan 020). */
export interface UpdateRelease {
  readonly version: string;
  /** Bytes of the download for this platform; 0 when there is none. */
  readonly size: number;
}

/**
 * The updater's one state (plan 020 decision 8), pushed whole on `CHANNELS.updateState`. The
 * renderer never derives a phase from two fields; `current` is this build's version in every phase.
 */
export type UpdateState =
  | { readonly phase: "idle"; readonly current: string }
  | { readonly phase: "checking"; readonly current: string }
  | { readonly phase: "available"; readonly current: string; readonly release: UpdateRelease }
  | {
      readonly phase: "downloading";
      readonly current: string;
      readonly release: UpdateRelease;
      readonly received: number;
      readonly total: number;
    }
  | { readonly phase: "ready"; readonly current: string; readonly release: UpdateRelease }
  | {
      readonly phase: "error";
      readonly current: string;
      /** The release the failure was about; null when the check itself failed. */
      readonly release: UpdateRelease | null;
      readonly message: string;
      /** Whether Retry can help: a network failure or a bad download, not a bad signature. */
      readonly retryable: boolean;
    }
  | {
      readonly phase: "ineligible";
      readonly current: string;
      readonly release: UpdateRelease;
      readonly message: string;
    };

export type UpdatePhase = UpdateState["phase"];

/** The window's frame (decision 034), fixed at creation, and whether it is full screen now. */
export interface WindowState {
  readonly fullScreen: boolean;
  /** The main toolbar is the title bar; false when "Use system title bar" was on at creation. */
  readonly customTitleBar: boolean;
}

/** The line break a SQL file uses, kept on save: the editor holds LF only (plan 041). */
export type LineEnding = "lf" | "crlf";

/** A SQL file's text as the editor holds it: BOM dropped, line breaks normalised to LF. */
export interface SqlFileText {
  readonly path: string;
  readonly sql: string;
  readonly lineEnding: LineEnding;
  /** The file's modification time in epoch milliseconds, to notice a change made elsewhere. */
  readonly modifiedAt: number;
}

/** The data source and namespace a SQL file was last used with (plan 041, decision 5). */
export interface FileAttachment {
  readonly datasourceId: string;
  readonly namespace: readonly string[] | null;
}

export interface SqlFileOpened extends SqlFileText {
  readonly attachment: FileAttachment | null;
}

/** A point in the window's content, in CSS pixels. */
export interface MenuPoint {
  readonly x: number;
  readonly y: number;
}

export interface TableCraftBridge {
  listDatasources(): Promise<InvokeResult<DatasourceList>>;
  saveDatasource(request: SaveDatasourceRequest): Promise<InvokeResult<DatasourceView>>;
  deleteDatasource(id: string): Promise<InvokeResult<null>>;
  /** Test Connection: a throwaway engine connects once; stored secrets are merged in main. */
  testDatasource(request: SaveDatasourceRequest): Promise<InvokeResult<ProbeResult>>;
  /** Reads a pasted connection URL with the plugin's manifest (decision 055); fails with what it expected. */
  parseDatasourceUrl(pluginId: string, url: string): Promise<InvokeResult<ParsedUrl>>;
  /** The saved data source as a connection URL, without its secrets, for Copy as URL. */
  datasourceUrl(id: string): Promise<InvokeResult<string>>;
  listPlugins(): Promise<InvokeResult<readonly PluginInfo[]>>;
  pluginsState(): Promise<InvokeResult<PluginsState>>;
  /** Downloads the catalog plugin's newest compatible version; resolves once it is installed or failed. */
  installPlugin(pluginId: string): Promise<InvokeResult<PluginsState>>;
  /** The native open dialog for a `.tgz`, then the trust confirmation (decision 006), then the install. */
  installPluginFile(): Promise<InvokeResult<InstallFileResult>>;
  /** Refused while a saved data source uses the plugin. */
  removePlugin(pluginId: string): Promise<InvokeResult<PluginsState>>;
  onPluginsChanged(listener: (state: PluginsState) => void): () => void;
  /**
   * Starts or reuses the datasource's engine. On `connected`, the port arrives as a window
   * message of kind `ENGINE_PORT_WINDOW_MESSAGE` naming the datasource. `secrets` carries what
   * the user typed after `needsSecrets`.
   */
  connectEngine(datasourceId: string, secrets?: Readonly<Record<string, string>>): Promise<InvokeResult<ConnectResult>>;
  /** Stops the datasource's engine; its sessions close and its ports go dead. */
  disconnectEngine(datasourceId: string): Promise<InvokeResult<null>>;
  /** The native open dialog, for a `file` connection field; null when cancelled. */
  chooseFile(title: string): Promise<InvokeResult<string | null>>;
  /** The native open dialog for an existing file to import (plan 021); null when cancelled. */
  openFile(title: string): Promise<InvokeResult<string | null>>;
  /** The native open dialog for any file, to load into a binary cell (plan 043); null when cancelled. */
  openAnyFile(title: string): Promise<InvokeResult<string | null>>;
  /** The native save dialog, for an export; the chosen absolute path, or null when cancelled. */
  saveFile(title: string, defaultName: string): Promise<InvokeResult<string | null>>;
  /** Shows an absolute path selected in the file manager: an export's file (decision 040). */
  revealFile(path: string): Promise<InvokeResult<null>>;
  /** The console names saved for the datasource, sorted (plan 006). */
  listConsoles(datasourceId: string): Promise<InvokeResult<readonly string[]>>;
  /** A saved console's text; null when none of that name is saved. */
  readConsole(datasourceId: string, name: string): Promise<InvokeResult<string | null>>;
  writeConsole(datasourceId: string, name: string, text: string): Promise<InvokeResult<null>>;
  deleteConsole(datasourceId: string, name: string): Promise<InvokeResult<null>>;
  /** Renames a saved console; fails naming the pattern a name must match, or when the name is taken. */
  renameConsole(datasourceId: string, from: string, to: string): Promise<InvokeResult<null>>;
  /** The absolute path of a scratch console's file, for Copy Path and Reveal in Finder; fails on a name main refuses. */
  consolePath(datasourceId: string, name: string): Promise<InvokeResult<string>>;
  /** The native open dialog for `.sql` files, several at once; empty when cancelled. */
  chooseSqlFiles(title: string): Promise<InvokeResult<readonly string[]>>;
  /** Reads a SQL file for a file console, with its remembered attachment, and makes it the most recent. */
  openSqlFile(path: string): Promise<InvokeResult<SqlFileOpened>>;
  /** Rereads a file console's file, after a change on disk or at launch; the recent list stays as it is. */
  readSqlFile(path: string): Promise<InvokeResult<SqlFileOpened>>;
  writeSqlFile(
    path: string,
    sql: string,
    lineEnding: LineEnding,
  ): Promise<InvokeResult<{ readonly modifiedAt: number }>>;
  /** Renames the file in its folder; the new absolute path. */
  renameSqlFile(path: string, name: string): Promise<InvokeResult<{ readonly path: string }>>;
  /** Each file's modification time, or null when it is gone. */
  statSqlFiles(paths: readonly string[]): Promise<InvokeResult<readonly (number | null)[]>>;
  attachSqlFile(path: string, attachment: FileAttachment): Promise<InvokeResult<null>>;
  /** The recent SQL files, most recent first. */
  recentSqlFiles(): Promise<InvokeResult<readonly string[]>>;
  /** Calls `listener` with the path of each File → Recent Files item picked. */
  onOpenRecentFile(listener: (path: string) => void): () => void;
  /** Appends one run to the datasource's query history (decision 030). */
  historyRecord(entry: HistoryEntry): Promise<InvokeResult<null>>;
  /** The datasource's distinct statements containing `query`, case-insensitively, newest first. */
  historySearch(datasourceId: string, query: string): Promise<InvokeResult<readonly HistoryStatement[]>>;
  historyClear(datasourceId: string): Promise<InvokeResult<null>>;
  onDatasourcesChanged(listener: (list: DatasourceList) => void): () => void;
  onEngineExited(listener: (exited: EngineExited) => void): () => void;
  /** Calls `listener` with the action id of each native menu item picked; returns the unsubscribe. */
  onInvokeAction(listener: (actionId: string) => void): () => void;
  /** Main holds a close or quit until `answerClose`; returns the unsubscribe. */
  onCloseRequested(listener: () => void): () => void;
  /** Lets the held close go ahead, or keeps the window open. */
  answerClose(proceed: boolean): Promise<InvokeResult<null>>;
  /** Main holds an SSH connection on an unknown host key until `answerHostKey`; returns the unsubscribe. */
  onHostKeyPrompt(listener: (prompt: HostKeyPrompt) => void): () => void;
  answerHostKey(requestId: number, trust: boolean): Promise<InvokeResult<null>>;
  readSettings(): Promise<InvokeResult<SettingsSnapshot>>;
  readSnippets(): Promise<InvokeResult<readonly TextSnippet[]>>;
  saveSnippet(snippet: TextSnippet): Promise<InvokeResult<readonly TextSnippet[]>>;
  deleteSnippet(id: string): Promise<InvokeResult<readonly TextSnippet[]>>;
  importSnippets(): Promise<InvokeResult<readonly TextSnippet[]>>;
  exportSnippets(snippets: readonly TextSnippet[]): Promise<InvokeResult<null>>;
  onSnippetsChanged(listener: (snippets: readonly TextSnippet[]) => void): () => void;
  appInfo(): Promise<InvokeResult<AppInfo>>;
  /** Saves the whole document; every window, this one included, hears it on `onSettingsChanged`. */
  writeSettings(settings: Settings): Promise<InvokeResult<null>>;
  /** Rereads `<userData>/themes/`; every window hears the list on `onSettingsChanged`. */
  reloadThemes(): Promise<InvokeResult<null>>;
  /** Creates the themes folder if missing and opens it in the file manager. */
  openThemesFolder(): Promise<InvokeResult<null>>;
  onSettingsChanged(listener: (changed: SettingsChanged) => void): () => void;
  /** Pops the application menu at `point` in this window (Windows and Linux, decision 034). */
  popupMenu(point: MenuPoint): Promise<InvokeResult<null>>;
  windowState(): Promise<InvokeResult<WindowState>>;
  onWindowState(listener: (state: WindowState) => void): () => void;
  /** Quits through the close guard (decision 024) and starts the app again; a refused close stays. */
  relaunch(): Promise<InvokeResult<null>>;
  /** Hands main a batch of the renderer's records; main sets their process and filters by level (plan 017). */
  logWrite(records: readonly LogRecord[]): Promise<InvokeResult<null>>;
  /** The newest records across the log files, newest first. */
  logRead(): Promise<InvokeResult<readonly LogRecord[]>>;
  /** Shows the log file in Finder or Explorer. */
  logReveal(): Promise<InvokeResult<null>>;
  onLogAppended(listener: (records: readonly LogRecord[]) => void): () => void;
  /** Asks for a path, then writes the diagnostics zip there; the path written, or null when cancelled. */
  exportDiagnostics(): Promise<InvokeResult<string | null>>;
  updateState(): Promise<InvokeResult<UpdateState>>;
  onUpdateState(listener: (state: UpdateState) => void): () => void;
  /** Help → Check for Updates: checks now, even a skipped version, and answers with the state it ends in. */
  updateCheck(): Promise<InvokeResult<UpdateState>>;
  updateDownload(): Promise<InvokeResult<null>>;
  updateCancel(): Promise<InvokeResult<null>>;
  /** Restart to Update: quits through the close guard, swaps in the staged version and starts it. */
  updateInstall(): Promise<InvokeResult<null>>;
  /** Skip This Version: remembered, so automatic checks stay quiet about it. */
  updateSkip(): Promise<InvokeResult<null>>;
  /** Clears an error or a not-installable notice until the next check. */
  updateDismiss(): Promise<InvokeResult<null>>;
  /** Opens the offered release's notes page in the browser. */
  updateOpenNotes(): Promise<InvokeResult<null>>;
  /** Looks for DataGrip and TablePro on this machine (plan 035); reads files, asks no keychain. */
  importScan(): Promise<InvokeResult<readonly ImportSource[]>>;
  importPreview(request: ImportPreviewRequest): Promise<InvokeResult<ImportPreview>>;
  /** Imports the ticked rows; progress arrives through `onImportProgress`. */
  importRun(request: ImportRunRequest): Promise<InvokeResult<ImportSummary>>;
  /** Stops a running import before its next connection. */
  importCancel(): Promise<InvokeResult<null>>;
  onImportProgress(listener: (progress: ImportProgress) => void): () => void;
  /** Settings › MCP Server's access column; refuses to raise a production-coloured datasource past Read only. */
  setAgentAccess(datasourceId: string, access: AgentAccess): Promise<InvokeResult<null>>;
  setAgentPolicy(datasourceId: string, policy: AgentPolicy): Promise<InvokeResult<null>>;
  /**
   * Remembers the product and limits a connection reported (decision 131); nothing is written or
   * broadcast when they are unchanged and were seen within a day.
   */
  rememberServer(datasourceId: string, seen: ServerSeen): Promise<InvokeResult<null>>;
  mcpCopyToken(): Promise<InvokeResult<null>>;
  /** Answers main's `onMcpContextRequest`; null when no console is focused. */
  mcpContextReply(requestId: number, context: McpActiveConsole | null): Promise<InvokeResult<null>>;
  onMcpContextRequest(listener: (request: McpContextRequest) => void): () => void;
  onMcpOpenConsole(listener: (request: McpConsoleRequest) => void): () => void;
  mcpStatus(): Promise<InvokeResult<McpStatus>>;
  onMcpStatus(listener: (status: McpStatus) => void): () => void;
  mcpControl(control: McpUserControl): Promise<InvokeResult<null>>;
  /** Puts the client's config, with the real token, on the clipboard; the token never reaches a window. */
  mcpCopyClientConfig(client: McpClient): Promise<InvokeResult<null>>;
  /** A new token; connected clients are dropped and must be configured again. */
  mcpRegenerateToken(): Promise<InvokeResult<null>>;
}
