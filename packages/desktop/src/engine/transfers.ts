import { isAbsolute } from "node:path";
import {
  CsvError,
  RowsRefused,
  fileChunks,
  fileSize,
  formatProblem,
  loadedPlugin,
  previewFile,
  type ExportEncoderOptions,
} from "@table-craft/core";
import { isPluginError, type Column, type InsertTarget, type SqlLanguage } from "@table-craft/plugin-api";
import { MS_PER_SECOND, connectDatasource, connectOptions, drained } from "@table-craft/desktop/engine/connect.js";
import type { BaseContext } from "@table-craft/desktop/engine/context.js";
import { exportTasks, type ExportJob, type ExportRows } from "@table-craft/desktop/engine/exports.js";
import {
  BUG_HINT,
  EngineFailure,
  FILE_HINT,
  FORMAT_OPTIONS_HINT,
  PRIVATE_IMPORT,
  PRIVATE_IMPORT_HINT,
  READ_ONLY_IMPORT,
  READ_ONLY_IMPORT_HINT,
  SYNCHRONIZE_HINT,
  messageOf,
  statementFailed,
} from "@table-craft/desktop/engine/failures.js";
import { importTasks, type ImportJob, type ImportSession } from "@table-craft/desktop/engine/imports.js";
import type {
  ExportFormat,
  ExportSource,
  ExportTask,
  ImportEncoding,
  ImportFormat,
  ImportPreview,
  ImportTask,
  NewImportColumn,
  RequestOf,
  ScriptTask,
} from "@table-craft/desktop/engine/protocol.js";
import {
  SCRIPT_WHOLE_FILE_MAX_BYTES,
  scriptTasks,
  wholeFileStream,
  type ScriptFile,
  type ScriptSession,
} from "@table-craft/desktop/engine/scripts.js";

const BYTES_PER_MIB = 1024 * 1024;

/** The export, import and script tasks every connection shares, and what starting one checks first. */
export function transferContext(base: BaseContext) {
  const { options, connector, log, sqlLanguage, introspect, relationOf, namespaceSwitchable, switchStatement } = base;

  const tasks = exportTasks(log === null ? {} : { log: log.child("export") });

  /** An export's rows from `sql` on a read-only session of its own, every byte of binary values in full. */
  async function exportRowsOf(sql: string): Promise<ExportRows> {
    const session = await connectDatasource(options, connector, true);
    try {
      const result = await session.execute(sql, [], { fullBytes: true });
      return { rows: result.rows, close: () => session.close() };
    } catch (cause) {
      await session.close().catch(() => undefined);
      throw statementFailed(cause, true);
    }
  }

  async function tableJob(
    source: Extract<ExportSource, { kind: "table" }>,
    format: ExportFormat,
    path: string,
  ): Promise<ExportJob> {
    const language = sqlLanguage();
    const { relation, qualified } = await relationOf(source.path, source.relation);
    const columns = source.columns.map((name): Column => {
      const meta = relation.columns.find((column) => column.name === name);
      if (meta === undefined) {
        throw new EngineFailure({
          code: "invalidRequest",
          message: `There is no column ${name} in ${source.relation}.`,
          hint: SYNCHRONIZE_HINT,
        });
      }
      return { name: meta.name, type: meta.type };
    });
    const list = columns.map((column) => language.quoteIdentifier(column.name)).join(", ");
    const sql = `SELECT ${list} FROM ${qualified}`;
    const encoder: ExportEncoderOptions = { dialect: language, table: qualified };
    return {
      path,
      format,
      origin: "table",
      columns,
      projection: null,
      estimate: null,
      encoder,
      retryable: true,
      drains: null,
      open: () => exportRowsOf(sql),
    };
  }

  function taskOf(taskId: string): ExportTask {
    const task = tasks.get(taskId);
    if (task === undefined) {
      throw new EngineFailure({
        code: "invalidRequest",
        message: `No export task "${taskId}".`,
        hint: "Export again.",
      });
    }
    return task;
  }

  function absolutePath(path: string): void {
    if (!isAbsolute(path)) {
      throw new EngineFailure({
        code: "invalidRequest",
        message: `Export needs an absolute path, not "${path}".`,
        hint: BUG_HINT,
      });
    }
  }

  const imports = importTasks(log === null ? {} : { log: log.child("import") });
  const scripts = scriptTasks(log === null ? {} : { log: log.child("script") });

  async function scriptFiles(files: readonly string[], streams: boolean): Promise<ScriptFile[]> {
    return Promise.all(
      files.map(async (path) => {
        if (!isAbsolute(path)) {
          throw new EngineFailure({
            code: "invalidRequest",
            message: `Run SQL Script needs an absolute path, not "${path}".`,
            hint: BUG_HINT,
          });
        }
        let size: number;
        try {
          size = await fileSize(path);
        } catch (cause) {
          throw new EngineFailure(
            { code: "scriptFailed", message: `Cannot read ${path}: ${messageOf(cause)}`, hint: FILE_HINT },
            cause,
          );
        }
        if (!streams && size > SCRIPT_WHOLE_FILE_MAX_BYTES) {
          throw new EngineFailure({
            code: "scriptFailed",
            message: `${path} is larger than this data source's plugin can run as a script (${String(SCRIPT_WHOLE_FILE_MAX_BYTES / BYTES_PER_MIB)} MiB).`,
            hint: "Split the file, or update the plugin to one that streams scripts.",
          });
        }
        return { path, size };
      }),
    );
  }

  async function scriptSession(namespace: readonly string[] | null): Promise<ScriptSession> {
    const session = await connectDatasource(options, connector);
    try {
      if (namespace !== null && namespaceSwitchable())
        await drained(await session.execute(switchStatement(namespace).sql));
    } catch (cause) {
      await session.close().catch(() => undefined);
      throw statementFailed(cause, options.datasource.readOnly);
    }
    return {
      execute: async (sql, repeat) => {
        await drained(await session.execute(sql, [], repeat === undefined ? undefined : { repeat }));
      },
      cancel: () => void session.cancel?.().catch(() => undefined),
      close: () => session.close(),
      inTransaction: () => session.transactions?.open === true,
    };
  }

  async function runScript(params: RequestOf<"script.run">): Promise<ScriptTask> {
    const language = sqlLanguage();
    const streams = language.splitStream !== undefined;
    const files = await scriptFiles(params.files, streams);
    return scripts.start({
      files,
      namespace: params.namespace,
      open: () => scriptSession(params.namespace),
      stream: () => language.splitStream?.() ?? wholeFileStream((text) => language.split(text)),
      failure: (cause, sql) => statementFailed(cause, options.datasource.readOnly, sql).error,
      onError: params.onError,
    });
  }

  function scriptTaskOf(taskId: string): ScriptTask {
    const task = scripts.get(taskId);
    if (task === undefined) {
      throw new EngineFailure({ code: "invalidRequest", message: `No script task "${taskId}".`, hint: BUG_HINT });
    }
    return task;
  }

  /** The language of a plugin that declares `bulkInsert`, which has `importType` and `createTable`. */
  function importLanguage(): Required<Pick<SqlLanguage, "importType" | "createTable">> {
    const { plugin } = loadedPlugin(options.plugins, options.datasource.pluginId);
    const language = plugin.language;
    if (
      !plugin.capabilities.includes("bulkInsert") ||
      language?.importType === undefined ||
      language.createTable === undefined
    ) {
      throw new EngineFailure({
        code: "invalidRequest",
        message: "This datasource's plugin does not declare the bulkInsert capability.",
        hint: BUG_HINT,
      });
    }
    return { importType: language.importType.bind(language), createTable: language.createTable.bind(language) };
  }

  async function importable(file: string, format: ImportFormat): Promise<number> {
    if (!isAbsolute(file)) {
      throw new EngineFailure({
        code: "invalidRequest",
        message: `Import needs an absolute path, not "${file}".`,
        hint: BUG_HINT,
      });
    }
    const problem = formatProblem(format);
    if (problem !== null)
      throw new EngineFailure({ code: "invalidRequest", message: problem, hint: FORMAT_OPTIONS_HINT });
    try {
      return await fileSize(file);
    } catch (cause) {
      throw new EngineFailure(
        { code: "importFailed", message: `Cannot read ${file}: ${messageOf(cause)}`, hint: FILE_HINT },
        cause,
      );
    }
  }

  async function previewImport(file: string, format: ImportFormat): Promise<ImportPreview> {
    const language = importLanguage();
    const size = await importable(file, format);
    try {
      const preview = await previewFile(fileChunks(file), format);
      return {
        names: preview.names,
        rows: preview.rows,
        kinds: preview.columns.map((column) => column.kind),
        types: preview.columns.map((column) => language.importType(column)),
        encoding: (preview.encoding ?? "utf-8") as ImportEncoding,
        ragged: preview.ragged,
        size,
      };
    } catch (cause) {
      const where = cause instanceof CsvError ? ` (line ${String(cause.line)})` : "";
      throw new EngineFailure(
        { code: "importFailed", message: `${messageOf(cause)}${where}`, hint: FORMAT_OPTIONS_HINT },
        cause,
      );
    }
  }

  async function newTableDdl(
    path: readonly string[],
    relation: string,
    columns: readonly NewImportColumn[],
  ): Promise<{ qualified: string; ddl: string }> {
    const language = importLanguage();
    const qualified = await introspect(
      ({ session }) => session.introspector?.qualifiedName(path, relation) ?? relation,
    );
    return {
      qualified,
      ddl: language.createTable(
        qualified,
        columns.map(({ name, type }) => ({ name, type })),
      ),
    };
  }

  /**
   * The import's own writable session in manual mode, with TCP keepalive like every connection
   * (decision 054). It never enters `sessions`, so the statement timeout, the idle ping and the
   * reconnect never touch it: a reconnect mid-import would lose the open transaction, and only the
   * stall watchdog may end an import (decision 046).
   */
  async function importSession(target: InsertTarget): Promise<ImportSession> {
    const session = await connector.connect(connectOptions(options.datasource, false));
    const insertRows = session.insertRows?.bind(session);
    const { transactions } = session;
    if (transactions === undefined || insertRows === undefined) {
      await session.close().catch(() => undefined);
      throw new Error("A bulkInsert session needs transactions and insertRows.");
    }
    try {
      await transactions.setMode("manual");
    } catch (cause) {
      await session.close().catch(() => undefined);
      throw cause;
    }
    return {
      writer: {
        insert: (rows) =>
          insertRows(target, rows).catch((cause: unknown) => {
            if (isPluginError(cause) && cause.code === "statementFailed") {
              throw new RowsRefused(cause.message, { cause });
            }
            throw cause;
          }),
        commit: () => transactions.commit(),
        rollback: () => transactions.rollback(),
      },
      close: () => session.close(),
    };
  }

  async function startImport(params: RequestOf<"import.start">): Promise<ImportTask> {
    importLanguage();
    if (options.datasource.readOnly) {
      throw new EngineFailure({ code: "invalidRequest", message: READ_ONLY_IMPORT, hint: READ_ONLY_IMPORT_HINT });
    }
    const size = await importable(params.file, params.format);
    const { target } = params;
    const privateDatabase = await introspect(({ session }) => session.privateDatabase === true);
    if (privateDatabase) {
      throw new EngineFailure({ code: "invalidRequest", message: PRIVATE_IMPORT, hint: PRIVATE_IMPORT_HINT });
    }
    let insert: InsertTarget;
    let fields: number[];
    if (target.kind === "table") {
      const { relation, qualified } = await relationOf(target.path, target.relation);
      const columns = target.mapping.map(({ column: name }): Column => {
        const meta = relation.columns.find((column) => column.name === name);
        if (meta === undefined) {
          throw new EngineFailure({
            code: "invalidRequest",
            message: `There is no column ${name} in ${target.relation}.`,
            hint: SYNCHRONIZE_HINT,
          });
        }
        return { name: meta.name, type: meta.type };
      });
      insert = { table: qualified, columns };
      fields = target.mapping.map((entry) => entry.field);
    } else {
      const { qualified, ddl } = await newTableDdl(target.path, target.relation, target.columns);
      const session = await connectDatasource(options, connector);
      try {
        await drained(await session.execute(ddl));
      } catch (cause) {
        throw statementFailed(cause, false);
      } finally {
        await session.close().catch(() => undefined);
      }
      await introspect(({ cache }) => cache.describe(target.path, true)).catch(() => undefined);
      insert = { table: qualified, columns: target.columns.map(({ name, type }) => ({ name, type })) };
      fields = target.columns.map((column) => column.field);
    }
    const job: ImportJob = {
      file: params.file,
      size,
      format: params.format,
      table: insert.table,
      created: target.kind === "new",
      fields,
      transaction: params.transaction,
      errors: params.errors,
      open: () => importSession(insert),
    };
    return imports.start(job, params.stallSeconds * MS_PER_SECOND);
  }

  /** The qualified table each table export reads, by task, so Drop and Truncate can refuse while it runs. */
  const exportTables = new Map<string, string>();

  function importTaskOf(taskId: string): ImportTask {
    const task = imports.get(taskId);
    if (task === undefined) {
      throw new EngineFailure({
        code: "invalidRequest",
        message: `No import task "${taskId}".`,
        hint: "Import again.",
      });
    }
    return task;
  }

  return {
    tasks,
    exportRowsOf,
    tableJob,
    taskOf,
    absolutePath,
    imports,
    scripts,
    scriptFiles,
    scriptSession,
    runScript,
    scriptTaskOf,
    importLanguage,
    importable,
    previewImport,
    newTableDdl,
    importSession,
    startImport,
    exportTables,
    importTaskOf,
  };
}

export type TransferContext = ReturnType<typeof transferContext>;
