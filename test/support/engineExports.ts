import type { PluginLoadResult } from "@table-craft/core";
import { createEngine, type EngineConnection } from "@table-craft/desktop/engine/engine.js";
import type {
  DatasourceConfig,
  EngineEvent,
  EngineResponse,
  ExecutedStatement,
  ExportEvent,
  ExportTask,
  ImportEvent,
  ImportTask,
} from "@table-craft/desktop/engine/protocol.js";
import { RESULT_FETCH_ALL_CAP, RESULT_PAGE_ROWS } from "@table-craft/desktop/engine/protocol.js";

/** Drives one engine's export and import tasks the way a renderer would (plans 018, 021). */

/** These suites read through the open cursor; a row limit in the SQL has its own (decision 162). */
const PAGING = { pageRows: RESULT_PAGE_ROWS, fetchAllCap: RESULT_FETCH_ALL_CAP, limitInSql: false };
const FINAL_EVENTS = new Set(["export.done", "export.failed", "export.cancelled"]);
const FINAL_IMPORT_EVENTS = new Set(["import.done", "import.failed", "import.cancelled"]);
export const STALL_SECONDS = 120;

export interface ExportHarness {
  readonly connection: EngineConnection;
  readonly events: EngineEvent[];
  readonly finished: (taskId: string) => Promise<ExportTask>;
  /** Resolves on the first progress event of `taskId` with at least `rows` rows written. */
  readonly progressed: (taskId: string, rows: number) => Promise<ExportTask>;
  /** The same for an import task: its final event, or the first with at least `rows` written. */
  readonly imported: (taskId: string) => Promise<ImportTask>;
  readonly importing: (taskId: string, rows: number) => Promise<ImportTask>;
  /** The first event of `taskId` with at least `rows` committed, or its final one. */
  readonly committing: (taskId: string, rows: number) => Promise<ImportTask>;
  readonly close: () => Promise<void>;
}

function isExport(event: EngineEvent): event is ExportEvent {
  return event.type.startsWith("export.");
}

function isImport(event: EngineEvent): event is ImportEvent {
  return event.type.startsWith("import.");
}

export function exportHarness(datasource: DatasourceConfig, plugins: readonly PluginLoadResult[]): ExportHarness {
  const engine = createEngine({ datasource, plugins: [...plugins] });
  const events: EngineEvent[] = [];
  const waiting: {
    readonly matches: (event: EngineEvent) => boolean;
    readonly resolve: (event: EngineEvent) => void;
  }[] = [];
  const connection = engine.connect((event) => {
    events.push(event);
    for (const waiter of waiting.splice(0)) {
      if (waiter.matches(event)) waiter.resolve(event);
      else waiting.push(waiter);
    }
  });
  function when(matches: (event: EngineEvent) => boolean): Promise<EngineEvent> {
    const seen = events.find(matches);
    if (seen !== undefined) return Promise.resolve(seen);
    return new Promise((resolve) => waiting.push({ matches, resolve }));
  }
  async function exportWhen(matches: (event: ExportEvent) => boolean): Promise<ExportTask> {
    const event = await when((candidate) => isExport(candidate) && matches(candidate));
    return (event as ExportEvent).task;
  }
  async function importWhen(matches: (event: ImportEvent) => boolean): Promise<ImportTask> {
    const event = await when((candidate) => isImport(candidate) && matches(candidate));
    return (event as ImportEvent).task;
  }
  return {
    connection,
    events,
    finished: (taskId) => exportWhen((event) => event.task.taskId === taskId && FINAL_EVENTS.has(event.type)),
    progressed: (taskId, rows) =>
      exportWhen((event) => event.task.taskId === taskId && (event.task.rows >= rows || FINAL_EVENTS.has(event.type))),
    imported: (taskId) => importWhen((event) => event.task.taskId === taskId && FINAL_IMPORT_EVENTS.has(event.type)),
    importing: (taskId, rows) =>
      importWhen(
        (event) => event.task.taskId === taskId && (event.task.written >= rows || FINAL_IMPORT_EVENTS.has(event.type)),
      ),
    committing: (taskId, rows) =>
      importWhen(
        (event) =>
          event.task.taskId === taskId && (event.task.committed >= rows || FINAL_IMPORT_EVENTS.has(event.type)),
      ),
    async close() {
      await connection.close();
      await engine.close();
    },
  };
}

export function resultOf<T>(response: EngineResponse): T {
  if (response.type === "engine.error") throw new Error(`unexpected engine error: ${response.error.message}`);
  return response.result as T;
}

export async function openSession(connection: EngineConnection): Promise<string> {
  return resultOf<{ sessionId: string }>(await connection.handle({ id: 1, type: "session.open" })).sessionId;
}

export async function execute(
  connection: EngineConnection,
  sessionId: string,
  sql: string,
  timeoutSeconds?: number,
): Promise<ExecutedStatement> {
  return resultOf<ExecutedStatement>(
    await connection.handle({
      id: 2,
      type: "statement.execute",
      ...PAGING,
      sessionId,
      sql,
      ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
    }),
  );
}

export async function startExport(
  connection: EngineConnection,
  request: Record<string, unknown>,
  stallSeconds = STALL_SECONDS,
): Promise<ExportTask> {
  return resultOf<ExportTask>(await connection.handle({ id: 3, type: "export.start", stallSeconds, ...request }));
}

export async function startImport(
  connection: EngineConnection,
  request: Record<string, unknown>,
  stallSeconds = STALL_SECONDS,
): Promise<ImportTask> {
  return resultOf<ImportTask>(await connection.handle({ id: 4, type: "import.start", stallSeconds, ...request }));
}
