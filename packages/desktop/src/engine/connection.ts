import { CoreError, TunnelError, type EditTable, type ResultState } from "@table-craft/core";
import {
  isPluginError,
  type BytesValue,
  type Capability,
  type Column,
  type KeySource,
  type Row,
  type ServerSession,
  type Session,
} from "@table-craft/plugin-api";
import { MS_PER_SECOND, connectDatasource, drained } from "@table-craft/desktop/engine/connect.js";
import type { EngineContext } from "@table-craft/desktop/engine/context.js";
import type { ExportJob, ExportRows } from "@table-craft/desktop/engine/exports.js";
import {
  BUG_HINT,
  EngineFailure,
  RECONNECT_HINT,
  exportDraining,
  lostInFlight,
  messageOf,
  timedOut,
  transactionLost,
  waitCancelled,
} from "@table-craft/desktop/engine/failures.js";
import type {
  CurrentNamespace,
  EngineEvent,
  ExportFormat,
  Reconnection,
  SessionsListing,
} from "@table-craft/desktop/engine/protocol.js";
import { statementRunners } from "@table-craft/desktop/engine/statements.js";
import { bytesRunners } from "@table-craft/desktop/engine/bytes.js";
import { keyOperations } from "@table-craft/desktop/engine/keyOperations/index.js";
import { SessionLost, StatementTimedOut, watchStatement, type LostReason } from "@table-craft/desktop/engine/watch.js";

export interface OpenSession {
  /** Replaced, under the same session id, when the engine reconnects (decision 054). */
  session: Session;
  readonly capabilities: readonly Capability[];
  /** Asked for at `session.open`, or the datasource's flag; a reconnect keeps it. */
  readonly readOnly: boolean;
  /** Statements in flight: `statement.execute` calls that have not answered yet. */
  running: number;
  /** Where the session started, as `currentNamespace` read it; undefined when it could not say. */
  opening: CurrentNamespace | undefined;
  /** When the session last finished a statement, for the idle ping. */
  lastUsed: number;
  /** Why the session was given up, so the next statement reconnects; null while it is usable. */
  lost: string | null;
  /**
   * Whether a statement may have moved the session off `opening` (decision 048). Its reads then
   * resolve names a fresh session would resolve elsewhere, so an export must not re-run them.
   */
  moved: boolean;
  /**
   * The last statement that switched the namespace, replayed on a reconnect so a console that ran
   * `USE db` stays in it; null when the session is where it opened.
   */
  switchedBy: string | null;
  /**
   * The session's last result still closing (decision 058): the next statement waits for it, so
   * the plugin never sees two at once. Null when nothing is closing.
   */
  closing: Promise<void> | null;
  /** Rejects the statements waiting on `closing`, for a cancel that arrives before they run. */
  readonly waiting: Set<() => void>;
  /** Exports draining this session's cursor; the session runs nothing else meanwhile. */
  exporting: number;
}

function samePath(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((part, index) => part === b[index]);
}

/** How long an idle session's ping may take before the engine reconnects instead (decision 054). */
const PING_TIMEOUT_MS = 5_000;
/** How long a timed-out statement may take to end once cancelled before its session is dropped. */
const CANCEL_GRACE_MS = 5_000;
/**
 * How long a probe connection may stay silent while a statement runs. A reachable server accepts
 * or refuses within milliseconds; TCP keepalive alone cannot tell, because a hop that answers TCP
 * itself (Docker Desktop, an SSH tunnel) keeps the statement's socket looking alive.
 */
const PROBE_WINDOW_MS = 5_000;

const LOST_REASONS: Readonly<Record<LostReason, string>> = {
  cancelUnanswered: "cancel unanswered",
  serverUnreachable: "server unreachable",
};

/** Null when `session` answered its ping in time; else why it counts as lost. */
async function pingFailure(session: Session): Promise<string | null> {
  if (session.ping === undefined) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const silence = new Promise<string>((resolve) => {
    timer = setTimeout(() => {
      resolve("ping timed out");
    }, PING_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      session.ping().then(
        () => null,
        () => "ping failed",
      ),
      silence,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
/**
 * Closing a cursor waits for the server to answer, which a dead or silent link never does; past this
 * the sessions close anyway, and their bounded close tears the sockets down (decision 040).
 */
const RELEASE_GRACE_MS = 3_000;
/**
 * How long a statement waits for the session's last result to finish closing (decision 058). A
 * close reads the rest of the result off the wire where the server cannot stop it (TiDB before
 * 6.1), so past this the session is given up rather than awaited.
 */
const CURSOR_CLOSE_GRACE_MS = 5_000;

function settledWithin(work: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void work.finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function* heldThenRest(held: readonly Row[], rest: AsyncIterable<Row>): AsyncGenerator<Row> {
  yield* held;
  yield* rest;
}

async function* heldRows(held: readonly Row[]): AsyncGenerator<Row> {
  await Promise.resolve();
  yield* held;
}

/** Whether `row` is `session`'s own connection, by id and, where ids repeat across a cluster, instance. */
function isListedAs(session: Session, row: ServerSession): boolean {
  if (session.serverSessionId !== row.id) return false;
  return session.serverInstance === undefined || session.serverInstance === row.instance;
}

/** What the engine remembers about a `table.query` result so edits and conditions can be written. */
export interface TableResult extends EditTable {
  /** Why the table cannot be edited, or null when it can (decision 026). */
  readonly readOnly: string | null;
}

function liveContext(context: EngineContext, emit: (event: EngineEvent) => void) {
  const {
    options,
    now,
    connector,
    sessionLog,
    sqlLanguage,
    results,
    listServerSessions,
    tasks,
    exportRowsOf,
    imports,
    scripts,
  } = context;

  const sessions = new Map<string, OpenSession>();
  const keyResources = keyOperations(context);
  /** Each live result handle, mapped to the session that produced it. */
  const handles = new Map<string, string>();
  /** The one result per session whose cursor is still open (decision 025). */
  const cursors = new Map<string, string>();
  /** The handles `table.query` produced, with what editing them needs. */
  const tables = new Map<string, TableResult>();
  /** The statement behind each handle, so an export can run it again on a session of its own. */
  const statements = new Map<string, string>();
  /** The text each console statement ran, so `result.editable` can read where its rows came from. */
  const ran = new Map<string, string>();
  /** The console results `result.editable` found editable, with what editing them needs (decision 056). */
  const edited = new Map<string, TableResult>();
  /** Files `result.loadBytes` read for a result's edits, by id, until the result is released (plan 043). */
  const staged = new Map<string, { readonly handle: string; readonly bytes: BytesValue }>();
  /** The one key each console command result read, so `result.editable` can edit it as the key (decision 119). */
  const keySources = new Map<string, KeySource>();
  const unsubscribe = tasks.subscribe(emit);
  const unsubscribeImports = imports.subscribe(emit);
  const unsubscribeScripts = scripts.subscribe(emit);

  function forget(handle: string): void {
    handles.delete(handle);
    tables.delete(handle);
    statements.delete(handle);
    ran.delete(handle);
    edited.delete(handle);
    for (const [id, entry] of staged) if (entry.handle === handle) staged.delete(id);
    keySources.delete(handle);
  }

  async function releaseHandlesOf(sessionId: string): Promise<void> {
    cursors.delete(sessionId);
    const owned = [...handles].filter(([, owner]) => owner === sessionId).map(([handle]) => handle);
    for (const handle of owned) forget(handle);
    await Promise.all(owned.map((handle) => results.release(handle)));
  }

  /** Records `work` as closing `sessionId`'s last result, which the next statement waits for. */
  function noteClosing(sessionId: string, work: Promise<unknown>): void {
    const open = sessions.get(sessionId);
    if (open === undefined) return;
    const settled = work.then(
      () => undefined,
      () => undefined,
    );
    const previous = open.closing;
    const closing = previous === null ? settled : Promise.all([previous, settled]).then(() => undefined);
    open.closing = closing;
    void closing.then(() => {
      if (open.closing === closing) open.closing = null;
    });
  }

  /** Starts closing the session's open cursor, if any; the session's next statement waits for it. */
  function closeCursorOf(sessionId: string): Promise<void> {
    const handle = cursors.get(sessionId);
    if (handle === undefined) return Promise.resolve();
    cursors.delete(sessionId);
    const closed = results.closeCursor(handle).then(
      () => undefined,
      () => undefined,
    );
    noteClosing(sessionId, closed);
    return closed;
  }

  /**
   * Waits, within `CURSOR_CLOSE_GRACE_MS`, for the session's last result to close (decision 058).
   * A close that outlasts it gives the session up and reconnects; with a transaction open that
   * is the transaction-lost error. A cancel while waiting rejects before anything runs.
   */
  async function afterClose(sessionId: string, open: OpenSession): Promise<Reconnection | undefined> {
    void closeCursorOf(sessionId);
    const { closing } = open;
    if (closing === null) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stop = (): void => undefined;
    const outcome = await new Promise<"closed" | "timedOut" | "cancelled">((resolve) => {
      stop = () => {
        resolve("cancelled");
      };
      open.waiting.add(stop);
      timer = setTimeout(() => {
        resolve("timedOut");
      }, CURSOR_CLOSE_GRACE_MS);
      void closing.then(() => {
        resolve("closed");
      });
    }).finally(() => {
      clearTimeout(timer);
      open.waiting.delete(stop);
    });
    if (outcome === "closed") return undefined;
    if (outcome === "cancelled") throw waitCancelled();
    sessionLog?.warn("result not closed", { graceMs: CURSOR_CLOSE_GRACE_MS });
    if (abandon(sessionId, open, "result not closed").transaction) throw transactionLost();
    return { ...(await reconnect(sessionId, open)), reason: "resultNotClosed" };
  }

  /** Whether the session has anything to wait for before its next statement. */
  function mustSettle(sessionId: string, open: OpenSession): boolean {
    if (open.exporting > 0) throw exportDraining();
    return open.closing !== null || cursors.has(sessionId);
  }

  /**
   * A plugin that refuses a statement as busy after the engine waited for every close is a bug
   * (decision 058): logged with what the engine knew, then the session is replaced.
   */
  function busyRefused(sessionId: string, open: OpenSession): { transaction: boolean } {
    sessionLog?.error("session busy", {
      running: open.running,
      cursorOpen: cursors.has(sessionId),
      closing: open.closing !== null,
      exporting: open.exporting,
    });
    return abandon(sessionId, open, "session busy");
  }

  function track(handle: string, state: ResultState): ResultState {
    const owner = handles.get(handle);
    if (owner !== undefined && !state.cursorOpen && cursors.get(owner) === handle) cursors.delete(owner);
    return state;
  }

  function chosenColumns(handle: string, indices: readonly number[]): Column[] {
    const all = results.columns(handle);
    return indices.map((index) => {
      const column = all[index];
      if (column === undefined) {
        throw new EngineFailure({
          code: "invalidRequest",
          message: `Column ${String(index)} is outside this result's ${String(all.length)} columns.`,
          hint: BUG_HINT,
        });
      }
      return column;
    });
  }

  /**
   * Where a result's export reads from (decision 040): its statement again on a session of the
   * export's own when it is a read that sees what any session sees; else the rows held when
   * the cursor is done; else the console's own cursor, drained.
   */
  /** The rows a local filter shows, from memory: they are already decided (decision 050). */
  function shownJob(handle: string, projection: readonly number[], format: ExportFormat, path: string): ExportJob {
    const table = tables.get(handle)?.table;
    const language = sqlLanguage();
    const shown = results.shownRows(handle);
    return {
      path,
      format,
      columns: chosenColumns(handle, projection),
      projection,
      encoder: table === undefined ? { dialect: language } : { dialect: language, table },
      origin: "memory",
      estimate: shown.length,
      retryable: false,
      drains: null,
      open: () => Promise.resolve({ rows: heldRows(shown), close: () => Promise.resolve() }),
    };
  }

  function resultJob(
    source: { handle: string; columns: readonly number[]; shownOnly?: boolean },
    format: ExportFormat,
    path: string,
  ): ExportJob {
    const handle = ownedHandle(source.handle);
    if (source.shownOnly === true) return shownJob(handle, source.columns, format, path);
    const language = sqlLanguage();
    const columns = chosenColumns(handle, source.columns);
    const owner = sessions.get(handles.get(handle) ?? "");
    const sql = statements.get(handle);
    const state = results.state(handle);
    const table = tables.get(handle)?.table;
    const base = {
      path,
      format,
      columns,
      projection: source.columns,
      encoder: table === undefined ? { dialect: language } : { dialect: language, table },
    };
    const rerun =
      sql !== undefined &&
      owner !== undefined &&
      language.classify(sql).kind === "read" &&
      owner.session.transactions?.open !== true &&
      owner.session.privateDatabase !== true;
    if (rerun) {
      return {
        ...base,
        origin: "rerun",
        estimate: state.cursorOpen ? null : state.rowCount,
        retryable: true,
        drains: null,
        open: () => exportRowsOf(sql),
      };
    }
    const held = results.rows(handle);
    if (!state.cursorOpen) {
      return {
        ...base,
        origin: "memory",
        estimate: held.length,
        retryable: false,
        drains: null,
        open: () => Promise.resolve({ rows: heldRows(held), close: () => Promise.resolve() }),
      };
    }
    const sessionId = handles.get(handle);
    if (sessionId !== undefined && cursors.get(sessionId) === handle) cursors.delete(sessionId);
    return {
      ...base,
      origin: "cursor",
      estimate: null,
      retryable: false,
      drains: handle,
      open: () => drainCursor(sessionId, handle, held),
    };
  }

  /** The console's cursor, handed to the export until it closes its rows. */
  function drainCursor(sessionId: string | undefined, handle: string, held: readonly Row[]): Promise<ExportRows> {
    const owner = sessions.get(sessionId ?? "");
    if (owner !== undefined) owner.exporting += 1;
    return new Promise<ExportRows>((resolve, reject) => {
      let finish = (): void => undefined;
      const finished = new Promise<void>((settle) => {
        finish = settle;
      });
      const draining = results.drain(handle, (rest) => {
        resolve({
          rows: heldThenRest(held, rest),
          close: () => {
            finish();
            return draining.then(
              () => undefined,
              () => undefined,
            );
          },
        });
        return finished;
      });
      void draining.catch(reject).finally(() => {
        if (owner !== undefined) owner.exporting -= 1;
      });
    });
  }

  function sessionFor(sessionId: string): OpenSession {
    const session = sessions.get(sessionId);
    if (session === undefined) {
      throw new EngineFailure({
        code: "unknownSession",
        message: `No open session "${sessionId}".`,
        hint: "Open a new session and run the statement again.",
      });
    }
    return session;
  }

  /** Tags each row this engine holds: a console's with its session id, the catalog's with none. */
  async function listedSessions(): Promise<SessionsListing> {
    const { listing, catalog } = await listServerSessions();
    return {
      notes: listing.notes,
      sessions: listing.sessions.map((row) => {
        let ownSessionId: string | null = null;
        for (const [sessionId, open] of sessions) if (isListedAs(open.session, row)) ownSessionId = sessionId;
        return { ...row, ownSessionId, own: ownSessionId !== null || isListedAs(catalog, row) };
      }),
    };
  }

  /**
   * What the session reports as its namespace now (decision 048), or undefined when the plugin
   * cannot say or the read fails: the console then keeps what it had.
   */
  async function namespaceOf(
    open: Pick<OpenSession, "session" | "capabilities">,
  ): Promise<CurrentNamespace | undefined> {
    if (!open.capabilities.includes("currentNamespace") || open.session.currentNamespace === undefined) {
      return undefined;
    }
    return open.session.currentNamespace().catch(() => undefined);
  }

  /** Notes whether `open` is off its opening namespace; a switch it could not read counts as one. */
  function noteNamespace(open: OpenSession, namespace: CurrentNamespace | undefined, switched: boolean): void {
    if (namespace !== undefined && open.opening !== undefined) open.moved = !samePath(namespace, open.opening);
    else if (switched) open.moved = true;
  }

  function ownedHandle(handle: string): string {
    if (!handles.has(handle)) {
      throw new CoreError(
        "unknownHandle",
        `No result with handle "${handle}" on this connection.`,
        "Run the statement again.",
      );
    }
    return handle;
  }

  const keepAliveMs = options.datasource.keepAliveSeconds * MS_PER_SECOND;

  function pings(open: OpenSession): boolean {
    return keepAliveMs > 0 && open.capabilities.includes("keepAlive") && open.session.ping !== undefined;
  }

  /** Whether the session must prove itself before a statement: given up, or idle a keepalive interval. */
  function needsCheck(open: OpenSession): boolean {
    return open.lost !== null || (pings(open) && now() - open.lastUsed >= keepAliveMs);
  }

  /**
   * Gives the session up: its socket is torn down (the plugins' close is bounded) and the next
   * statement reconnects. A transaction open on it is gone, which the caller must say rather
   * than heal silently.
   */
  function abandon(sessionId: string, open: OpenSession, reason: string): { transaction: boolean } {
    const transaction = open.session.transactions?.open === true;
    open.lost = reason;
    sessionLog?.warn("session lost", { reason, transaction });
    void closeCursorOf(sessionId);
    // The next statement runs on a new session, which has nothing of the old one's to wait for.
    open.closing = null;
    void open.session.close().catch(() => undefined);
    return { transaction };
  }

  /** Runs the switch on a fresh session; false when there is none or it failed, so the switch is lost. */
  async function replaySwitch(session: Session, sql: string | null): Promise<boolean> {
    if (sql === null) return false;
    try {
      await drained(await session.execute(sql));
      return true;
    } catch (cause) {
      sessionLog?.warn("namespace not restored", { message: messageOf(cause) });
      return false;
    }
  }

  /**
   * A fresh session in place of the lost one, in the same transaction mode and back in the
   * namespace the last switch chose.
   */
  async function reconnect(sessionId: string, open: OpenSession): Promise<Reconnection> {
    const mode = open.session.transactions?.mode;
    const session = await connectDatasource(options, connector, open.readOnly);
    const opening = await namespaceOf({ session, capabilities: open.capabilities });
    // Before manual mode, so the replayed switch does not open a transaction.
    const restored = open.moved && (await replaySwitch(session, open.switchedBy));
    const namespace = restored ? await namespaceOf({ session, capabilities: open.capabilities }) : opening;
    try {
      if (mode === "manual") await session.transactions?.setMode("manual");
    } catch (cause) {
      await session.close().catch(() => undefined);
      throw new EngineFailure({ code: "connectionFailed", message: messageOf(cause), hint: RECONNECT_HINT }, cause);
    }
    if (sessions.get(sessionId) !== open) {
      await session.close().catch(() => undefined);
      sessionFor(sessionId);
    }
    const namespaceLost = open.moved && !restored;
    open.session = session;
    open.opening = opening;
    open.moved = restored;
    if (!restored) open.switchedBy = null;
    open.lost = null;
    open.closing = null;
    open.lastUsed = now();
    sessionLog?.info("session reconnected", { namespaceLost });
    return { namespace: namespace ?? null, namespaceLost };
  }

  /** Pings an idle session and reconnects a lost one; undefined when the session was fine. */
  async function ensureLive(sessionId: string, open: OpenSession): Promise<Reconnection | undefined> {
    if (open.lost === null) {
      const reason = await pingFailure(open.session);
      if (reason === null) {
        open.lastUsed = now();
        return undefined;
      }
      if (abandon(sessionId, open, reason).transaction) throw transactionLost();
    }
    return reconnect(sessionId, open);
  }

  function probeServer(): Promise<void> {
    return connectDatasource(options, connector, true).then((session) => {
      void session.close().catch(() => undefined);
    });
  }

  /** `work` on `open`'s session under the statement timeout and, while it runs, the liveness probe. */
  async function watched<T>(
    sessionId: string,
    open: OpenSession,
    work: Promise<T>,
    timeoutSeconds: number,
    discard: (late: T) => void,
  ): Promise<T> {
    const { session } = open;
    const cancel =
      open.capabilities.includes("cancel") && session.cancel !== undefined
        ? () => session.cancel?.() ?? Promise.resolve()
        : undefined;
    const probing = keepAliveMs > 0 && open.capabilities.includes("keepAlive");
    try {
      return await watchStatement(work, {
        timeoutSeconds,
        ...(cancel === undefined ? {} : { cancel }),
        graceMs: CANCEL_GRACE_MS,
        probeEveryMs: probing ? keepAliveMs : 0,
        ...(probing ? { probe: probeServer } : {}),
        probeWindowMs: PROBE_WINDOW_MS,
      });
    } catch (cause) {
      if (cause instanceof StatementTimedOut) {
        sessionLog?.info("statement timed out", { seconds: timeoutSeconds });
        throw timedOut(timeoutSeconds);
      }
      if (cause instanceof SessionLost) {
        work.then(discard, () => undefined);
        const lost = open.session === session && open.lost === null;
        const transaction = lost && abandon(sessionId, open, LOST_REASONS[cause.reason]).transaction;
        throw transaction ? transactionLost() : lostInFlight(cause, timeoutSeconds);
      }
      throw cause;
    }
  }

  /**
   * Runs `run` on a session known to be alive: an idle one is pinged first, a lost one replaced,
   * and a statement the plugin refused because the connection was already gone runs once more
   * on a fresh session, since it never reached the server.
   */
  async function onLiveSession<T>(
    sessionId: string,
    open: OpenSession,
    timeoutSeconds: number,
    run: (session: Session) => Promise<T>,
    failed: (cause: unknown) => EngineFailure,
    discard: (late: T) => void = () => undefined,
  ): Promise<{ value: T; reconnected: Reconnection | undefined }> {
    // Awaited only when there is something to wait for: a needless await would let a cancel
    // overtake the execute.
    let reconnected = mustSettle(sessionId, open) ? await afterClose(sessionId, open) : undefined;
    if (reconnected === undefined && needsCheck(open)) reconnected = await ensureLive(sessionId, open);
    let busy: boolean;
    try {
      return { value: await watched(sessionId, open, run(open.session), timeoutSeconds, discard), reconnected };
    } catch (cause) {
      busy = isPluginError(cause) && cause.code === "sessionBusy";
      const lost = isPluginError(cause) && cause.code === "connectionLost";
      if (busy && reconnected !== undefined && busyRefused(sessionId, open).transaction) throw transactionLost();
      // Cut short mid-statement, so not retried; the next statement reconnects through a new tunnel.
      if (cause instanceof TunnelError && cause.code === "sshTunnelLost" && open.lost === null) {
        abandon(sessionId, open, cause.message);
      }
      if (reconnected !== undefined || !(busy || lost)) throw failed(cause);
    }
    const { transaction } = busy ? busyRefused(sessionId, open) : abandon(sessionId, open, "driver reported");
    if (transaction) throw transactionLost();
    reconnected = await reconnect(sessionId, open);
    if (busy) reconnected = { ...reconnected, reason: "sessionBusy" };
    try {
      return { value: await watched(sessionId, open, run(open.session), timeoutSeconds, discard), reconnected };
    } catch (cause) {
      if (isPluginError(cause) && cause.code === "sessionBusy" && busyRefused(sessionId, open).transaction) {
        throw transactionLost();
      }
      throw failed(cause);
    }
  }

  async function close(): Promise<void> {
    await keyResources.scope.close();
    unsubscribe();
    unsubscribeImports();
    unsubscribeScripts();
    const held = [...handles.keys()];
    handles.clear();
    statements.clear();
    tables.clear();
    staged.clear();
    cursors.clear();
    keySources.clear();
    await settledWithin(Promise.allSettled(held.map((handle) => results.release(handle))), RELEASE_GRACE_MS);
    const open = [...sessions.values()];
    sessions.clear();
    await Promise.allSettled(open.map((entry) => entry.session.close()));
  }

  return {
    ...context,
    keyOperations: keyResources,
    sessions,
    handles,
    cursors,
    tables,
    statements,
    ran,
    edited,
    staged,
    keySources,
    unsubscribe,
    unsubscribeImports,
    unsubscribeScripts,
    forget,
    releaseHandlesOf,
    noteClosing,
    closeCursorOf,
    afterClose,
    mustSettle,
    busyRefused,
    track,
    chosenColumns,
    shownJob,
    resultJob,
    drainCursor,
    sessionFor,
    listedSessions,
    namespaceOf,
    noteNamespace,
    ownedHandle,
    keepAliveMs,
    pings,
    needsCheck,
    abandon,
    replaySwitch,
    reconnect,
    ensureLive,
    probeServer,
    watched,
    onLiveSession,
    close,
  };
}

export type LiveContext = ReturnType<typeof liveContext>;

/** One renderer port's sessions, handles and statement runners over the engine's shared context. */
export function createConnectionContext(context: EngineContext, emit: (event: EngineEvent) => void) {
  const live = liveContext(context, emit);
  const runners = statementRunners(live);
  return { ...live, ...runners, ...bytesRunners(live, runners.tableFor) };
}

export type ConnectionContext = ReturnType<typeof createConnectionContext>;
