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
  type InvokeResult,
  type SettingsChanged,
  type TableCraftBridge,
  type UpdateState,
  type WindowState,
} from "@table-craft/desktop/preload/bridge.js";
import type { LogRecord } from "@table-craft/desktop/log/record.js";

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
  listDatasources: () => invoke(INVOKE_CHANNELS.listDatasources),
  saveDatasource: (request) => invoke(INVOKE_CHANNELS.saveDatasource, request),
  deleteDatasource: (id) => invoke(INVOKE_CHANNELS.deleteDatasource, { id }),
  testDatasource: (request) => invoke(INVOKE_CHANNELS.testDatasource, request),
  parseDatasourceUrl: (pluginId, url) => invoke(INVOKE_CHANNELS.parseDatasourceUrl, { pluginId, url }),
  datasourceUrl: (id) => invoke(INVOKE_CHANNELS.datasourceUrl, { id }),
  listPlugins: () => invoke(INVOKE_CHANNELS.listPlugins),
  connectEngine: (datasourceId, secrets) => invoke(INVOKE_CHANNELS.connectEngine, { datasourceId, secrets }),
  disconnectEngine: (datasourceId) => invoke(INVOKE_CHANNELS.disconnectEngine, { datasourceId }),
  chooseFile: (title) => invoke(INVOKE_CHANNELS.chooseFile, { title }),
  openFile: (title) => invoke(INVOKE_CHANNELS.openFile, { title }),
  saveFile: (title, defaultName) => invoke(INVOKE_CHANNELS.saveFile, { title, defaultName }),
  revealFile: (path) => invoke(INVOKE_CHANNELS.revealFile, { path }),
  listConsoles: (datasourceId) => invoke(INVOKE_CHANNELS.listConsoles, { datasourceId }),
  readConsole: (datasourceId, name) => invoke(INVOKE_CHANNELS.readConsole, { datasourceId, name }),
  writeConsole: (datasourceId, name, text) => invoke(INVOKE_CHANNELS.writeConsole, { datasourceId, name, text }),
  deleteConsole: (datasourceId, name) => invoke(INVOKE_CHANNELS.deleteConsole, { datasourceId, name }),
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
  readSettings: () => invoke(INVOKE_CHANNELS.readSettings),
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
};

contextBridge.exposeInMainWorld(BRIDGE_KEY, bridge);
