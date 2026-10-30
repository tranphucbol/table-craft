import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants as fsConstants, existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, release } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  MessageChannelMain,
  net,
  nativeTheme,
  safeStorage,
  screen,
  shell,
  utilityProcess,
  type OpenDialogOptions,
  type SaveDialogOptions,
  type UtilityProcess,
  type WebContents,
} from "electron";
import { createKnownHosts, expandHome, openQueryHistory, type HistoryRun } from "@table-craft/core";
import { windowChrome } from "@table-craft/desktop/main/chrome.js";
import { createCloseGuard } from "@table-craft/desktop/main/closeGuard.js";
import { createConsoleFiles, type DirectoryFileSystem } from "@table-craft/desktop/main/consoleFiles.js";
import { datasourceFromEnvironment } from "@table-craft/desktop/main/datasource.js";
import { createDatasourceStore } from "@table-craft/desktop/main/datasources.js";
import { createHostKeyService } from "@table-craft/desktop/main/hostKeys.js";
import { createHostRegistry, type EngineProcess } from "@table-craft/desktop/main/hosts.js";
import { createImporter } from "@table-craft/desktop/main/import/importer.js";
import { createCredentialReader, runCommand } from "@table-craft/desktop/main/import/keychain.js";
import { nodeImportFiles } from "@table-craft/desktop/main/import/nodeFiles.js";
import { parseTableProDefaults, TABLEPRO_DEFAULTS_DOMAIN } from "@table-craft/desktop/main/import/tablepro.js";
import { registerIpc } from "@table-craft/desktop/main/ipc.js";
import {
  createMcpSupervisor,
  isMcpEngineTarget,
  MCP_LOG_PROCESS,
  newMcpToken,
  type McpEngineTarget,
  type McpProcess,
  type McpSupervisor,
} from "@table-craft/desktop/main/mcp.js";
import { PrivateOperations } from "@table-craft/desktop/main/privateOperations.js";
import { createSnippetsService } from "@table-craft/desktop/main/snippets.js";
import type { TextSnippet } from "@table-craft/desktop/snippets/snippets.js";
import {
  DIAGNOSTICS_HISTORY_RUNS,
  diagnosticsEntries,
  diagnosticsFileName,
} from "@table-craft/desktop/main/log/diagnostics.js";
import { createLogHub } from "@table-craft/desktop/main/log/hub.js";
import { readLogFile, readRecent } from "@table-craft/desktop/main/log/read.js";
import { createRedactor, isSecretKey } from "@table-craft/desktop/main/log/redact.js";
import { readLogRecord } from "@table-craft/desktop/main/log/schema.js";
import { createLogWriter, LOG_DIRECTORY, nodeLogFiles } from "@table-craft/desktop/main/log/writer.js";
import { zip } from "@table-craft/desktop/main/log/zip.js";
import { installApplicationMenu } from "@table-craft/desktop/main/menu.js";
import { FILE_ATTACHMENTS_FILE, createFileAttachments } from "@table-craft/desktop/main/fileAttachments.js";
import { createSqlFileChannels } from "@table-craft/desktop/main/sqlFiles.js";
import { createLoneAlt, menuButtonAnchor, popupApplicationMenu } from "@table-craft/desktop/main/menuPopup.js";
import { appPaths } from "@table-craft/desktop/main/paths.js";
import { createPluginStore, type PluginStore } from "@table-craft/desktop/main/pluginStore/electron.js";
import type { PluginReport } from "@table-craft/desktop/main/plugins.js";
import { createSecretStore, type Cipher, type SecretStore } from "@table-craft/desktop/main/secrets.js";
import { createDatasourceService } from "@table-craft/desktop/main/service.js";
import {
  createSettingsService,
  createSettingsStore,
  SETTINGS_FILE,
  type SettingsService,
} from "@table-craft/desktop/main/settings.js";
import { createThemeFolder } from "@table-craft/desktop/main/themes.js";
import { UPDATE_TEST_BUILD } from "@table-craft/desktop/main/update/build.js";
import { bundlePathFrom, type InstallFacts } from "@table-craft/desktop/main/update/eligibility.js";
import {
  drainSwapLog,
  readUpdateMemory,
  SWAP_LOG_FILE,
  UPDATE_STATE_FILE,
  writeUpdateMemory,
} from "@table-craft/desktop/main/update/memory.js";
import { CHECK_INTERVAL_MS, RELEASES_PAGE_URL, updateEndpoint } from "@table-craft/desktop/main/update/overrides.js";
import { createUpdateSchedule, type UpdateSchedule } from "@table-craft/desktop/main/update/schedule.js";
import {
  createUpdater,
  loggableUrl,
  removeLeftovers,
  UPDATE_SCOPE,
  type Updater,
} from "@table-craft/desktop/main/update/updater.js";
import type { McpConsoleRequest, McpContextRequest, McpStatus } from "@table-craft/desktop/settings/mcp.js";
import { effectiveChannel } from "@table-craft/desktop/settings/channel.js";
import { DEFAULT_REGISTRY_URL, DEFAULT_SETTINGS } from "@table-craft/desktop/settings/settings.js";
import { DENSITIES, resolveTheme, type DensityTokens, type Theme } from "@table-craft/desktop/appearance/themes.js";
import { ENGINE_PORT_MESSAGE, type DatasourceConfig, type HostKeyOffer } from "@table-craft/desktop/engine/protocol.js";
import { DEFAULT_LOG_LEVEL, enabled, LOG_READ_LIMIT, type LogRecord } from "@table-craft/desktop/log/record.js";
import {
  CHANNELS,
  type AppInfo,
  type Datasource,
  type DatasourceList,
  type EngineExited,
  type HostKeyPrompt,
  type PluginsState,
  type SettingsChanged,
  type UpdateState,
  type WindowState,
} from "@table-craft/desktop/preload/bridge.js";

/**
 * A test build is named apart, so its `safeStorage` keychain item ("<name> Safe Storage") and
 * default profile never touch a real install's (plan 020 live test).
 */
const APP_NAME = UPDATE_TEST_BUILD ? "TableCraft Update Test" : "TableCraft";
/** The profile folder keeps the name it had before the product was TableCraft (decision 037). */
const USER_DATA_DIRECTORY = UPDATE_TEST_BUILD ? "table-craft-update-test" : "table-craft";
const WINDOW_WIDTH = 1200;
const WINDOW_HEIGHT = 800;
/** macOS reads TablePro's folders from its preferences with this tool (plan 035). */
const DEFAULTS_TOOL = "/usr/bin/defaults";
/** Host keys the user trusted in TableCraft (decision 071); `~/.ssh/known_hosts` is only read. */
const KNOWN_HOSTS_FILE = "ssh_known_hosts.json";
const USER_KNOWN_HOSTS = join(".ssh", "known_hosts");
const TEMPORARY_SUFFIX = ".tmp";
const USER_DATA = "userData";
const APP_DATA = "appData";
/** A test seam: a fresh profile per launch, so layout, datasources and plugins never leak between smoke runs. */
const USER_DATA_ENV = "TABLE_CRAFT_USER_DATA";
/** Piped, so engine output reaches the log (plan 017 decision 9); mirrored to the terminal when unpackaged. */
const HOST_STDIO = "pipe";
const MAIN_PROCESS = "main";
const STDIO_SCOPE = "stdio";
/** What the terminal mirror prints: warnings and errors, so `bun run desktop` shows what it did before the log. */
const MIRROR_LEVEL = "warn";
const DIAGNOSTICS_TITLE = "Export Diagnostics";
const IMPORT_FILE_FILTERS = [
  { name: "Delimited text", extensions: ["csv", "tsv", "txt"] },
  { name: "All files", extensions: ["*"] },
];
const SQL_FILE_FILTERS = [
  { name: "SQL files", extensions: ["sql"] },
  { name: "All files", extensions: ["*"] },
];
const UTF8 = "utf8";
const MISSING_FILE = "ENOENT";
const CIPHER_ENCODING = "base64";
/** Decision 010's place for query history (decision 030). */
const HISTORY_FILE = "history.sqlite";
/**
 * Unpackaged, `app.getVersion()` is Electron's own, because `dist/main` has no package.json; a
 * packaged build carries the version from git (decision 033).
 */
const DEVELOPMENT_VERSION = "0.0.0";
const MAC_PLATFORM = "darwin";
const MCP_SERVICE_NAME = "table-craft-mcp";

// Electron reads the name from the package.json beside the entry, and `dist/main` has none; without
// this, userData and so the user plugin root would be `Electron`.
app.setName(APP_NAME);
app.setPath(USER_DATA, process.env[USER_DATA_ENV] || join(app.getPath(APP_DATA), USER_DATA_DIRECTORY));
/**
 * One instance per profile (plan 020): two would share the log file and race an update's swap.
 * Chromium keys the lock on userData, so smoke runs with their own profiles still run side by side.
 */
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.exit(0);

let settingsService: SettingsService | null = null;
let pluginStore: PluginStore | null = null;
let mcpSupervisor: McpSupervisor | null = null;

function mirrorToTerminal(record: LogRecord): void {
  if (!enabled(record.level, MIRROR_LEVEL)) return;
  const { ts: _ts, level, process: from, scope, msg, err, ...fields } = record;
  console.error(`TableCraft ${level} [${from}/${scope}] ${msg}`, fields, err?.stack ?? err?.message ?? "");
}

/** Main's one log (plan 017, decision 038); built first so a failure at launch is already written. */
const logHub = createLogHub({
  writer: createLogWriter({
    directory: join(app.getPath(USER_DATA), LOG_DIRECTORY),
    files: nodeLogFiles,
    onFailure: (cause) => console.error("TableCraft: the log could not be written; it is off until restart.", cause),
  }),
  redactor: createRedactor(),
  level: () => settingsService?.snapshot().settings.log.level ?? DEFAULT_LOG_LEVEL,
  ...(app.isPackaged ? {} : { mirror: mirrorToTerminal }),
});
const mainLog = logHub.logger(MAIN_PROCESS);
const engineLog = mainLog.child("engine");

process.on("uncaughtException", (cause) => mainLog.error("uncaught exception", { err: cause }));
process.on("unhandledRejection", (cause) => mainLog.error("unhandled rejection", { err: cause }));
app.on("render-process-gone", (_event, contents, details) => {
  mainLog
    .child("window")
    .error("renderer gone", { reason: details.reason, exitCode: details.exitCode, url: basename(contents.getURL()) });
});
app.on("child-process-gone", (_event, details) => {
  engineLog.warn("child process gone", {
    type: details.type,
    reason: details.reason,
    exitCode: details.exitCode,
    serviceName: details.serviceName ?? null,
  });
});

/** Every secret a config carries is redacted from the log from now on (plan 017 decision 5). */
function protectConfig(datasource: DatasourceConfig): void {
  const config = typeof datasource.config === "object" && datasource.config !== null ? datasource.config : {};
  const fields =
    (pluginStore?.service.plugins() ?? []).find((plugin) => plugin.id === datasource.pluginId)?.fields ?? [];
  const secret = new Set(
    fields.filter((field) => field.secret === true || field.kind === "password").map((f) => f.key),
  );
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === "string" && (secret.has(key) || isSecretKey(key))) logHub.redactor.remember(value);
  }
  for (const value of [datasource.ssh?.password, datasource.ssh?.passphrase]) {
    if (value !== undefined && value !== "") logHub.redactor.remember(value);
  }
}

/** The store, with every value it hands out or takes in remembered by the redactor. */
function protectedSecrets(store: SecretStore): SecretStore {
  return {
    ...store,
    set(datasourceId, key, mode, value) {
      logHub.redactor.remember(value);
      return store.set(datasourceId, key, mode, value);
    },
    get(datasourceId, key, mode) {
      const value = store.get(datasourceId, key, mode);
      if (value !== undefined) logHub.redactor.remember(value);
      return value;
    },
  };
}

function captureStdio(host: UtilityProcess, logProcess: string): void {
  const stdio = logHub.logger(logProcess).child(STDIO_SCOPE);
  const streams = [
    [host.stdout, "info", process.stdout],
    [host.stderr, "warn", process.stderr],
  ] as const;
  for (const [stream, level, terminal] of streams) {
    if (stream === null) continue;
    if (!app.isPackaged) stream.pipe(terminal);
    createInterface({ input: stream }).on("line", (line) => stdio[level](line));
  }
}

const ephemeral = datasourceFromEnvironment(process.env);

const paths = appPaths({
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  distDirectory: dirname(import.meta.dirname),
});
const appVersion = appVersionOf();
const appInfo: AppInfo = {
  name: APP_NAME,
  version: appVersion,
  electron: process.versions.electron,
  chromium: process.versions.chrome,
};

const files: DirectoryFileSystem = {
  async readText(path) {
    try {
      return await readFile(path, UTF8);
    } catch (error) {
      if ((error as { code?: unknown }).code === MISSING_FILE) return null;
      throw error;
    }
  },
  writeText: (path, text) => writeFile(path, text, UTF8),
  rename,
  async listNames(path) {
    try {
      return await readdir(path);
    } catch (error) {
      if ((error as { code?: unknown }).code === MISSING_FILE) return [];
      throw error;
    }
  },
  makeDirectory: async (path) => {
    await mkdir(path, { recursive: true });
  },
  remove: (path) => rm(path, { force: true }),
  removeDirectory: (path) => rm(path, { recursive: true, force: true }),
};

const cipher: Cipher = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plain) => safeStorage.encryptString(plain).toString(CIPHER_ENCODING),
  decrypt: (cipherText) => safeStorage.decryptString(Buffer.from(cipherText, CIPHER_ENCODING)),
};

type BroadcastState = DatasourceList | EngineExited | SettingsChanged | UpdateState | PluginsState | McpStatus;

function broadcast(channel: string, payload: BroadcastState | readonly (LogRecord | TextSnippet)[]): void {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send(channel, payload);
}

/** The focused window, else any; false when none is open (MCP console tools, decision 127). */
function sendToFocused(channel: string, payload: McpConsoleRequest | McpContextRequest): boolean {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (window === undefined || window.isDestroyed()) return false;
  window.webContents.send(channel, payload);
  return true;
}

let savedDatasources: () => readonly Datasource[] = () => [];
const pluginRoots = () => pluginStore?.service.roots() ?? [paths.builtInPlugins];

const hostKeyQuestions = new Map<number, (trust: boolean) => void>();
let nextHostKeyQuestion = 1;

function answerHostKey(requestId: number, trust: boolean): void {
  hostKeyQuestions.get(requestId)?.(trust);
  hostKeyQuestions.delete(requestId);
}

/** Asks the focused window, else any; with none open the key is not trusted (decision 071). */
function askHostKey(offer: HostKeyOffer): Promise<boolean> {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (window === undefined) return Promise.resolve(false);
  const requestId = nextHostKeyQuestion++;
  return new Promise((resolve) => {
    hostKeyQuestions.set(requestId, resolve);
    window.webContents.once("destroyed", () => answerHostKey(requestId, false));
    window.webContents.send(CHANNELS.hostKeyPrompt, { requestId, offer } satisfies HostKeyPrompt);
  });
}

const hostKeys = createHostKeyService({
  knownHosts: createKnownHosts({
    appFile: join(app.getPath(USER_DATA), KNOWN_HOSTS_FILE),
    userFile: homedir() === "" ? null : join(homedir(), USER_KNOWN_HOSTS),
    files: {
      readText: (path) => files.readText(path),
      async writeText(path, text) {
        await files.writeText(`${path}${TEMPORARY_SUFFIX}`, text);
        await rename(`${path}${TEMPORARY_SUFFIX}`, path);
      },
    },
  }),
  ask: askHostKey,
});

const privateOperations = new PrivateOperations<WebContents>({
  choose: (contents, operation) => {
    if (contents.isDestroyed() || BrowserWindow.fromWebContents(contents) === null)
      return Promise.reject(new Error("The requesting window is closed."));
    if (operation === "transfer.import") return openFile(contents, "Import key data", true);
    if (operation === "watch.export") return saveFile(contents, "Export retained Watch events", "watch-events.jsonl");
    return saveFile(
      contents,
      operation === "cluster.snapshot" ? "Save sensitive cluster snapshot" : "Export key data",
      operation === "cluster.snapshot" ? "snapshot.db" : "keys.tc-key-transfer",
    );
  },
  onSenderGone(contents, dispose) {
    const navigation = (_event: unknown, _url: string, isInPlace: boolean, isMainFrame: boolean) => {
      if (isMainFrame && !isInPlace) dispose();
    };
    contents.once("destroyed", dispose);
    contents.once("render-process-gone", dispose);
    contents.on("did-start-navigation", navigation);
    return () => {
      contents.removeListener("destroyed", dispose);
      contents.removeListener("render-process-gone", dispose);
      contents.removeListener("did-start-navigation", navigation);
    };
  },
});

/** An engine port goes to a window, or to the MCP host for an agent (decision 126). */
type PortTarget = WebContents | McpEngineTarget;

const hosts = createHostRegistry<PortTarget>({
  pluginRoots,
  dependencies: {
    fork: (serviceName, logProcess): EngineProcess => {
      const host: UtilityProcess = utilityProcess.fork(paths.engineEntry, [], { serviceName, stdio: HOST_STDIO });
      captureStdio(host, logProcess);
      return host;
    },
    connectPort(host, datasourceId, target) {
      const channel = new MessageChannelMain();
      const datasource = savedDatasources().find((source) => source.id === datasourceId);
      const privateFiles = !isMcpEngineTarget(target);
      const ownerId = isMcpEngineTarget(target)
        ? randomUUID()
        : privateOperations.attach(host, target, datasourceId, datasource?.readOnly ?? true);
      (host as UtilityProcess).postMessage({ kind: ENGINE_PORT_MESSAGE, ownerId, privateFiles }, [channel.port1]);
      if (isMcpEngineTarget(target)) {
        if (mcpSupervisor === null) channel.port2.close();
        else mcpSupervisor.sendPort(target, channel.port2);
      } else target.postMessage(CHANNELS.enginePort, datasourceId, [channel.port2]);
    },
    setTimeout: (run, ms) => setTimeout(run, ms),
    clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout),
  },
  onExit: (datasourceId, code, clean) => {
    broadcast(CHANNELS.engineExited, { datasourceId, code, clean });
  },
  onStopping: (datasourceId) => privateOperations.revokeDatasource(datasourceId),
  log: {
    logger: mainLog,
    forward(record, process) {
      const read = readLogRecord(record, process);
      if (read !== null) logHub.write(read);
    },
    protect: protectConfig,
  },
  hostKeys,
});

const closeGuard = createCloseGuard<BrowserWindow>({ quit: () => app.quit() });
/** Windows created with the main toolbar as their title bar; the setting is read once, at creation. */
const customTitleBars = new WeakSet<BrowserWindow>();
/** Restart Now asked to quit; `will-quit` turns it into a relaunch, a refused close cancels it. */
let relaunchRequested = false;
/** Restart to Update asked to quit; like a relaunch, a refused close cancels it (plan 020). */
let installRequested = false;
let updater: Updater | null = null;
let updateSchedule: UpdateSchedule | null = null;
const updateLog = mainLog.child(UPDATE_SCOPE, { current: appVersionOf() });

function appVersionOf(): string {
  return app.isPackaged ? app.getVersion() : DEVELOPMENT_VERSION;
}

function densityOf(settings: SettingsService): DensityTokens {
  return DENSITIES[settings.snapshot().settings.appearance.density];
}

function windowStateOf(window: BrowserWindow): WindowState {
  return { fullScreen: window.isFullScreen(), customTitleBar: customTitleBars.has(window) };
}

/**
 * The theme the settings name, made concrete, after pointing `nativeTheme` at its scheme so menus,
 * dialogs and the renderer's `prefers-color-scheme` agree (plan 013 decision 8). Only a `"system"`
 * choice reads the OS, which is why `themeSource` is set first.
 */
function applyWindowAppearance(settings: SettingsService): Theme {
  const { settings: current, themes } = settings.snapshot();
  const choice = current.appearance.theme;
  // Assigning `themeSource` emits `updated`, which calls back here; only a real change assigns.
  const pointAt = (source: typeof nativeTheme.themeSource) => {
    if (nativeTheme.themeSource !== source) nativeTheme.themeSource = source;
  };
  if (choice === "system") pointAt("system");
  const system = {
    prefersDark: nativeTheme.shouldUseDarkColors,
    prefersMoreContrast: nativeTheme.shouldUseHighContrastColors,
  };
  const { theme } = resolveTheme(choice, system, themes);
  if (choice !== "system") pointAt(theme.colorScheme);
  const chrome = windowChrome({
    platform: process.platform,
    theme,
    density: densityOf(settings),
    systemTitleBar: false,
  });
  for (const window of BrowserWindow.getAllWindows()) {
    window.setBackgroundColor(theme.colors.canvas);
    if (!customTitleBars.has(window)) continue;
    if (chrome.overlay !== null) window.setTitleBarOverlay(chrome.overlay);
    if (chrome.trafficLights !== null) window.setWindowButtonPosition(chrome.trafficLights);
  }
  return theme;
}

function createWindow(settings: SettingsService): void {
  const theme = applyWindowAppearance(settings);
  const { systemTitleBar } = settings.snapshot().settings.appearance;
  const chrome = windowChrome({ platform: process.platform, theme, density: densityOf(settings), systemTitleBar });
  const window = new BrowserWindow({
    title: APP_NAME,
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    show: false,
    // The first frame, before the renderer's bundle runs, is already the theme's canvas.
    backgroundColor: theme.colors.canvas,
    ...chrome.options,
    // macOS takes the window's icon from the app bundle, or the dock in development.
    ...(process.platform === MAC_PLATFORM ? {} : { icon: paths.icon }),
    webPreferences: {
      preload: paths.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  if (!systemTitleBar) customTitleBars.add(window);
  if (!systemTitleBar && process.platform !== MAC_PLATFORM) {
    window.setMenuBarVisibility(false);
    const loneAlt = createLoneAlt();
    window.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown" && input.type !== "keyUp") return;
      if (!loneAlt.input({ type: input.type, key: input.key })) return;
      event.preventDefault();
      popupApplicationMenu(Menu.getApplicationMenu(), window, menuButtonAnchor(densityOf(settings)));
    });
    window.on("blur", () => loneAlt.reset());
  }
  const sendState = () => window.webContents.send(CHANNELS.windowState, windowStateOf(window));
  window.on("enter-full-screen", sendState);
  window.on("leave-full-screen", sendState);
  window.once("ready-to-show", () => {
    window.show();
    updateSchedule?.start();
    pluginStore?.startBackground();
  });
  closeGuard.guard(window);
  window.on("closed", () => mcpSupervisor?.windowsChanged());
  mcpSupervisor?.windowsChanged();
  void window.loadFile(paths.rendererIndex);
}

async function saveFile(contents: WebContents, title: string, defaultName: string): Promise<string | null> {
  const parent = BrowserWindow.fromWebContents(contents);
  const options: SaveDialogOptions = { title, defaultPath: defaultName, properties: ["createDirectory"] };
  const picked = parent === null ? await dialog.showSaveDialog(options) : await dialog.showSaveDialog(parent, options);
  return picked.canceled || picked.filePath === "" ? null : picked.filePath;
}

async function chooseFile(contents: WebContents, title: string): Promise<string | null> {
  const parent = BrowserWindow.fromWebContents(contents);
  const options: OpenDialogOptions = { title, properties: ["openFile", "promptToCreate"] };
  const picked = parent === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(parent, options);
  return picked.canceled ? null : (picked.filePaths[0] ?? null);
}

/** The open dialog for one existing file: one to import, or with `anyFile` one to load into a binary cell. */
async function openFile(contents: WebContents, title: string, anyFile = false): Promise<string | null> {
  const parent = BrowserWindow.fromWebContents(contents);
  const options: OpenDialogOptions = {
    title,
    properties: ["openFile"],
    ...(anyFile ? {} : { filters: IMPORT_FILE_FILTERS }),
  };
  const picked = parent === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(parent, options);
  return picked.canceled ? null : (picked.filePaths[0] ?? null);
}

async function chooseSqlFiles(contents: WebContents, title: string): Promise<readonly string[]> {
  const parent = BrowserWindow.fromWebContents(contents);
  const options: OpenDialogOptions = { title, properties: ["openFile", "multiSelections"], filters: SQL_FILE_FILTERS };
  const picked = parent === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(parent, options);
  return picked.canceled ? [] : picked.filePaths;
}

function menuTarget(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
}

/** Pushes written records to every window's Log tool window, one message per turn rather than per record. */
function forwardAppendedRecords(): void {
  let pending: LogRecord[] = [];
  logHub.subscribe((record) => {
    if (pending.length === 0) {
      setImmediate(() => {
        const batch = pending;
        pending = [];
        broadcast(CHANNELS.logAppended, batch);
      });
    }
    pending.push(record);
  });
}

function aboutReport(plugins: readonly PluginReport[]): unknown {
  return {
    ...appInfo,
    node: process.versions.node,
    platform: process.platform,
    osRelease: release(),
    arch: process.arch,
    locale: app.getLocale(),
    packaged: app.isPackaged,
    plugins,
    displays: screen.getAllDisplays().map((display) => ({
      width: display.size.width,
      height: display.size.height,
      scaleFactor: display.scaleFactor,
    })),
    generatedAt: new Date().toISOString(),
  };
}

interface DiagnosticsInputs {
  readonly about: () => unknown;
  readonly settingsPath: string;
  readonly datasources: () => readonly Datasource[];
  readonly runs: () => readonly HistoryRun[];
}

/** Help → Export Diagnostics (plan 017 decision 10): the path written, or null when the dialog was cancelled. */
async function exportDiagnostics(sender: WebContents, inputs: DiagnosticsInputs): Promise<string | null> {
  const log = mainLog.child("diagnostics");
  const path = await saveFile(sender, DIAGNOSTICS_TITLE, diagnosticsFileName(new Date()));
  if (path === null) return null;
  log.info("diagnostics export started");
  await logHub.writer.drain();
  const logs = [];
  for (const file of [...logHub.writer.paths].reverse()) {
    const text = await readLogFile(file);
    if (text !== null) logs.push({ name: basename(file), text });
  }
  const entries = diagnosticsEntries({
    logs,
    about: inputs.about(),
    settings: await files.readText(inputs.settingsPath),
    datasources: inputs.datasources(),
    plugins: pluginStore?.service.plugins() ?? [],
    runs: inputs.runs(),
    redactor: logHub.redactor,
  });
  const archive = zip(entries, new Date());
  await writeFile(path, archive);
  log.info("diagnostics exported", { path, bytes: archive.length, entries: entries.map((entry) => entry.name) });
  return path;
}

function writableDirectory(directory: string): boolean {
  try {
    accessSync(directory, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function runToCompletion(command: string, args: readonly string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    execFile(command, [...args], (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
      resolve({ code, output: `${stdout}${stderr}`.trim() });
    });
  });
}

/** The updater and its schedule (plan 020); its state goes to every window on `CHANNELS.updateState`. */
async function startUpdater(directory: string, settings: SettingsService): Promise<Updater> {
  await drainSwapLog(join(directory, SWAP_LOG_FILE), files, updateLog.child(UPDATE_SCOPE, { step: "swap" }));
  const endpoint = updateEndpoint(process.env, !app.isPackaged || UPDATE_TEST_BUILD, (path) =>
    readFileSync(path, UTF8),
  );
  if (endpoint.overridden) {
    updateLog.warn("update endpoint overridden for testing", {
      manifestUrl: loggableUrl(endpoint.manifestUrl),
      betaManifestUrl: loggableUrl(endpoint.betaManifestUrl),
      testBuild: UPDATE_TEST_BUILD,
    });
  }
  const facts: InstallFacts = {
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
    currentVersion: appVersion,
    executablePath: process.execPath,
    appImagePath: process.env.APPIMAGE,
    writable: writableDirectory,
  };
  const statePath = join(directory, UPDATE_STATE_FILE);
  const created = createUpdater({
    currentVersion: appVersion,
    manifestUrls: { stable: endpoint.manifestUrl, beta: endpoint.betaManifestUrl },
    channel: () => effectiveChannel(settings.snapshot().settings.updates.channel, appVersion),
    trust: endpoint.trust,
    facts,
    tempDirectory: app.getPath("temp"),
    swapLogPath: join(directory, SWAP_LOG_FILE),
    pid: process.pid,
    relaunchArgs: process.argv.slice(1),
    fetch: (url, init) => net.fetch(url, { signal: init.signal }),
    run: runToCompletion,
    spawnDetached(command, args) {
      spawn(command, [...args], { detached: true, stdio: "ignore" }).unref();
    },
    readMemory: async () => readUpdateMemory(await files.readText(statePath)),
    writeMemory: (memory) => files.writeText(statePath, writeUpdateMemory(memory)),
    onState: (state) => broadcast(CHANNELS.updateState, state),
    log: updateLog,
    newId: randomUUID,
  });
  const bundlePath = process.platform === MAC_PLATFORM && app.isPackaged ? bundlePathFrom(process.execPath) : null;
  if (bundlePath !== null) await removeLeftovers({ kind: "macBundle", bundlePath }, updateLog);
  // A development run checks on its own only when pointed at a test release.
  const automaticAllowed = app.isPackaged || endpoint.overridden;
  updateSchedule = createUpdateSchedule({
    check: () => void created.check("automatic"),
    enabled: automaticAllowed && settings.snapshot().settings.updates.checkAutomatically,
    firstDelayMs: endpoint.firstCheckMs,
    intervalMs: CHECK_INTERVAL_MS,
    timers: {
      setTimeout: (run, ms) => setTimeout(run, ms),
      clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout),
      setInterval: (run, ms) => setInterval(run, ms),
      clearInterval: (timer) => clearInterval(timer as NodeJS.Timeout),
    },
  });
  const allowAutomatic = automaticAllowed;
  settingsListeners.push((changed) => updateSchedule?.setEnabled(allowAutomatic && changed.updates.checkAutomatically));
  return created;
}

/** Called with the saved settings after every write; the updater's schedule listens. */
const settingsListeners: ((settings: SettingsChanged["settings"]) => void)[] = [];

app.on("second-instance", () => {
  const [window] = BrowserWindow.getAllWindows();
  if (window === undefined) return;
  if (window.isMinimized()) window.restore();
  window.focus();
});

void app.whenReady().then(async () => {
  if (!primaryInstance) return;
  app.setAboutPanelOptions({ applicationName: APP_NAME, applicationVersion: appVersion });
  if (process.platform === MAC_PLATFORM && !app.isPackaged) app.dock?.setIcon(paths.icon);
  const directory = app.getPath(USER_DATA);
  const consoles = createConsoleFiles({ directory, files });
  const attachments = createFileAttachments({ path: join(directory, FILE_ATTACHMENTS_FILE), files });
  await mkdir(directory, { recursive: true });
  mainLog.info("TableCraft started", {
    version: appVersion,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    osRelease: release(),
    arch: process.arch,
    locale: app.getLocale(),
    packaged: app.isPackaged,
    userData: directory,
  });
  const history = openQueryHistory(join(directory, HISTORY_FILE));
  if (history.recoveredFrom !== null) {
    mainLog
      .child("history")
      .warn("history file unreadable; moved aside", { file: HISTORY_FILE, movedTo: history.recoveredFrom });
  }
  app.on("will-quit", () => history.close());
  const plugins = createPluginStore({
    userData: directory,
    builtInRoot: paths.builtInPlugins,
    developmentRoot: paths.developmentPlugins,
    packaged: app.isPackaged,
    environment: process.env,
    registryUrl: () => settingsService?.snapshot().settings.plugins.registryUrl ?? DEFAULT_REGISTRY_URL,
    channel: () =>
      effectiveChannel(
        settingsService?.snapshot().settings.updates.channel ?? DEFAULT_SETTINGS.updates.channel,
        appVersion,
      ),
    checkAutomatically: () => settingsService?.snapshot().settings.updates.checkAutomatically ?? true,
    datasources: () => savedDatasources(),
    onChanged: (state) => broadcast(CHANNELS.pluginsChanged, state),
    log: mainLog.child("plugins"),
  });
  pluginStore = plugins;
  await plugins.start();
  // safeStorage answers only once the app is ready.
  const secrets = protectedSecrets(await createSecretStore({ directory, files, cipher }));
  const service = await createDatasourceService<PortTarget>({
    store: createDatasourceStore({ directory, files }),
    secrets,
    hosts,
    plugins: () => plugins.service.plugins(),
    ephemeral,
    newId: randomUUID,
    consoles,
    history,
    onChanged(list) {
      broadcast(CHANNELS.datasourcesChanged, list);
      mcpSupervisor?.datasourcesChanged();
    },
    readKeyFile: (path) => files.readText(expandHome(path)).catch(() => null),
  });
  savedDatasources = () => service.list().datasources;
  const importer = createImporter({
    environment: {
      platform: process.platform,
      home: homedir(),
      appData: process.env.APPDATA ?? null,
      files: nodeImportFiles,
    },
    credentials: createCredentialReader({ platform: process.platform, run: runCommand }),
    async tableProGroups() {
      if (process.platform !== "darwin") return [];
      const exported = await runCommand(DEFAULTS_TOOL, ["export", TABLEPRO_DEFAULTS_DOMAIN, "-"]);
      return exported.code === 0 ? parseTableProDefaults(exported.stdout) : [];
    },
    service,
    log: mainLog.child("import"),
  });
  const themes = createThemeFolder({ directory, files });
  const settings: SettingsService = await createSettingsService({
    store: createSettingsStore({ directory, files }),
    themes,
    onChanged(changed) {
      applyWindowAppearance(settings);
      broadcast(CHANNELS.settingsChanged, changed);
      for (const listener of settingsListeners) listener(changed.settings);
      plugins.setAutomatic(changed.settings.updates.checkAutomatically);
    },
  });
  settingsService = settings;
  const settingsWarning = settings.snapshot().warning;
  if (settingsWarning !== null) mainLog.child("settings").warn("settings file set aside", { warning: settingsWarning });
  const datasourcesWarning = service.list().warning;
  if (datasourcesWarning !== null)
    mainLog.child("datasources").warn("datasources file set aside", { warning: datasourcesWarning });
  forwardAppendedRecords();
  const mcp = createMcpSupervisor({
    fork(): McpProcess {
      const host = utilityProcess.fork(paths.mcpEntry, [], { serviceName: MCP_SERVICE_NAME, stdio: HOST_STDIO });
      captureStdio(host, MCP_LOG_PROCESS);
      return host;
    },
    settings: () => settings.snapshot().settings.mcp,
    datasources: () => service.list().datasources,
    secrets,
    connect: (datasourceId, target) => service.connect(datasourceId, {}, target),
    history,
    rememberServer: (datasourceId, seen) => service.rememberServer(datasourceId, seen),
    onStatus: (status) => broadcast(CHANNELS.mcpStatus, status),
    forward(record, process) {
      const read = readLogRecord(record, process);
      if (read !== null) logHub.write(read);
    },
    windowsOpen: () => BrowserWindow.getAllWindows().some((window) => !window.isDestroyed()),
    writeClipboard: (text) => clipboard.writeText(text),
    openConsole: (request) => sendToFocused(CHANNELS.mcpOpenConsole, request),
    askContext: (requestId) => sendToFocused(CHANNELS.mcpContextRequest, { requestId }),
    newToken: newMcpToken,
    serverVersion: appVersion,
    log: mainLog.child(MCP_LOG_PROCESS),
  });
  mcpSupervisor = mcp;
  settingsListeners.push((changed) => void mcp.settingsChanged(changed.mcp));
  const updates = await startUpdater(directory, settings);
  updater = updates;
  nativeTheme.on("updated", () => {
    if (settings.snapshot().settings.appearance.theme === "system") applyWindowAppearance(settings);
  });
  registerIpc<WebContents>(ipcMain, {
    service,
    consoles,
    sqlFiles: createSqlFileChannels<WebContents>({
      attachments,
      choose: chooseSqlFiles,
      recentChanged: (recent) => installApplicationMenu(menuTarget, recent),
    }),
    history,
    settings,
    snippets: createSnippetsService({
      directory,
      files,
      onChanged: (snippets) => broadcast(CHANNELS.snippetsChanged, snippets),
    }),
    async openThemesFolder() {
      await files.makeDirectory(themes.path);
      const failure = await shell.openPath(themes.path);
      if (failure !== "") throw new Error(`${themes.path} could not be opened: ${failure}`);
    },
    chooseFile,
    openFile: (contents, title) => openFile(contents, title),
    openAnyFile: (contents, title) => openFile(contents, title, true),
    saveFile,
    revealFile: (path) => shell.showItemInFolder(path),
    answerHostKey,
    answerClose(sender, proceed) {
      const window = BrowserWindow.fromWebContents(sender);
      if (!proceed) {
        relaunchRequested = false;
        installRequested = false;
      }
      if (window !== null) closeGuard.answer(window, proceed);
    },
    appInfo: () => appInfo,
    popupMenu(sender, point) {
      const window = BrowserWindow.fromWebContents(sender);
      if (window !== null) popupApplicationMenu(Menu.getApplicationMenu(), window, point);
    },
    windowState(sender) {
      const window = BrowserWindow.fromWebContents(sender);
      return window === null ? { fullScreen: false, customTitleBar: false } : windowStateOf(window);
    },
    relaunch() {
      relaunchRequested = true;
      app.quit();
    },
    log: mainLog.child("ipc"),
    logs: {
      write: (records) => {
        for (const record of records) logHub.write(record);
      },
      async read() {
        await logHub.writer.drain();
        return readRecent(logHub.writer.paths, LOG_READ_LIMIT);
      },
      reveal() {
        const [current] = logHub.writer.paths;
        if (current !== undefined && existsSync(current)) shell.showItemInFolder(current);
        else void shell.openPath(logHub.writer.directory);
      },
      exportDiagnostics: (sender) =>
        exportDiagnostics(sender, {
          about: () => aboutReport(plugins.service.report()),
          settingsPath: join(directory, SETTINGS_FILE),
          datasources: () => service.list().datasources,
          runs: () => history.recentRuns(DIAGNOSTICS_HISTORY_RUNS),
        }),
    },
    importer: {
      scan: () => importer.scan(),
      preview: (request) => importer.preview(request),
      run: (request, sender) =>
        importer.run(request, (progress) => {
          if (!sender.isDestroyed()) sender.send(CHANNELS.importProgress, progress);
        }),
      cancel: () => importer.cancel(),
    },
    plugins: plugins.channels,
    mcp: {
      status: () => mcp.status(),
      control: (control) => mcp.control(control),
      copyClientConfig: (client) => mcp.copyClientConfig(client),
      regenerateToken: () => mcp.regenerateToken(),
      copyToken: () => mcp.copyToken(),
      contextReply: (requestId, context) => mcp.contextReply(requestId, context),
    },
    updates: {
      state: () => updates.state(),
      check: () => updates.check("manual"),
      download() {
        void updates.download();
      },
      cancel: () => updates.cancel(),
      install() {
        if (!updates.ready()) return;
        installRequested = true;
        app.quit();
      },
      skip: () => updates.skip(),
      dismiss: () => updates.dismiss(),
      openNotes() {
        void shell.openExternal(updates.notesUrl() ?? RELEASES_PAGE_URL);
      },
    },
  });
  privateOperations.register({
    handle(channel, listener) {
      ipcMain.handle(channel, (event, payload: unknown) => {
        if (
          event.senderFrame !== event.sender.mainFrame ||
          event.sender.isDestroyed() ||
          BrowserWindow.fromWebContents(event.sender) === null
        ) {
          return {
            ok: false,
            error: { message: "The requesting window is not authorized.", hint: "Reconnect before trying again." },
          };
        }
        return listener(event, payload);
      });
    },
  });
  installApplicationMenu(menuTarget, await attachments.recent());
  createWindow(settings);
  void mcp.start();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(settings);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== MAC_PLATFORM) app.quit();
});

app.on("before-quit", () => closeGuard.beforeQuit());

app.on("will-quit", (event) => {
  privateOperations.close();
  hosts.closeAll();
  void mcpSupervisor?.stop();
  updateSchedule?.stop();
  pluginStore?.stop();
  const pending = updater;
  if (pending !== null && (installRequested || pending.holdsFiles())) {
    // The swap or the cleanup is asynchronous; quitting waits for it, then exits for good.
    event.preventDefault();
    void finishUpdate(pending, installRequested).finally(() => app.exit(0));
    return;
  }
  // Scheduled only now that every window has agreed to close, so a refused close never relaunches later.
  if (relaunchRequested) app.relaunch();
});

/** Hands the staged update over on Restart to Update; otherwise removes whatever was staged. */
async function finishUpdate(pending: Updater, install: boolean): Promise<void> {
  try {
    if (!install) {
      await pending.discard();
      if (relaunchRequested) app.relaunch();
      return;
    }
    const outcome = await pending.install();
    if (outcome.relaunch === "self") app.relaunch({ execPath: outcome.executable, args: process.argv.slice(1) });
    if (outcome.relaunch === "none" && relaunchRequested) app.relaunch();
  } catch (cause) {
    updateLog.error("update could not be installed", { err: cause });
  } finally {
    await logHub.writer.drain();
  }
}
