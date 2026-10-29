import type { QueryHistory } from "@table-craft/core";
import { z } from "@table-craft/plugin-api";
import { ConsoleFileError, type ConsoleFiles } from "@table-craft/desktop/main/consoleFiles.js";
import { draftSchema } from "@table-craft/desktop/main/datasources.js";
import { logWriteRequest } from "@table-craft/desktop/main/log/schema.js";
import { PluginInstallError } from "@table-craft/desktop/main/pluginStore/errors.js";
import { SecretStoreError } from "@table-craft/desktop/main/secrets.js";
import { SqlFileError, type SqlFileChannels } from "@table-craft/desktop/main/sqlFiles.js";
import { settingsSchema, type SettingsService } from "@table-craft/desktop/main/settings.js";
import {
  SnippetError,
  snippetSchema,
  snippetIdSchema,
  type SnippetsService,
} from "@table-craft/desktop/main/snippets.js";
import { DatasourceError, type DatasourceService } from "@table-craft/desktop/main/service.js";
import {
  HISTORY_OUTCOMES,
  HISTORY_SOURCES,
  IMPORT_APPS,
  INVOKE_CHANNELS,
  type AppInfo,
  type BridgeFailure,
  type HistoryEntry,
  type ImportPreview,
  type ImportPreviewRequest,
  type ImportRunRequest,
  type ImportSource,
  type ImportSummary,
  type InstallFileResult,
  type InvokeResult,
  type MenuPoint,
  type PluginsState,
  type SaveDatasourceRequest,
  type UpdateState,
  type WindowState,
} from "@table-craft/desktop/preload/bridge.js";
import type { Logger, LogRecord } from "@table-craft/desktop/log/record.js";
import {
  AGENT_ACCESS_LEVELS,
  APPROVAL_ANSWERS,
  MCP_CLIENTS,
  type AgentPolicy,
  type McpActiveConsole,
  type McpClient,
  type McpStatus,
  type McpUserControl,
} from "@table-craft/desktop/settings/mcp.js";
import { MCP_ROW_CAP_RANGE } from "@table-craft/desktop/settings/settings.js";

/** Every record from `log.write` is the renderer's, whatever it claims (plan 017 decision 8). */
const RENDERER_PROCESS = "renderer";
const BUG_HINT = "This is a TableCraft bug; restart the app and report it.";

const secretChange = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("keep") }),
  z.strictObject({ action: z.literal("set"), value: z.string() }),
  z.strictObject({ action: z.literal("clear") }),
]);

const saveRequest = z.strictObject({
  datasource: draftSchema,
  secrets: z.record(z.string(), secretChange),
}) satisfies z.ZodType<SaveDatasourceRequest>;

const idRequest = z.strictObject({ id: z.string().min(1) });
const parseUrlRequest = z.strictObject({ pluginId: z.string().min(1), url: z.string() });
const connectRequest = z.strictObject({
  datasourceId: z.string().min(1),
  secrets: z.record(z.string(), z.string()).optional(),
});
const disconnectRequest = z.strictObject({ datasourceId: z.string().min(1) });
const chooseFileRequest = z.strictObject({ title: z.string() });
const saveFileRequest = z.strictObject({ title: z.string(), defaultName: z.string() });
const revealFileRequest = z.strictObject({ path: z.string().min(1) });
const consoleListRequest = z.strictObject({ datasourceId: z.string().min(1) });
const consoleRequest = z.strictObject({ datasourceId: z.string().min(1), name: z.string().min(1) });
const consoleWriteRequest = z.strictObject({
  datasourceId: z.string().min(1),
  name: z.string().min(1),
  text: z.string(),
});
const consoleRenameRequest = z.strictObject({
  datasourceId: z.string().min(1),
  from: z.string().min(1),
  to: z.string(),
});
const sqlFileRequest = z.strictObject({ path: z.string().min(1) });
const sqlFileWriteRequest = z.strictObject({
  path: z.string().min(1),
  sql: z.string(),
  lineEnding: z.enum(["lf", "crlf"]),
});
const sqlFileRenameRequest = z.strictObject({ path: z.string().min(1), name: z.string() });
const sqlFileStatRequest = z.strictObject({ paths: z.array(z.string().min(1)) });
const sqlFileAttachRequest = z.strictObject({
  path: z.string().min(1),
  datasourceId: z.string().min(1),
  namespace: z.array(z.string()).nullable(),
});
const historyEntry = z.strictObject({
  datasourceId: z.string().min(1),
  sql: z.string(),
  startedAt: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  outcome: z.enum(HISTORY_OUTCOMES),
  rowCount: z.number().int().nonnegative().nullable(),
  message: z.string().nullable(),
  source: z.enum(HISTORY_SOURCES),
  parameters: z.record(z.string(), z.string().nullable()).nullable().optional(),
  warnings: z.number().int().positive().nullable().optional(),
}) satisfies z.ZodType<HistoryEntry>;
const historySearchRequest = z.strictObject({ datasourceId: z.string().min(1), query: z.string() });
const historyClearRequest = z.strictObject({ datasourceId: z.string().min(1) });
const answerCloseRequest = z.strictObject({ proceed: z.boolean() });
const answerHostKeyRequest = z.strictObject({ requestId: z.number().int().positive(), trust: z.boolean() });
const menuPoint = z.strictObject({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
}) satisfies z.ZodType<MenuPoint>;
const noRequest = z.undefined();
const agentAccessRequest = z.strictObject({ datasourceId: z.string().min(1), access: z.enum(AGENT_ACCESS_LEVELS) });
const mcpControlRequest = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("answer"), approvalId: z.string().min(1), answer: z.enum(APPROVAL_ANSWERS) }),
  z.strictObject({ action: z.literal("pause"), paused: z.boolean() }),
  z.strictObject({ action: z.literal("disconnect"), clientId: z.string().min(1) }),
  z.strictObject({ action: z.literal("cancel"), runId: z.string().min(1) }),
]) satisfies z.ZodType<McpUserControl>;
const agentPolicyRequest = z.strictObject({
  datasourceId: z.string().min(1),
  policy: z.strictObject({
    schemas: z.array(z.string().min(1)).readonly().nullable(),
    rowCap: z.number().int().min(MCP_ROW_CAP_RANGE.min).max(MCP_ROW_CAP_RANGE.max).nullable(),
  }) satisfies z.ZodType<AgentPolicy>,
});
/** A console's text crosses to the MCP host only up to this; `get_active_context` cuts it further. */
const MAX_CONTEXT_CHARS = 1_000_000;
const mcpContextReply = z.strictObject({
  requestId: z.number().int().positive(),
  context: z
    .strictObject({
      datasourceId: z.string().min(1),
      sql: z.string().max(MAX_CONTEXT_CHARS),
      selectionFrom: z.number().int().nonnegative(),
      selectionTo: z.number().int().nonnegative(),
      namespace: z.array(z.string()).readonly().nullable(),
    })
    .nullable() satisfies z.ZodType<McpActiveConsole | null>,
});
const mcpClientRequest = z.strictObject({ client: z.enum(MCP_CLIENTS) });
const pluginRequest = z.strictObject({ pluginId: z.string().min(1) });
const importPreviewRequest = z.union([
  z.strictObject({ source: z.enum(IMPORT_APPS) }),
  z.strictObject({ source: z.literal("file"), path: z.string().min(1), passphrase: z.string().optional() }),
]) satisfies z.ZodType<ImportPreviewRequest>;
const importRunRequest = z.strictObject({
  previewId: z.number().int().positive(),
  keys: z.array(z.string().min(1)),
  importPasswords: z.boolean(),
  topFolder: z.boolean(),
}) satisfies z.ZodType<ImportRunRequest>;

/** The slice of `ipcMain` the handlers need; `sender` is the window that asked. */
export interface InvokeRegistrar<Sender> {
  handle(channel: string, listener: (event: { readonly sender: Sender }, ...args: unknown[]) => unknown): void;
}

export interface IpcOptions<Sender> {
  readonly service: DatasourceService<Sender>;
  readonly consoles: ConsoleFiles;
  readonly sqlFiles: SqlFileChannels<Sender>;
  readonly history: Pick<QueryHistory, "record" | "search" | "clear">;
  readonly chooseFile: (sender: Sender, title: string) => Promise<string | null>;
  readonly openFile: (sender: Sender, title: string) => Promise<string | null>;
  /** Any file, no filters: one to load into a binary cell (plan 043). */
  readonly openAnyFile: (sender: Sender, title: string) => Promise<string | null>;
  readonly saveFile: (sender: Sender, title: string, defaultName: string) => Promise<string | null>;
  readonly revealFile: (path: string) => void;
  /** The renderer's answer to a held close (`CHANNELS.closeRequested`). */
  readonly answerClose: (sender: Sender, proceed: boolean) => void;
  /** The renderer's answer to `CHANNELS.hostKeyPrompt` (decision 071). */
  readonly answerHostKey: (requestId: number, trust: boolean) => void;
  readonly settings: SettingsService;
  readonly snippets: SnippetsService;
  /** Creates `<userData>/themes/` if missing and shows it in the file manager. */
  readonly openThemesFolder: () => Promise<void>;
  readonly appInfo: () => AppInfo;
  /** Pops the application menu in the sender's window (decision 034). */
  readonly popupMenu: (sender: Sender, point: MenuPoint) => void;
  readonly windowState: (sender: Sender) => WindowState;
  /** Quits through the close guard and starts again. */
  readonly relaunch: () => void;
  /** Main's `ipc` logger: rejected payloads and failed handlers are written here (plan 017). */
  readonly log: Logger;
  readonly logs: LogChannels<Sender>;
  readonly updates: UpdateChannels;
  readonly importer: ImportChannels<Sender>;
  readonly plugins: PluginChannels<Sender>;
  readonly mcp: McpChannels;
}

/** The MCP server behind the `mcp.*` channels (decision 126); the token never crosses to a window. */
export interface McpChannels {
  status(): McpStatus;
  control(control: McpUserControl): void;
  copyClientConfig(client: McpClient): Promise<void>;
  regenerateToken(): Promise<void>;
  copyToken(): Promise<void>;
  contextReply(requestId: number, context: McpActiveConsole | null): void;
}

/** Downloaded plugins behind the `plugins.*` channels (decision 110); package names never come from the renderer. */
export interface PluginChannels<Sender> {
  state(): PluginsState;
  install(pluginId: string): Promise<PluginsState>;
  /** Main shows the file dialog and the trust confirmation (decision 006) in the sender's window. */
  installFile(sender: Sender): Promise<InstallFileResult>;
  remove(pluginId: string): Promise<PluginsState>;
}

/** The importer behind the `import.*` channels (plan 035); progress goes to the asking window. */
export interface ImportChannels<Sender> {
  scan(): Promise<readonly ImportSource[]>;
  preview(request: ImportPreviewRequest): Promise<ImportPreview>;
  run(request: ImportRunRequest, sender: Sender): Promise<ImportSummary>;
  cancel(): void;
}

/** The updater behind the `update.*` channels (plan 020); URLs never come from the renderer. */
export interface UpdateChannels {
  state(): UpdateState;
  check(): Promise<UpdateState>;
  download(): void;
  cancel(): Promise<void>;
  install(): void;
  skip(): Promise<void>;
  dismiss(): void;
  openNotes(): void;
}

/** The log and diagnostics behind the `log.*` and `diagnostics.export` channels (plan 017). */
export interface LogChannels<Sender> {
  /** Records the renderer sent, already validated; main sets their process. */
  write(records: readonly LogRecord[]): void;
  read(): Promise<readonly LogRecord[]>;
  reveal(): void;
  exportDiagnostics(sender: Sender): Promise<string | null>;
}

function failureOf(cause: unknown): BridgeFailure | null {
  if (
    cause instanceof DatasourceError ||
    cause instanceof SecretStoreError ||
    cause instanceof ConsoleFileError ||
    cause instanceof SqlFileError ||
    cause instanceof SnippetError ||
    cause instanceof PluginInstallError
  ) {
    return { message: cause.message, hint: cause.hint };
  }
  return null;
}

/**
 * Every renderer-to-main call (plan 004). The renderer is untrusted input, so each payload is
 * parsed before it reaches the service, and a failure answers as a value: `ipcMain.handle`
 * rejections lose everything but the message.
 */
export function registerIpc<Sender>(ipc: InvokeRegistrar<Sender>, options: IpcOptions<Sender>): void {
  function handle<Schema extends z.ZodType, T>(
    channel: string,
    schema: Schema,
    run: (request: z.output<Schema>, sender: Sender) => Promise<T> | T,
  ): void {
    ipc.handle(channel, async (event, payload): Promise<InvokeResult<T>> => {
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        options.log.warn("request rejected", { channel, error: parsed.error.message });
        return {
          ok: false,
          error: { message: `Main could not read the request: ${parsed.error.message}`, hint: BUG_HINT },
        };
      }
      try {
        return { ok: true, value: await run(parsed.data, event.sender) };
      } catch (cause) {
        const failure = failureOf(cause);
        if (failure !== null) return { ok: false, error: failure };
        options.log.error("handler failed", { channel, err: cause });
        const message = cause instanceof Error ? cause.message : String(cause);
        return { ok: false, error: { message, hint: BUG_HINT } };
      }
    });
  }

  const { service } = options;
  handle(INVOKE_CHANNELS.listDatasources, noRequest, () => service.list());
  handle(INVOKE_CHANNELS.listPlugins, noRequest, () => service.plugins());
  const { plugins } = options;
  handle(INVOKE_CHANNELS.pluginsState, noRequest, () => plugins.state());
  handle(INVOKE_CHANNELS.installPlugin, pluginRequest, ({ pluginId }) => plugins.install(pluginId));
  handle(INVOKE_CHANNELS.installPluginFile, noRequest, (_request, sender) => plugins.installFile(sender));
  handle(INVOKE_CHANNELS.removePlugin, pluginRequest, ({ pluginId }) => plugins.remove(pluginId));
  handle(INVOKE_CHANNELS.saveDatasource, saveRequest, (request) => service.save(request));
  handle(INVOKE_CHANNELS.deleteDatasource, idRequest, async ({ id }) => {
    await service.delete(id);
    return null;
  });
  handle(INVOKE_CHANNELS.testDatasource, saveRequest, (request) => service.test(request));
  handle(INVOKE_CHANNELS.parseDatasourceUrl, parseUrlRequest, ({ pluginId, url }) => service.parseUrl(pluginId, url));
  handle(INVOKE_CHANNELS.datasourceUrl, idRequest, ({ id }) => service.url(id));
  handle(INVOKE_CHANNELS.connectEngine, connectRequest, ({ datasourceId, secrets }, sender) =>
    service.connect(datasourceId, secrets ?? {}, sender),
  );
  handle(INVOKE_CHANNELS.disconnectEngine, disconnectRequest, async ({ datasourceId }) => {
    await service.disconnect(datasourceId);
    return null;
  });
  const { importer } = options;
  handle(INVOKE_CHANNELS.importScan, noRequest, () => importer.scan());
  handle(INVOKE_CHANNELS.importPreview, importPreviewRequest, (request) => importer.preview(request));
  handle(INVOKE_CHANNELS.importRun, importRunRequest, (request, sender) => importer.run(request, sender));
  handle(INVOKE_CHANNELS.importCancel, noRequest, () => {
    importer.cancel();
    return null;
  });
  handle(INVOKE_CHANNELS.chooseFile, chooseFileRequest, ({ title }, sender) => options.chooseFile(sender, title));
  handle(INVOKE_CHANNELS.openFile, chooseFileRequest, ({ title }, sender) => options.openFile(sender, title));
  handle(INVOKE_CHANNELS.openAnyFile, chooseFileRequest, ({ title }, sender) => options.openAnyFile(sender, title));
  handle(INVOKE_CHANNELS.saveFile, saveFileRequest, ({ title, defaultName }, sender) =>
    options.saveFile(sender, title, defaultName),
  );
  handle(INVOKE_CHANNELS.revealFile, revealFileRequest, ({ path }) => {
    options.revealFile(path);
    return null;
  });
  handle(INVOKE_CHANNELS.answerClose, answerCloseRequest, ({ proceed }, sender) => {
    options.answerClose(sender, proceed);
    return null;
  });
  handle(INVOKE_CHANNELS.answerHostKey, answerHostKeyRequest, ({ requestId, trust }) => {
    options.answerHostKey(requestId, trust);
    return null;
  });

  const { consoles } = options;
  handle(INVOKE_CHANNELS.listConsoles, consoleListRequest, ({ datasourceId }) => consoles.list(datasourceId));
  handle(INVOKE_CHANNELS.readConsole, consoleRequest, ({ datasourceId, name }) => consoles.read(datasourceId, name));
  handle(INVOKE_CHANNELS.writeConsole, consoleWriteRequest, async ({ datasourceId, name, text }) => {
    await consoles.write(datasourceId, name, text);
    return null;
  });
  handle(INVOKE_CHANNELS.deleteConsole, consoleRequest, async ({ datasourceId, name }) => {
    await consoles.delete(datasourceId, name);
    return null;
  });
  handle(INVOKE_CHANNELS.consolePath, consoleRequest, ({ datasourceId, name }) => consoles.path(datasourceId, name));
  handle(INVOKE_CHANNELS.renameConsole, consoleRenameRequest, async ({ datasourceId, from, to }) => {
    await consoles.rename(datasourceId, from, to);
    return null;
  });

  const { sqlFiles } = options;
  handle(INVOKE_CHANNELS.chooseSqlFiles, chooseFileRequest, ({ title }, sender) => sqlFiles.choose(sender, title));
  handle(INVOKE_CHANNELS.openSqlFile, sqlFileRequest, ({ path }) => sqlFiles.open(path));
  handle(INVOKE_CHANNELS.readSqlFile, sqlFileRequest, ({ path }) => sqlFiles.read(path));
  handle(INVOKE_CHANNELS.writeSqlFile, sqlFileWriteRequest, ({ path, sql, lineEnding }) =>
    sqlFiles.write(path, sql, lineEnding),
  );
  handle(INVOKE_CHANNELS.renameSqlFile, sqlFileRenameRequest, ({ path, name }) => sqlFiles.rename(path, name));
  handle(INVOKE_CHANNELS.statSqlFiles, sqlFileStatRequest, ({ paths }) => sqlFiles.stat(paths));
  handle(INVOKE_CHANNELS.attachSqlFile, sqlFileAttachRequest, async ({ path, datasourceId, namespace }) => {
    await sqlFiles.attach(path, { datasourceId, namespace });
    return null;
  });
  handle(INVOKE_CHANNELS.recentSqlFiles, noRequest, () => sqlFiles.recent());

  const { settings } = options;
  handle(INVOKE_CHANNELS.readSnippets, noRequest, () => options.snippets.read());
  handle(INVOKE_CHANNELS.saveSnippet, snippetSchema, (snippet) => options.snippets.save(snippet));
  handle(INVOKE_CHANNELS.deleteSnippet, z.strictObject({ id: snippetIdSchema }), ({ id }) =>
    options.snippets.remove(id),
  );
  handle(INVOKE_CHANNELS.importSnippets, noRequest, async (_request, sender) => {
    const filePath = await options.chooseFile(sender, "Import Snippets");
    if (filePath === null) return options.snippets.read();
    return options.snippets.importSnippets(filePath);
  });
  handle(
    INVOKE_CHANNELS.exportSnippets,
    z.strictObject({ snippets: z.array(snippetSchema) }),
    async ({ snippets }, sender) => {
      const filePath = await options.saveFile(sender, "Export Snippets", "snippets.json");
      if (filePath === null) return null;
      await options.snippets.exportSnippets(filePath, snippets);
      return null;
    },
  );

  handle(INVOKE_CHANNELS.readSettings, noRequest, () => settings.snapshot());
  handle(INVOKE_CHANNELS.writeSettings, settingsSchema, async (document) => {
    await settings.write(document);
    return null;
  });
  handle(INVOKE_CHANNELS.reloadThemes, noRequest, async () => {
    await settings.reloadThemes();
    return null;
  });
  handle(INVOKE_CHANNELS.openThemesFolder, noRequest, async () => {
    await options.openThemesFolder();
    return null;
  });
  handle(INVOKE_CHANNELS.appInfo, noRequest, () => options.appInfo());
  handle(INVOKE_CHANNELS.popupMenu, menuPoint, (point, sender) => {
    options.popupMenu(sender, point);
    return null;
  });
  handle(INVOKE_CHANNELS.windowState, noRequest, (_request, sender) => options.windowState(sender));
  handle(INVOKE_CHANNELS.relaunch, noRequest, () => {
    options.relaunch();
    return null;
  });

  const { logs } = options;
  handle(INVOKE_CHANNELS.logWrite, logWriteRequest, (records) => {
    logs.write(records.map((record) => ({ ...record, process: RENDERER_PROCESS })));
    return null;
  });
  handle(INVOKE_CHANNELS.logRead, noRequest, () => logs.read());
  handle(INVOKE_CHANNELS.logReveal, noRequest, () => {
    logs.reveal();
    return null;
  });
  handle(INVOKE_CHANNELS.exportDiagnostics, noRequest, (_request, sender) => logs.exportDiagnostics(sender));

  const { updates } = options;
  const done = (run: () => unknown) => async () => {
    await run();
    return null;
  };
  handle(INVOKE_CHANNELS.updateState, noRequest, () => updates.state());
  handle(INVOKE_CHANNELS.updateCheck, noRequest, () => updates.check());
  // The download outlives the request; its progress and outcome arrive on `CHANNELS.updateState`.
  handle(
    INVOKE_CHANNELS.updateDownload,
    noRequest,
    done(() => updates.download()),
  );
  handle(
    INVOKE_CHANNELS.updateCancel,
    noRequest,
    done(() => updates.cancel()),
  );
  handle(
    INVOKE_CHANNELS.updateInstall,
    noRequest,
    done(() => updates.install()),
  );
  handle(
    INVOKE_CHANNELS.updateSkip,
    noRequest,
    done(() => updates.skip()),
  );
  handle(
    INVOKE_CHANNELS.updateDismiss,
    noRequest,
    done(() => updates.dismiss()),
  );
  handle(
    INVOKE_CHANNELS.updateOpenNotes,
    noRequest,
    done(() => updates.openNotes()),
  );

  const { history } = options;
  handle(INVOKE_CHANNELS.historyRecord, historyEntry, (entry) => {
    history.record(entry);
    return null;
  });
  handle(INVOKE_CHANNELS.historySearch, historySearchRequest, ({ datasourceId, query }) =>
    history.search(datasourceId, query),
  );
  handle(INVOKE_CHANNELS.historyClear, historyClearRequest, ({ datasourceId }) => {
    history.clear(datasourceId);
    return null;
  });

  const { mcp } = options;
  handle(INVOKE_CHANNELS.setAgentAccess, agentAccessRequest, async ({ datasourceId, access }) => {
    await service.setAgentAccess(datasourceId, access);
    return null;
  });
  handle(INVOKE_CHANNELS.mcpStatus, noRequest, () => mcp.status());
  handle(INVOKE_CHANNELS.mcpControl, mcpControlRequest, (control) => {
    mcp.control(control);
    return null;
  });
  handle(INVOKE_CHANNELS.mcpCopyClientConfig, mcpClientRequest, async ({ client }) => {
    await mcp.copyClientConfig(client);
    return null;
  });
  handle(
    INVOKE_CHANNELS.mcpRegenerateToken,
    noRequest,
    done(() => mcp.regenerateToken()),
  );
  handle(
    INVOKE_CHANNELS.mcpCopyToken,
    noRequest,
    done(() => mcp.copyToken()),
  );
  handle(INVOKE_CHANNELS.setAgentPolicy, agentPolicyRequest, async ({ datasourceId, policy }) => {
    await service.setAgentPolicy(datasourceId, policy);
    return null;
  });
  handle(INVOKE_CHANNELS.mcpContextReply, mcpContextReply, ({ requestId, context }) => {
    mcp.contextReply(requestId, context);
    return null;
  });
}
