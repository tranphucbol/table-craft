import {
  RESULT_FETCH_ALL_CAP,
  RESULT_PAGE_ROWS,
  type KeyInfo,
  type KeyName,
  type KeyType,
} from "@table-craft/desktop/engine/protocol.js";
import type { AgentEngine } from "@table-craft/desktop/mcp/engines.js";
import { AGENT_TIMEOUT_SECONDS } from "@table-craft/desktop/mcp/queryTools.js";
import { jsonCell, jsonRows, textTable } from "@table-craft/desktop/mcp/render.js";
import {
  cancelOf,
  engineWith,
  exposedDatasource,
  rowCapOf,
  textResult,
  type Caller,
  type ToolContext,
  type ToolResult,
} from "@table-craft/desktop/mcp/toolKit.js";

/** SCAN batches one `scan_keys` call runs before it hands back a cursor, so a sparse match cannot spin. */
export const MAX_SCAN_BATCHES = 20;
const MS_PER_SECOND = 1000;

function keyName(text: string): KeyName {
  return { text, hex: null };
}

async function databaseOf(engine: AgentEngine, database: number | undefined): Promise<number> {
  if (database !== undefined) return database;
  const { databases } = await engine.call("keyspace.databases", {});
  return databases.find((candidate) => candidate.current)?.index ?? databases[0]?.index ?? 0;
}

function expiry(ttlMs: number | null): string {
  return ttlMs === null || ttlMs < 0 ? "no expiry" : `expires in ${String(Math.ceil(ttlMs / MS_PER_SECOND))} s`;
}

function keyLine(info: KeyInfo): string {
  return `- ${info.key.text} (${info.typeName ?? info.type ?? "unknown"}, ${expiry(info.ttlMs)})`;
}

export interface ScanRequest {
  readonly pattern: string;
  readonly database: number | undefined;
  readonly type: KeyType | undefined;
  readonly cursor: string | undefined;
  readonly limit: number;
}

export async function scanKeys(context: ToolContext, named: string, request: ScanRequest): Promise<ToolResult> {
  const datasource = exposedDatasource(context, named);
  const engine = await engineWith(context, datasource, ["keyValue"]);
  const database = await databaseOf(engine, request.database);
  const keys: KeyName[] = [];
  let cursor: string | null = request.cursor ?? null;
  let batches = 0;
  do {
    const batch = await engine.call("keyspace.scan", {
      database,
      cursor,
      match: request.pattern,
      keyType: request.type ?? null,
    });
    keys.push(...batch.keys);
    cursor = batch.cursor;
    batches += 1;
  } while (cursor !== null && keys.length < request.limit && batches < MAX_SCAN_BATCHES);
  const described = keys.length === 0 ? [] : await engine.call("keyspace.describe", { database, keys });
  const more = cursor === null ? [] : [`More keys may match: call scan_keys again with cursor "${cursor}".`];
  const lines =
    described.length === 0
      ? [`No keys match ${request.pattern} in database ${String(database)}.`]
      : described.map(keyLine);
  return textResult([...lines, ...more].join("\n"), {
    database,
    keys: described.map((info) => ({
      key: info.key.text,
      hex: info.key.hex,
      type: info.typeName ?? info.type,
      ttlMs: info.ttlMs,
    })),
    cursor,
  });
}

export async function getKey(
  context: ToolContext,
  caller: Caller,
  named: string,
  key: string,
  requested: number | undefined,
): Promise<ToolResult> {
  const datasource = exposedDatasource(context, named);
  const engine = await engineWith(context, datasource, ["keyValue"]);
  const database = await databaseOf(engine, requested);
  const opened = await context.runs.track(
    {
      clientId: caller.sessionId,
      clientName: caller.clientName,
      datasourceId: datasource.id,
      tool: "get_key",
      sql: key,
    },
    await cancelOf(engine, "read"),
    () =>
      engine.withSession("read", (sessionId) =>
        engine.call("keyspace.open", {
          sessionId,
          database,
          key: keyName(key),
          range: {},
          pageRows: RESULT_PAGE_ROWS,
          fetchAllCap: RESULT_FETCH_ALL_CAP,
          timeoutSeconds: AGENT_TIMEOUT_SECONDS,
        }),
      ),
  );
  const { details, statement, value } = opened;
  const head = [
    `${details.key.text} (${details.typeName ?? details.type ?? "unknown"}, ${expiry(details.ttlMs)})`,
    ...(details.length === null ? [] : [`Length: ${String(details.length)}`]),
  ];
  if (statement === null) {
    const cell = value === null ? null : jsonCell(value);
    const shown = typeof cell === "string" ? cell : JSON.stringify(cell);
    return textResult([...head, "Value:", shown].join("\n"), { database, details, value: cell });
  }
  await engine.call("result.release", { handle: statement.handle }).catch(() => undefined);
  const rows = statement.firstWindow.rows.slice(0, rowCapOf(context, datasource.id));
  const more =
    statement.rowCount > rows.length || !statement.complete
      ? [`Showing ${String(rows.length)} elements; read more with run_query and a range command.`]
      : [];
  return textResult([...head, textTable(statement.columns, rows), ...more].join("\n"), {
    database,
    details,
    columns: statement.columns.map((column) => ({ name: column.name, type: column.type })),
    rows: jsonRows(statement.columns, rows),
  });
}
