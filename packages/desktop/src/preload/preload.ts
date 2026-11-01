import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  BRIDGE_KEY,
  CHANNELS,
  ENGINE_PORT_WINDOW_MESSAGE,
  INVOKE_CHANNELS,
  type DatasourceList,
  type EnginePortWindowMessage,
  type EngineExited,
  type ImportProgress,
  type HostKeyPrompt,
  type InvokeResult,
  type PluginsState,
  type SettingsChanged,
  type TableCraftBridge,
  type UpdateState,
  type WindowState,
} from "@table-craft/desktop/preload/bridge.js";
import type { LogRecord } from "@table-craft/desktop/log/record.js";
import type { McpConsoleRequest, McpContextRequest, McpStatus } from "@table-craft/desktop/settings/mcp.js";
import type { TextSnippet } from "@table-craft/desktop/snippets/snippets.js";

/** Structural, because this program has no DOM lib and preload is the one place that needs it. */
interface TransferringWindow {
  postMessage(message: unknown, targetOrigin: string, transfer: readonly unknown[]): void;
}

interface PortCarryingEvent {
  readonly ports: readonly unknown[];
}

const WINDOW_TARGET_ORIGIN = "*";

ipcRenderer.on(CHANNELS.enginePort, (event: IpcRendererEvent, datasourceId: unknown) => {
  const port = (event as unknown as PortCarryingEvent).ports[0];
  if (port === undefined || typeof datasourceId !== "string") return;
  const message: EnginePortWindowMessage = { kind: ENGINE_PORT_WINDOW_MESSAGE, datasourceId };
  (globalThis as unknown as TransferringWindow).postMessage(message, WINDOW_TARGET_ORIGIN, [port]);
});

function invoke<T>(channel: string, ...args: unknown[]): Promise<InvokeResult<T>> {
  return ipcRenderer.invoke(channel, ...args) as Promise<InvokeResult<T>>;
}

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const relay = (_event: IpcRendererEvent, payload: T) => listener(payload);
  ipcRenderer.on(channel, relay);
  return () => ipcRenderer.off(channel, relay);
}

const bridge: TableCraftBridge = {
  chooseOperationFile: (datasourceId, operation) =>
    invoke(INVOKE_CHANNELS.chooseOperationFile, { datasourceId, operation }),
  applyAccessSecret: (request) => invoke(INVOKE_CHANNELS.applyAccessSecret, request),
  listDatasources: () => invoke(INVOKE_CHANNELS.listDatasources),
  saveDatasource: (request) => invoke(INVOKE_CHANNELS.saveDatasource, request),
  deleteDatasources: (request) => invoke(INVOKE_CHANNELS.deleteDatasources, request),
  moveDatasources: (request) => invoke(INVOKE_CHANNELS.moveDatasources, request),
  createDatasourceFolder: (path) => invoke(INVOKE_CHANNELS.createDatasourceFolder, { path }),
  testDatasource: (request) => invoke(INVOKE_CHANNELS.testDatasource, request),
  parseDatasourceUrl: (pluginId, url) => invoke(INVOKE_CHANNELS.parseDatasourceUrl, { pluginId, url }),
  datasourceUrl: (id) => invoke(INVOKE_CHANNELS.datasourceUrl, { id }),
  listPlugins: () => invoke(INVOKE_CHANNELS.listPlugins),
  pluginsState: () => invoke(INVOKE_CHANNELS.pluginsState),
  installPlugin: (pluginId) => invoke(INVOKE_CHANNELS.installPlugin, { pluginId }),
  installPluginFile: () => invoke(INVOKE_CHANNELS.installPluginFile),
  removePlugin: (pluginId) => invoke(INVOKE_CHANNELS.removePlugin, { pluginId }),
  onPluginsChanged: (listener) => subscribe<PluginsState>(CHANNELS.pluginsChanged, listener),
  connectEngine: (datasourceId, secrets) => invoke(INVOKE_CHANNELS.connectEngine, { datasourceId, secrets }),
  disconnectEngine: (datasourceId) => invoke(INVOKE_CHANNELS.disconnectEngine, { datasourceId }),
  chooseFile: (title) => invoke(INVOKE_CHANNELS.chooseFile, { title }),
  openFile: (title) => invoke(INVOKE_CHANNELS.openFile, { title }),
  openAnyFile: (title) => invoke(INVOKE_CHANNELS.openAnyFile, { title }),
  saveFile: (title, defaultName) => invoke(INVOKE_CHANNELS.saveFile, { title, defaultName }),
  revealFile: (path) => invoke(INVOKE_CHANNELS.revealFile, { path }),
  listConsoles: (datasourceId) => invoke(INVOKE_CHANNELS.listConsoles, { datasourceId }),
  readConsole: (datasourceId, name) => invoke(INVOKE_CHANNELS.readConsole, { datasourceId, name }),
  writeConsole: (datasourceId, name, text) => invoke(INVOKE_CHANNELS.writeConsole, { datasourceId, name, text }),
  deleteConsole: (datasourceId, name) => invoke(INVOKE_CHANNELS.deleteConsole, { datasourceId, name }),
  renameConsole: (datasourceId, from, to) => invoke(INVOKE_CHANNELS.renameConsole, { datasourceId, from, to }),
  consolePath: (datasourceId, name) => invoke(INVOKE_CHANNELS.consolePath, { datasourceId, name }),
  chooseSqlFiles: (title) => invoke(INVOKE_CHANNELS.chooseSqlFiles, { title }),
  openSqlFile: (path) => invoke(INVOKE_CHANNELS.openSqlFile, { path }),
  readSqlFile: (path) => invoke(INVOKE_CHANNELS.readSqlFile, { path }),
  writeSqlFile: (path, sql, lineEnding) => invoke(INVOKE_CHANNELS.writeSqlFile, { path, sql, lineEnding }),
  renameSqlFile: (path, name) => invoke(INVOKE_CHANNELS.renameSqlFile, { path, name }),
  statSqlFiles: (paths) => invoke(INVOKE_CHANNELS.statSqlFiles, { paths }),
  attachSqlFile: (path, attachment) => invoke(INVOKE_CHANNELS.attachSqlFile, { path, ...attachment }),
  recentSqlFiles: () => invoke(INVOKE_CHANNELS.recentSqlFiles),
  onOpenRecentFile(listener) {
    return subscribe<unknown>(CHANNELS.openRecentFile, (path) => {
      if (typeof path === "string") listener(path);
    });
  },
  historyRecord: (entry) => invoke(INVOKE_CHANNELS.historyRecord, entry),
  historySearch: (datasourceId, query) => invoke(INVOKE_CHANNELS.historySearch, { datasourceId, query }),
  historyClear: (datasourceId) => invoke(INVOKE_CHANNELS.historyClear, { datasourceId }),
  onDatasourcesChanged: (listener) => subscribe<DatasourceList>(CHANNELS.datasourcesChanged, listener),
  onEngineExited: (listener) => subscribe<EngineExited>(CHANNELS.engineExited, listener),
  onInvokeAction(listener) {
    return subscribe<unknown>(CHANNELS.invokeAction, (actionId) => {
      if (typeof actionId === "string") listener(actionId);
    });
  },
  onCloseRequested: (listener) => subscribe<unknown>(CHANNELS.closeRequested, () => listener()),
  answerClose: (proceed) => invoke(INVOKE_CHANNELS.answerClose, { proceed }),
  onHostKeyPrompt: (listener) => subscribe<HostKeyPrompt>(CHANNELS.hostKeyPrompt, listener),
  answerHostKey: (requestId, trust) => invoke(INVOKE_CHANNELS.answerHostKey, { requestId, trust }),
  readSettings: () => invoke(INVOKE_CHANNELS.readSettings),
  readSnippets: () => invoke(INVOKE_CHANNELS.readSnippets),
  saveSnippet: (snippet) => invoke(INVOKE_CHANNELS.saveSnippet, snippet),
  deleteSnippet: (id) => invoke(INVOKE_CHANNELS.deleteSnippet, { id }),
  importSnippets: () => invoke(INVOKE_CHANNELS.importSnippets),
  exportSnippets: (snippets) => invoke(INVOKE_CHANNELS.exportSnippets, { snippets }),
  onSnippetsChanged: (listener) => subscribe<readonly TextSnippet[]>(CHANNELS.snippetsChanged, listener),
  writeSettings: (settings) => invoke(INVOKE_CHANNELS.writeSettings, settings),
  reloadThemes: () => invoke(INVOKE_CHANNELS.reloadThemes),
  openThemesFolder: () => invoke(INVOKE_CHANNELS.openThemesFolder),
  appInfo: () => invoke(INVOKE_CHANNELS.appInfo),
  onSettingsChanged: (listener) => subscribe<SettingsChanged>(CHANNELS.settingsChanged, listener),
  popupMenu: (point) => invoke(INVOKE_CHANNELS.popupMenu, point),
  windowState: () => invoke(INVOKE_CHANNELS.windowState),
  onWindowState: (listener) => subscribe<WindowState>(CHANNELS.windowState, listener),
  relaunch: () => invoke(INVOKE_CHANNELS.relaunch),
  logWrite: (records) => invoke(INVOKE_CHANNELS.logWrite, records),
  logRead: () => invoke(INVOKE_CHANNELS.logRead),
  logReveal: () => invoke(INVOKE_CHANNELS.logReveal),
  onLogAppended: (listener) => subscribe<readonly LogRecord[]>(CHANNELS.logAppended, listener),
  exportDiagnostics: () => invoke(INVOKE_CHANNELS.exportDiagnostics),
  updateState: () => invoke(INVOKE_CHANNELS.updateState),
  onUpdateState: (listener) => subscribe<UpdateState>(CHANNELS.updateState, listener),
  updateCheck: () => invoke(INVOKE_CHANNELS.updateCheck),
  updateDownload: () => invoke(INVOKE_CHANNELS.updateDownload),
  updateCancel: () => invoke(INVOKE_CHANNELS.updateCancel),
  updateInstall: () => invoke(INVOKE_CHANNELS.updateInstall),
  updateSkip: () => invoke(INVOKE_CHANNELS.updateSkip),
  updateDismiss: () => invoke(INVOKE_CHANNELS.updateDismiss),
  updateOpenNotes: () => invoke(INVOKE_CHANNELS.updateOpenNotes),
  importScan: () => invoke(INVOKE_CHANNELS.importScan),
  importPreview: (request) => invoke(INVOKE_CHANNELS.importPreview, request),
  importRun: (request) => invoke(INVOKE_CHANNELS.importRun, request),
  importCancel: () => invoke(INVOKE_CHANNELS.importCancel),
  onImportProgress: (listener) => subscribe<ImportProgress>(CHANNELS.importProgress, listener),
  setAgentAccess: (datasourceId, access) => invoke(INVOKE_CHANNELS.setAgentAccess, { datasourceId, access }),
  rememberServer: (datasourceId, seen) => invoke(INVOKE_CHANNELS.rememberServer, { datasourceId, ...seen }),
  mcpStatus: () => invoke(INVOKE_CHANNELS.mcpStatus),
  onMcpStatus: (listener) => subscribe<McpStatus>(CHANNELS.mcpStatus, listener),
  mcpControl: (control) => invoke(INVOKE_CHANNELS.mcpControl, control),
  mcpCopyClientConfig: (client) => invoke(INVOKE_CHANNELS.mcpCopyClientConfig, { client }),
  mcpRegenerateToken: () => invoke(INVOKE_CHANNELS.mcpRegenerateToken),
  setAgentPolicy: (datasourceId, policy) => invoke(INVOKE_CHANNELS.setAgentPolicy, { datasourceId, policy }),
  mcpCopyToken: () => invoke(INVOKE_CHANNELS.mcpCopyToken),
  mcpContextReply: (requestId, context) => invoke(INVOKE_CHANNELS.mcpContextReply, { requestId, context }),
  onMcpContextRequest: (listener) => subscribe<McpContextRequest>(CHANNELS.mcpContextRequest, listener),
  onMcpOpenConsole: (listener) => subscribe<McpConsoleRequest>(CHANNELS.mcpOpenConsole, listener),
};

contextBridge.exposeInMainWorld(BRIDGE_KEY, bridge);
