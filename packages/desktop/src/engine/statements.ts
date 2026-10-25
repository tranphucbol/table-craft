import {
  CONSOLE_READ_ONLY_REASONS,
  consoleEditable,
  editableIdentity,
  generateEdits,
  matchCondition,
  submitConsoleEdits,
  submitEdits,
  tableSelect,
  type RowEdit,
} from "@table-craft/core";
import {
  isPluginError,
  type BoundStatement,
  type Capability,
  type Column,
  type ColumnMeta,
  type SavepointStatements,
  type SqlLanguage,
  type Transactions,
} from "@table-craft/plugin-api";
import type { LiveContext, OpenSession, TableResult } from "@table-craft/desktop/engine/connection.js";
import {
  BUG_HINT,
  EngineFailure,
  STALE_CATALOG_REASON,
  explainFailed,
  messageOf,
  sessionBusy,
  statementFailed,
  transactionLost,
} from "@table-craft/desktop/engine/failures.js";
import type {
  ConditionColumn,
  ExecutedStatement,
  ExplainedStatement,
  ParameterValue,
  RequestOf,
  ResultEditable,
  ResultOf,
  ResultPaging,
  TableQuery,
  TransactionState,
} from "@table-craft/desktop/engine/protocol.js";

/** A result column the catalog does not know, described from what the driver reported. */
function reportedColumn(column: Column, index: number): ColumnMeta {
  return {
    name: column.name,
    position: index + 1,
    type: column.type ?? "",
    nullable: true,
    default: null,
    comment: null,
    autoIncrement: false,
  };
}

function savepointsOf(language: SqlLanguage): ((name: string) => SavepointStatements) | undefined {
  return language.savepoint?.bind(language);
}

/** What runs SQL on a console session: statements, explain, the table editor, its edits and transactions. */
export function statementRunners(live: LiveContext) {
  const {
    options,
    now,
    sqlLanguage,
    commandLanguage,
    consoleLanguage,
    results,
    relationOf,
    referencingKeys,
    completionCatalogOf,
    sessions,
    handles,
    cursors,
    tables,
    statements,
    ran,
    edited,
    afterClose,
    mustSettle,
    busyRefused,
    sessionFor,
    namespaceOf,
    noteNamespace,
    ownedHandle,
    needsCheck,
    abandon,
    reconnect,
    ensureLive,
    onLiveSession,
  } = live;

  async function runStatement(
    sessionId: string,
    sql: string,
    parameters: Readonly<Record<string, ParameterValue>> | undefined,
    paging: ResultPaging,
    timeoutSeconds: number,
    node?: string,
  ): Promise<ExecutedStatement> {
    const open = sessionFor(sessionId);
    let bound: BoundStatement = { sql, params: [] };
    try {
      // A command language has no placeholders (decision 112): the line runs as written.
      if (parameters !== undefined && commandLanguage() === null) bound = sqlLanguage().bind(sql, parameters);
    } catch (cause) {
      throw statementFailed(cause, options.datasource.readOnly);
    }
    const executeOptions = node === undefined ? undefined : { node };
    open.running += 1;
    try {
      const { value: summary, reconnected } = await onLiveSession(
        sessionId,
        open,
        timeoutSeconds,
        (session) =>
          session.execute(bound.sql, bound.params, executeOptions).then(async (result) => {
            const put = await results.put(result, paging);
            return result.reply === undefined ? put : { ...put, reply: result.reply };
          }),
        (cause) => statementFailed(cause, options.datasource.readOnly, bound.sql === sql ? sql : undefined),
        (late) => void results.release(late.handle),
      );
      if (sessions.get(sessionId) !== open) {
        // The session closed while the statement ran; nobody is left to release this result.
        await results.release(summary.handle);
        sessionFor(sessionId);
      }
      handles.set(summary.handle, sessionId);
      if (!open.moved) statements.set(summary.handle, sql);
      ran.set(summary.handle, sql);
      if (summary.cursorOpen) cursors.set(sessionId, summary.handle);
      // An open cursor keeps the session busy, and no statement that switches returns rows.
      // A statement that switches namespaces, or ends a transaction that may have, is followed by a read.
      const statement = consoleLanguage().classify(bound.sql);
      const switches = statement.setsNamespace === true;
      const moves = !summary.cursorOpen && (switches || statement.kind === "transaction");
      const namespace = moves ? await namespaceOf(open) : undefined;
      if (moves) noteNamespace(open, namespace, switches);
      if (switches) open.switchedBy = bound.params.length === 0 ? bound.sql : null;
      if (!open.moved) open.switchedBy = null;
      return {
        ...summary,
        firstWindow: results.window(summary.handle, 0),
        transactionOpen: open.session.transactions?.open ?? false,
        ...(namespace === undefined ? {} : { namespace }),
        ...(reconnected === undefined ? {} : { reconnected }),
      };
    } finally {
      open.running -= 1;
      open.lastUsed = now();
    }
  }

  async function explainStatement(request: RequestOf<"statement.explain">): Promise<ExplainedStatement> {
    const open = sessionFor(request.sessionId);
    const needed: Capability = request.analyze ? "explainAnalyze" : "explain";
    if (!open.capabilities.includes(needed) || open.session.explain === undefined) {
      throw new EngineFailure({
        code: "invalidRequest",
        message: `This datasource's plugin does not declare the ${needed} capability.`,
        hint: BUG_HINT,
      });
    }
    open.running += 1;
    try {
      const { value: plan, reconnected } = await onLiveSession(
        request.sessionId,
        open,
        request.timeoutSeconds ?? 0,
        (session) => {
          if (session.explain === undefined) throw new Error("The session lost its explain method.");
          return session.explain(request.sql, { analyze: request.analyze });
        },
        (cause) => explainFailed(cause, options.datasource.readOnly),
      );
      sessionFor(request.sessionId);
      return {
        plan,
        transactionOpen: open.session.transactions?.open ?? false,
        ...(reconnected === undefined ? {} : { reconnected }),
      };
    } finally {
      open.running -= 1;
      open.lastUsed = now();
    }
  }

  async function queryTable(request: RequestOf<"table.query">): Promise<TableQuery> {
    const open = sessionFor(request.sessionId);
    const { relation, qualified } = await relationOf(request.path, request.relation);
    const sql = tableSelect(qualified, request);
    const statement = await runStatement(request.sessionId, sql, undefined, request, request.timeoutSeconds ?? 0);
    const catalogued = statement.columns.map((column) => relation.columns.find((meta) => meta.name === column.name));
    const columns = catalogued.map(
      (meta, index) => meta ?? reportedColumn(statement.columns[index] ?? { name: "", type: null }, index),
    );
    const stale = statement.columns.length !== relation.columns.length || catalogued.includes(undefined);
    const resolved = editableIdentity(relation, options.datasource.readOnly, open.capabilities);
    const editable = "identity" in resolved && stale ? { readOnly: STALE_CATALOG_REASON } : resolved;
    tables.set(statement.handle, {
      table: qualified,
      columns: columns.map((meta) => ({ name: meta.name, type: meta.type, default: meta.default })),
      identity:
        "identity" in editable ? editable.identity.map((name) => columns.findIndex((meta) => meta.name === name)) : [],
      readOnly: "readOnly" in editable ? editable.readOnly : null,
    });
    const referencing = await referencingKeys(request.path, request.relation);
    return { statement, sql, editable, columns, foreignKeys: relation.foreignKeys, referencing };
  }

  /** Whether a console result can be edited (decision 056); remembers an editable one for `edits.*`. */
  async function resultEditable(request: RequestOf<"result.editable">): Promise<ResultEditable> {
    const handle = ownedHandle(request.handle);
    const open = sessionFor(handles.get(handle) ?? "");
    const reported = results.columns(handle);
    const fallback = reported.map(reportedColumn);
    const readOnly = (reason: string): ResultEditable => {
      edited.delete(handle);
      return { editable: { readOnly: reason }, columns: fallback, readOnlyColumns: reported.map(() => true) };
    };
    const language = sqlLanguage();
    const sql = ran.get(handle);
    if (sql === undefined || language.selectSource === undefined || tables.has(handle)) {
      return readOnly(CONSOLE_READ_ONLY_REASONS.unsupported);
    }
    const source = await language.selectSource(sql, await completionCatalogOf(request.current));
    const described = source.kind === "table" ? await relationOf(source.path, source.relation) : null;
    const checked = consoleEditable({
      source,
      relation: described?.relation ?? null,
      qualified: described?.qualified ?? "",
      result: reported,
      readOnly: options.datasource.readOnly,
      capabilities: open.capabilities,
    });
    if (checked.kind === "readOnly") return readOnly(checked.reason);
    if (!handles.has(handle)) return readOnly(CONSOLE_READ_ONLY_REASONS.unsupported);
    edited.set(handle, { ...checked.table, readOnly: null });
    const identity = checked.table.identity.map((index) => checked.table.columns[index]?.name ?? "");
    return {
      editable: { identity },
      columns: checked.columns.map(
        (meta, index) => meta ?? fallback[index] ?? reportedColumn({ name: "", type: null }, index),
      ),
      readOnlyColumns: checked.table.columns.map((column) => column.readOnly),
    };
  }

  function tableFor(handle: string): TableResult {
    const owned = ownedHandle(handle);
    const table = tables.get(owned) ?? edited.get(owned);
    if (table === undefined) {
      throw new EngineFailure({
        code: "invalidRequest",
        message: "That result did not come from the table editor.",
        hint: BUG_HINT,
      });
    }
    return table;
  }

  function editStatements(handle: string, edits: readonly RowEdit[]): string[] {
    const table = tableFor(handle);
    if (table.readOnly !== null) {
      throw new EngineFailure({
        code: "invalidRequest",
        message: table.readOnly,
        hint: "Edit it with statements in a console.",
      });
    }
    const held = results.heldRows(handle);
    return generateEdits({ ...table, rows: (row) => held[row], edits, language: sqlLanguage() });
  }

  async function submit(request: RequestOf<"edits.submit">): Promise<ResultOf<"edits.submit">> {
    const open = sessionFor(request.sessionId);
    if (handles.get(request.handle) !== request.sessionId) {
      throw new EngineFailure({
        code: "invalidRequest",
        message: "That table result belongs to another session.",
        hint: BUG_HINT,
      });
    }
    const statements = editStatements(request.handle, request.edits);
    if (edited.has(request.handle)) return submitConsole(request.sessionId, open, statements);
    if (mustSettle(request.sessionId, open)) await afterClose(request.sessionId, open);
    return { ...(await submitEdits(open.session, statements)), transactionOpen: false };
  }

  /**
   * A console result's edits on the console's own session (decision 056). Like a statement, they
   * wait for a closing cursor and prove an idle session alive first; a transaction the session lost
   * is reported, never silently replaced (plans 025, 027).
   */
  async function submitConsole(
    sessionId: string,
    open: OpenSession,
    statements: readonly string[],
  ): Promise<ResultOf<"edits.submit">> {
    if (open.lost !== null && open.session.transactions?.open === true) throw transactionLost();
    const settled = mustSettle(sessionId, open) ? await afterClose(sessionId, open) : undefined;
    if (settled === undefined && needsCheck(open)) await ensureLive(sessionId, open);
    open.running += 1;
    try {
      const submitted = await submitConsoleEdits(open.session, statements, savepointsOf(sqlLanguage()));
      return { ...submitted, transactionOpen: open.session.transactions?.open ?? false };
    } catch (cause) {
      if (isPluginError(cause) && cause.code === "sessionBusy") {
        throw busyRefused(sessionId, open).transaction ? transactionLost() : sessionBusy();
      }
      if (isPluginError(cause) && cause.code === "connectionLost") {
        if (abandon(sessionId, open, "driver reported").transaction) throw transactionLost();
        throw statementFailed(cause, options.datasource.readOnly);
      }
      throw cause;
    } finally {
      open.running -= 1;
      open.lastUsed = now();
    }
  }

  function condition(handle: string, rows: readonly number[], columns: readonly ConditionColumn[]): string {
    const held = results.heldRows(ownedHandle(handle));
    const table = tables.get(handle);
    const reported = results.columns(handle);
    const typed = columns.map(({ column, name }) => ({
      name,
      type: table?.columns[column]?.type ?? reported[column]?.type ?? null,
    }));
    const tuples = rows.map((index) => {
      const row = held[index];
      if (row === undefined) {
        throw new EngineFailure({
          code: "invalidRequest",
          message: `Row ${String(index + 1)} is not held by this result.`,
          hint: "Reload the table and choose the cell again.",
        });
      }
      return columns.map(({ column }) => row[column] ?? null);
    });
    return matchCondition(sqlLanguage(), typed, tuples);
  }

  async function transact(
    sessionId: string,
    change: (transactions: Transactions) => Promise<void>,
    hint: string,
  ): Promise<TransactionState> {
    const open = sessionFor(sessionId);
    const { transactions } = open.session;
    if (!open.capabilities.includes("transactions") || transactions === undefined) {
      throw new EngineFailure({
        code: "invalidRequest",
        message: "This datasource's plugin does not declare the transactions capability.",
        hint: BUG_HINT,
      });
    }
    if (open.lost !== null) await reconnect(sessionId, open);
    if (mustSettle(sessionId, open)) await afterClose(sessionId, open);
    const current = open.session.transactions ?? transactions;
    try {
      await change(current);
    } catch (cause) {
      if (isPluginError(cause) && cause.code === "sessionBusy") {
        throw busyRefused(sessionId, open).transaction ? transactionLost() : sessionBusy();
      }
      throw new EngineFailure({ code: "statementFailed", message: messageOf(cause), hint }, cause);
    }
    const namespace = await namespaceOf(open);
    noteNamespace(open, namespace, false);
    return {
      mode: current.mode,
      transactionOpen: current.open,
      ...(namespace === undefined ? {} : { namespace }),
    };
  }

  return {
    runStatement,
    explainStatement,
    queryTable,
    resultEditable,
    tableFor,
    editStatements,
    submit,
    submitConsole,
    condition,
    transact,
  };
}
