import {
  RESULT_FETCH_ALL_CAP,
  RESULT_PAGE_ROWS,
  type ClassifiedStatement,
  type Column,
  type ExecutedStatement,
  type FormatOptions,
  type PlanNode,
} from "@table-craft/desktop/engine/protocol.js";
import { accessVerdict } from "@table-craft/desktop/mcp/access.js";
import { EngineCallError, type AgentEngine, type SessionMode } from "@table-craft/desktop/mcp/engines.js";
import type { AgentDatasource } from "@table-craft/desktop/mcp/messages.js";
import { jsonRows, textTable } from "@table-craft/desktop/mcp/render.js";
import { PAGE_ROWS_RANGE } from "@table-craft/desktop/settings/settings.js";
import {
  engineWith,
  exposedDatasource,
  cancelOf,
  rowCapOf,
  textResult,
  timeoutOf,
  ToolFailure,
  waitForApproval,
  type Caller,
  type ToolContext,
  type ToolResult,
} from "@table-craft/desktop/mcp/toolKit.js";

/** Results an agent keeps open; the oldest is released past it, so a chatty agent cannot pin rows. */
export const MAX_OPEN_RESULTS = 16;
const PLAN_INDENT = "  ";

const FORMAT: FormatOptions = {
  style: "standard",
  keywordCase: "upper",
  indentWidth: 2,
  linesBetweenStatements: 1,
  alignAliases: false,
};

interface OpenResult {
  readonly datasourceId: string;
  readonly handle: string;
  readonly sql: string;
  readonly mode: SessionMode;
  readonly columns: readonly Column[];
  /** Its row limit is in its SQL, so more rows mean running the statement again (decision 162). */
  readonly reruns: boolean;
  rowCount: number;
  complete: boolean;
}

type HistoryOutcome = "success" | "error" | "cancelled";

/** A statement run_query ran, and the session it ran on. */
interface Ran {
  readonly datasource: AgentDatasource;
  readonly sql: string;
  readonly mode: SessionMode;
}

export interface QueryTools {
  runQuery(caller: Caller, named: string, sql: string, reason: string | null): Promise<ToolResult>;
  fetchRows(
    caller: Caller,
    handle: string,
    offset: number,
    limit: number | undefined,
    reason: string | null,
  ): Promise<ToolResult>;
  closeResult(handle: string): Promise<ToolResult>;
  /** The datasource and statement of a result still open, or null. */
  resultOf(handle: string): { readonly datasourceId: string; readonly sql: string } | null;
  explain(caller: Caller, named: string, sql: string): Promise<ToolResult>;
  formatSql(named: string, sql: string): Promise<ToolResult>;
}

async function oneStatement(engine: AgentEngine, sql: string): Promise<ClassifiedStatement> {
  const statements = await engine.call("script.split", { text: sql });
  const [statement] = statements;
  if (statement === undefined) throw new ToolFailure("There is no statement to run.");
  if (statements.length > 1) {
    throw new ToolFailure(`Send one statement per call; this text holds ${String(statements.length)}.`);
  }
  return statement;
}

function rowsText(
  columns: readonly Column[],
  rows: readonly (readonly unknown[])[],
  offset: number,
  total: string,
): string {
  if (rows.length === 0) return `No rows at offset ${String(offset)}${total}.`;
  const first = offset + 1;
  const last = offset + rows.length;
  return `${textTable(columns, rows as never)}\nRows ${String(first)}–${String(last)}${total}.`;
}

function totalText(rowCount: number, complete: boolean): string {
  return complete ? ` of ${String(rowCount)}` : ` of at least ${String(rowCount)}`;
}

/** Records one agent run in the query history; the time spent waiting for the user is left out. */
function historyRecorder(
  context: ToolContext,
  caller: Caller,
  datasourceId: string,
  sql: string,
): (outcome: HistoryOutcome, rowCount: number | null, message: string | null, text?: string) => void {
  const startedAt = context.now();
  return (outcome, rowCount, message, text = sql) =>
    context.record({
      datasourceId,
      sql: text,
      startedAt,
      durationMs: Math.max(0, context.now() - startedAt - caller.waits.ms()),
      outcome,
      rowCount,
      message,
      client: caller.clientName,
    });
}

function recordFailure(record: ReturnType<typeof historyRecorder>, cause: unknown, text: string): void {
  if (cause instanceof ToolFailure)
    record(cause.outcome === "error" ? "error" : "cancelled", null, cause.message, text);
  else if (cause instanceof EngineCallError)
    record(cause.code === "cancelled" ? "cancelled" : "error", null, cause.message, cause.sent ?? text);
}

function planLines(nodes: readonly PlanNode[], depth: number): string[] {
  return nodes.flatMap((node) => {
    const estimate = [
      node.estimatedRows === null ? null : `rows≈${String(node.estimatedRows)}`,
      node.estimatedCost === null ? null : `cost=${String(node.estimatedCost)}`,
    ].filter((part) => part !== null);
    const head = `${PLAN_INDENT.repeat(depth)}${node.operation}${node.target === null ? "" : ` ${node.target}`}`;
    const detail = node.detail === null ? "" : ` — ${node.detail}`;
    const line = `${head}${estimate.length === 0 ? "" : ` (${estimate.join(", ")})`}${detail}`;
    return [line, ...planLines(node.children, depth + 1)];
  });
}

/** Each distinct warning once: a scan over many partitions warns about its table once. */
function planWarnings(nodes: readonly PlanNode[]): string[] {
  const warnings = new Set<string>();
  const walk = (level: readonly PlanNode[]): void => {
    for (const node of level) {
      for (const warning of node.warnings ?? []) warnings.add(warning);
      walk(node.children);
    }
  };
  walk(nodes);
  return [...warnings];
}

export function createQueryTools(context: ToolContext): QueryTools {
  const results = new Map<string, OpenResult>();
  let next = 0;

  async function release(id: string): Promise<void> {
    const open = results.get(id);
    if (open === undefined) return;
    results.delete(id);
    const engine = await context.engines.engine(open.datasourceId);
    await engine.call("result.release", { handle: open.handle }).catch(() => undefined);
  }

  async function keep(ran: Ran, executed: ExecutedStatement): Promise<string> {
    next += 1;
    const id = `r${String(next)}`;
    results.set(id, {
      datasourceId: ran.datasource.id,
      handle: executed.handle,
      sql: ran.sql,
      mode: ran.mode,
      columns: executed.columns,
      reruns: executed.refetch === true,
      rowCount: executed.rowCount,
      complete: executed.complete,
    });
    const oldest = results.keys().next().value;
    if (results.size > MAX_OPEN_RESULTS && oldest !== undefined) await release(oldest);
    return id;
  }

  async function approved(
    caller: Caller,
    datasource: AgentDatasource,
    statement: ClassifiedStatement,
    reason: string | null,
  ): Promise<SessionMode> {
    const verdict = accessVerdict(datasource.access, statement);
    if (verdict.kind === "read") return "read";
    if (verdict.kind === "refuse") throw new ToolFailure(verdict.reason, "refused");
    await waitForApproval(context, caller, datasource, {
      sql: statement.sql,
      kind: verdict.approval,
      subject: "statement",
      database: null,
      destructive: statement.destructive,
      reason,
      allowable: verdict.allowable,
    });
    // An approved read keeps the read-only session, so the server still refuses a misclassified write.
    return verdict.approval === "read" ? "read" : "write";
  }

  async function answer(ran: Ran, executed: ExecutedStatement): Promise<ToolResult> {
    const { datasource } = ran;
    const messages = (executed.messages ?? []).map((message) => `${message.level}: ${message.text}`);
    if (executed.columns.length === 0) {
      await context.engines
        .engine(datasource.id)
        .then((engine) => engine.call("result.release", { handle: executed.handle }))
        .catch(() => undefined);
      const affected = executed.rowsAffected ?? 0;
      const counted = `${String(affected)} ${affected === 1 ? "row" : "rows"} affected.`;
      return textResult([counted, ...messages].join("\n"), {
        rowsAffected: affected,
        messages,
      });
    }
    const rows = executed.firstWindow.rows.slice(0, rowCapOf(context, datasource.id));
    const more = !executed.complete || executed.rowCount > rows.length;
    const handle = more ? await keep(ran, executed) : null;
    if (!more)
      await context.engines
        .engine(datasource.id)
        .then((engine) => engine.call("result.release", { handle: executed.handle }))
        .catch(() => undefined);
    const footer =
      handle === null ? [] : [`More rows: call fetch_rows with handle "${handle}" and offset ${String(rows.length)}.`];
    const text = [
      rowsText(executed.columns, rows, 0, totalText(executed.rowCount, executed.complete)),
      ...footer,
      ...messages,
    ].join("\n");
    return textResult(text, {
      columns: executed.columns.map((column) => ({ name: column.name, type: column.type })),
      rows: jsonRows(executed.columns, rows),
      rowCount: executed.rowCount,
      complete: executed.complete,
      handle,
      messages,
    });
  }

  async function readOn(engine: AgentEngine, open: OpenResult, wanted: number): Promise<void> {
    while (!open.complete && open.rowCount < wanted) {
      // One fetch for every row still missing: a result whose row limit is in its SQL runs again per fetch (decision 162).
      const missing = wanted - open.rowCount;
      const state = await engine.call("result.fetchMore", {
        handle: open.handle,
        all: false,
        pageRows: Math.min(PAGE_ROWS_RANGE.max, Math.max(RESULT_PAGE_ROWS, missing)),
        fetchAllCap: RESULT_FETCH_ALL_CAP,
      });
      if (state.rowCount === open.rowCount && !state.complete) break;
      open.rowCount = state.rowCount;
      open.complete = state.complete;
    }
  }

  /**
   * Rows past the held ones of a result whose row limit is in its SQL: the database reads every row
   * up to the last one asked for again, so the user approves it like a statement, and it shows in
   * the history and the Services tree.
   */
  async function rerun(
    caller: Caller,
    engine: AgentEngine,
    open: OpenResult,
    wanted: number,
    reason: string | null,
  ): Promise<void> {
    const datasource = exposedDatasource(context, open.datasourceId);
    const record = historyRecorder(context, caller, datasource.id, open.sql);
    try {
      await waitForApproval(context, caller, datasource, {
        sql: open.sql,
        kind: "read",
        subject: "rerun",
        database: null,
        rerunRows: Math.min(Math.max(wanted, open.rowCount + RESULT_PAGE_ROWS), RESULT_FETCH_ALL_CAP),
        destructive: null,
        reason,
        allowable: true,
      });
      await context.runs.track(
        {
          clientId: caller.sessionId,
          clientName: caller.clientName,
          datasourceId: datasource.id,
          tool: "fetch_rows",
          sql: open.sql,
        },
        await cancelOf(engine, open.mode),
        () => readOn(engine, open, wanted),
      );
      record("success", open.rowCount, null);
    } catch (cause) {
      recordFailure(record, cause, open.sql);
      throw cause;
    }
  }

  return {
    async runQuery(caller, named, sql, reason) {
      const datasource = exposedDatasource(context, named);
      const record = historyRecorder(context, caller, datasource.id, sql);
      let statement: ClassifiedStatement | null = null;
      try {
        const engine = await engineWith(context, datasource, [], ["sql", "commands"]);
        statement = await oneStatement(engine, sql);
        const mode = await approved(caller, datasource, statement, reason);
        const ran = statement.sql;
        const executed = await context.runs.track(
          {
            clientId: caller.sessionId,
            clientName: caller.clientName,
            datasourceId: datasource.id,
            tool: "run_query",
            sql: ran,
          },
          await cancelOf(engine, mode),
          () =>
            engine.withSession(mode, (sessionId) =>
              engine.call("statement.execute", {
                sessionId,
                sql: ran,
                pageRows: RESULT_PAGE_ROWS,
                fetchAllCap: RESULT_FETCH_ALL_CAP,
                ...timeoutOf(context, datasource.id),
              }),
            ),
        );
        const rows = executed.columns.length === 0 ? executed.rowsAffected : executed.rowCount;
        record("success", rows, null, executed.sent ?? ran);
        return await answer({ datasource, sql: ran, mode }, executed);
      } catch (cause) {
        recordFailure(record, cause, statement?.sql ?? sql);
        throw cause;
      }
    },
    async fetchRows(caller, handle, offset, limit, reason) {
      const open = results.get(handle);
      if (open === undefined)
        throw new ToolFailure(`No open result "${handle}"; it was closed or replaced. Run the query again.`);
      const cap = rowCapOf(context, open.datasourceId);
      const count = Math.min(limit ?? cap, cap);
      const engine = await context.engines.engine(open.datasourceId);
      const wanted = offset + count;
      if (!open.complete && open.rowCount < wanted) {
        if (open.reruns) await rerun(caller, engine, open, wanted, reason);
        else await readOn(engine, open, wanted);
      }
      const window = await engine.call("result.window", { handle: open.handle, offset, limit: count });
      const total = totalText(open.rowCount, open.complete);
      return textResult(rowsText(open.columns, window.rows, offset, total), {
        rows: jsonRows(open.columns, window.rows),
        offset,
        rowCount: open.rowCount,
        complete: open.complete,
      });
    },
    resultOf(handle) {
      const open = results.get(handle);
      return open === undefined ? null : { datasourceId: open.datasourceId, sql: open.sql };
    },
    async closeResult(handle) {
      if (!results.has(handle)) throw new ToolFailure(`No open result "${handle}".`);
      await release(handle);
      return textResult(`Closed ${handle}.`);
    },
    async explain(caller, named, sql) {
      const datasource = exposedDatasource(context, named);
      const engine = await engineWith(context, datasource, ["sql", "explain"]);
      const statement = await oneStatement(engine, sql);
      const explainable = await engine.call("sql.explainable", { sql: statement.sql, analyze: false });
      if (!explainable.ok) throw new ToolFailure(explainable.reason, "refused");
      const explained = await context.runs.track(
        {
          clientId: caller.sessionId,
          clientName: caller.clientName,
          datasourceId: datasource.id,
          tool: "explain",
          sql: statement.sql,
        },
        await cancelOf(engine, "read"),
        () =>
          engine.withSession("read", (sessionId) =>
            engine.call("statement.explain", {
              sessionId,
              sql: statement.sql,
              analyze: false,
              ...timeoutOf(context, datasource.id),
            }),
          ),
      );
      const { plan } = explained;
      const tree = planLines(plan.roots, 0);
      const summary = plan.summary.map((property) => `${property.name}: ${property.value}`);
      const warnings = planWarnings(plan.roots);
      const warned = warnings.length === 0 ? [] : ["", "Warnings:", ...warnings.map((warning) => `- ${warning}`)];
      return textResult([...tree, ...summary, ...warned, "", "Raw:", plan.raw].join("\n"), {
        statement: plan.statement,
        raw: plan.raw,
      });
    },
    async formatSql(named, sql) {
      const datasource = exposedDatasource(context, named);
      const engine = await engineWith(context, datasource, ["sql"]);
      const formatted = await engine.call("sql.format", { text: sql, options: FORMAT });
      return textResult(formatted, { sql: formatted });
    },
  };
}
