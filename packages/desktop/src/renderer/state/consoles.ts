import { create } from "zustand";
import {
  type ClassifiedStatement,
  type Column,
  type CurrentNamespace,
  type EngineError,
  type ErrorAnswer,
  NODE_AUTO,
  type ExecutedStatement,
  type ExportFormat,
  type ExtractorKind,
  type KeySource,
  type OnErrorChoice,
  type Reconnection,
  type ResultPaging,
  type RowRange,
  type SelectionAggregates,
  type ServerMessage,
  type SortKey,
  type StatementLimit,
  type TransactionMode,
  type TransactionState,
} from "@table-craft/desktop/engine/protocol.js";
import type { HistoryEntry, LineEnding } from "@table-craft/desktop/preload/bridge.js";
import type { EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import { carriedLayout, type ColumnLayout } from "@table-craft/desktop/renderer/model/columnLayout.js";
import {
  errorMarkOf,
  markOfError,
  marksOutside,
  nextMark,
  withMark,
  type ErrorMark,
} from "@table-craft/desktop/renderer/model/errorLocation.js";
import {
  cancelledText,
  executedText,
  explainedText,
  exportedText,
  firstLine,
  reconnectedText,
} from "@table-craft/desktop/renderer/model/format.js";
import { clampSelection, type GridSelection } from "@table-craft/desktop/renderer/model/gridSelection.js";
import {
  parameterPrompt,
  parseParametersAnswer,
  valuesFor,
  type ParameterPrompt,
  type ParameterValues,
} from "@table-craft/desktop/renderer/model/parameters.js";
import { caretAfterReformat } from "@table-craft/desktop/renderer/model/reformat.js";
import type { ValueFormat } from "@table-craft/desktop/renderer/model/valueFormats.js";
import {
  serverMessageText,
  serverMessageTone,
  warningCount,
} from "@table-craft/desktop/renderer/model/serverMessages.js";
import {
  selectionToRun,
  statementsToRun,
  type RunScope,
  type TextSpan,
} from "@table-craft/desktop/renderer/model/statementAt.js";
import { EMPTY_BUFFER, pendingCount, pendingText, toEdits } from "@table-craft/desktop/renderer/model/editBuffer.js";
import {
  submitLabel,
  submitCommandsLabel,
  submittedCommandsText,
  submittedScript,
  submittedText,
} from "@table-craft/desktop/renderer/model/resultEdits.js";
import { useCatalog } from "@table-craft/desktop/renderer/state/catalog.js";
import {
  createConsoleEdits,
  keyProblemError,
  pendingEditsOf,
  pendingResults,
  resultKeyChanges,
  type ConsoleEdits,
  type ConsoleResultEdits,
} from "@table-craft/desktop/renderer/state/consoleEdits.js";
import { datasourceById, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { NO_EXPORTS, useExports, type ExportStarter } from "@table-craft/desktop/renderer/state/exports.js";
import {
  NO_EXECUTION_REPORTER,
  useExecutions,
  type ExecutionEnd,
  type ExecutionReporter,
} from "@table-craft/desktop/renderer/state/executions.js";
import { history } from "@table-craft/desktop/renderer/state/history.js";
import { useModal, type ModalRequest } from "@table-craft/desktop/renderer/state/modal.js";
import {
  planTabOf,
  resultTabOf,
  searchedColumnsChanged,
  shownRowCount,
  type AnalysedEffect,
  type ConsoleTab,
  type PlanTab,
  type ResultSearch,
  type ResultTab,
} from "@table-craft/desktop/renderer/state/resultTab.js";
import { createResultWindows, toError, type ResultWindows } from "@table-craft/desktop/renderer/state/resultWindows.js";
import {
  currentFormatOptions,
  currentFormats,
  currentPaging,
  detectsParameters,
  runAllOnError,
  serverEnforcedOf,
  statementLimit,
  statementTimeoutOf,
} from "@table-craft/desktop/renderer/state/settings.js";

export {
  ANALYSED_PLAN_TITLE,
  MAX_LOADED_WINDOWS,
  PLAN_TITLE,
  planTabOf,
  resultTabOf,
  rowAt,
  windowOffsetOf,
  withWindow,
  type AnalysedEffect,
  type ConsoleTab,
  type PlanTab,
  type PlanView,
  type ResultFetch,
  type ResultSearch,
  type ResultTab,
} from "@table-craft/desktop/renderer/state/resultTab.js";
export { canFetch, toError } from "@table-craft/desktop/renderer/state/resultWindows.js";

/**
 * One console's session. `failed` when it could not open and `disconnected` when its engine went
 * away or it was restored at launch; Run opens a new session from either.
 */
/**
 * `confirming`: a run waits on its destructive or Analyse question, and its time has not started,
 * or on what to do about a failed statement (decision 083).
 */
export type ConsoleStatus = "connecting" | "ready" | "running" | "confirming" | "failed" | "disconnected";

export type OutputTone = "info" | "success" | "warning" | "error";

export interface OutputEntry {
  readonly id: number;
  /** Wall-clock time, for the log's `12:04:31` column. */
  readonly at: number;
  /** The statement's first line, or empty when the entry is about no statement. */
  readonly sql: string;
  readonly message: string;
  readonly hint: string | null;
  readonly tone: OutputTone;
  /** A reply's one-row result, held in the engine, that Show as Result opens (decision 119). */
  readonly result?: OutputResult;
  /** The one key the command read, which Open Key opens (decision 119). */
  readonly key?: KeySource;
}

/** What Show as Result opens as a tab: the statement's held result, as it ran. */
export interface OutputResult {
  readonly executed: Omit<ExecutedStatement, "transactionOpen" | "namespace" | "reconnected">;
  readonly sql: string;
  readonly paging: ResultPaging;
}

/** Whether a result opens a tab as it runs: rows do, and a reply only when it is a value read (decision 119). */
function opensTab(executed: Pick<ExecutedStatement, "columns" | "reply">): boolean {
  return executed.columns.length > 0 && (executed.reply === undefined || executed.reply.read === true);
}

/** The Output line's links for a command's result: Show as Result for a reply without a tab, and Open Key. */
function outputLinks(
  executed: Omit<ExecutedStatement, "transactionOpen" | "namespace" | "reconnected">,
  sql: string,
  paging: ResultPaging,
): Pick<OutputEntry, "result" | "key"> {
  return {
    ...(executed.reply !== undefined && !opensTab(executed) && executed.columns.length > 0
      ? { result: { executed, sql, paging } }
      : {}),
    ...(executed.source === undefined ? {} : { key: executed.source }),
  };
}

export type RunOutcome = "succeeded" | "failed" | "cancelled";

/** A run of several statements waiting to hear what to do about one that failed (decision 083). */
export interface ErrorQuestion {
  /** From 1, as the banner counts. */
  readonly number: number;
  readonly total: number;
  readonly sql: string;
  readonly error: EngineError;
}

export interface LastRun {
  readonly durationMs: number;
  readonly outcome: RunOutcome;
}

/** The statement being run, for the editor to flash; `seq` changes on every statement. */
export interface Flash extends TextSpan {
  readonly seq: number;
}

/** Where a console's text lives (plan 041 decision 1): the profile's consoles folder, or a file the user chose. */
export type ConsoleSource =
  | { readonly kind: "scratch" }
  | {
      readonly kind: "file";
      readonly path: string;
      /** The text last read from or written to `path`; the console is dirty while its text differs. */
      readonly savedSql: string;
      readonly lineEnding: LineEnding;
      /** The file's modification time when last read or written, to notice changes made elsewhere. */
      readonly modifiedAt: number;
    };

export type FileConsoleSource = Extract<ConsoleSource, { kind: "file" }>;

export const SCRATCH: ConsoleSource = { kind: "scratch" };

/** A file console not yet attached to a datasource (plan 041 decision 2); it asks for one on first Run. */
export const DETACHED = "";

/** What changed on disk under a file console with unsaved edits (plan 041 decision 6). */
export type DiskChange = "changed" | "deleted";

export function fileSourceOf(session: Pick<ConsoleSession, "source"> | undefined): FileConsoleSource | null {
  return session?.source.kind === "file" ? session.source : null;
}

/** True for a file console whose text differs from what its file holds; scratch consoles autosave. */
export function isDirty(session: Pick<ConsoleSession, "source" | "sql">): boolean {
  return session.source.kind === "file" && session.source.savedSql !== session.sql;
}

export interface ConsoleSession {
  readonly datasourceId: string;
  /** The console's file name without `.sql` (decision 16). */
  readonly name: string;
  readonly source: ConsoleSource;
  readonly diskChanged: DiskChange | null;
  /** The namespace a restored file console switches to once its session opens (plan 041 decision 5). */
  readonly pendingNamespace: readonly string[] | null;
  readonly sessionId: string | null;
  readonly status: ConsoleStatus;
  readonly error: EngineError | null;
  readonly sql: string;
  /** The editor's main selection; empty is a caret. */
  readonly selection: TextSpan;
  readonly results: readonly ConsoleTab[];
  /** `OUTPUT_TAB` or a result or plan tab's id. */
  readonly activeResult: string;
  /** Newest last, at most `OUTPUT_LIMIT` entries; never written to disk. */
  readonly output: readonly OutputEntry[];
  readonly txMode: TransactionMode;
  readonly transactionOpen: boolean;
  /** The database or schema the session is in, as last read by the engine; null before or when unknown. */
  readonly namespace: CurrentNamespace;
  readonly lastRun: LastRun | null;
  readonly flash: Flash | null;
  /** Where an action asked the editor to put its caret; `seq` repeats a jump to the same place. */
  readonly jump: Flash | null;
  /** Text an action asked the editor to put at its selection; the editor clears it once applied. */
  readonly insertion: Insertion | null;
  /** A reformat for the editor to apply as one undo step; the editor clears it once applied. */
  readonly replacement: Replacement | null;
  /** The values the Parameters dialog last ran with, pre-filled next time; never written to disk. */
  readonly parameterValues: ParameterValues;
  /** Each editable result's pending edits, by result id (plan 026). */
  readonly edits: Readonly<Record<string, ConsoleResultEdits>>;
  /** Where failed statements went wrong, in the text as it now stands (decision 082); never written to disk. */
  readonly errorMarks: readonly ErrorMark[];
  readonly question: ErrorQuestion | null;
  /** Where commands run on a `nodes` datasource (decision 114): `NODE_AUTO`, `NODE_ALL_PRIMARIES` or a node id. */
  readonly node: string;
}

export interface Insertion {
  readonly text: string;
  readonly seq: number;
}

export interface Replacement {
  readonly from: number;
  readonly to: number;
  /** The text `from`–`to` held when the reformat was asked; the editor skips it if that changed. */
  readonly before: string;
  readonly text: string;
  /** The selection once applied, in the new text's offsets. */
  readonly selection: TextSpan;
  readonly seq: number;
}

/** What the Parameters dialog asks (plan 019 decision 6). */
export interface ParametersRequest {
  readonly prompt: ParameterPrompt;
  /** Pre-filled values: the console's last ones. */
  readonly initial: ParameterValues;
}

export const REFORMAT_FAILED = "Could not reformat";

export interface OpenOptions {
  readonly name?: string;
  readonly sql?: string;
  /** False for a console restored at launch: it stays disconnected until its first Run. */
  readonly connect?: boolean;
  /** Values the next Parameters dialog starts from, such as a history entry's (plan 019 decision 9). */
  readonly parameterValues?: ParameterValues;
  readonly source?: ConsoleSource;
  /** The namespace to switch to once the session opens; a remembered attachment's. */
  readonly namespace?: readonly string[] | null;
}

export interface ConsolesState extends ConsoleEdits {
  readonly consoles: Readonly<Record<string, ConsoleSession>>;
  /**
   * Asks once whether to submit or discard the console's pending result edits, among `resultIds`
   * when given, then does it; false when the user cancelled or a submit failed.
   */
  readonly settleEdits: (id: string, verb: string, resultIds?: readonly string[]) => Promise<boolean>;
  /**
   * Runs the plugin's switch statement for `path` on the console's session, opening one first,
   * after settling pending result edits; results stay (decision 060).
   */
  readonly switchNamespace: (id: string, path: readonly string[]) => Promise<void>;
  /** Adds a console on `datasourceId`, opening its session unless `connect` is false. */
  readonly open: (id: string, datasourceId: string, options?: OpenOptions) => Promise<void>;
  /** Forgets the console and closes its session, which releases its results. */
  readonly close: (id: string) => void;
  /** Marks the datasource's consoles disconnected; `error` says why when it was not asked for. */
  readonly detach: (datasourceId: string, error: EngineError | null) => void;
  readonly setSql: (id: string, sql: string) => void;
  /** Attaches a detached file console to `datasourceId`; its session opens on the next Run. */
  readonly attach: (id: string, datasourceId: string) => void;
  /** Detaches a file console from its removed datasource, dropping its results; its text stays. */
  readonly release: (id: string) => void;
  /** The console's text now lives in `source`, as written or renamed; clears any disk change. */
  readonly saved: (id: string, source: ConsoleSource, name?: string) => void;
  /** Replaces the console's text with what its file now holds. */
  readonly reloaded: (id: string, sql: string, source: FileConsoleSource) => void;
  readonly setDiskChanged: (id: string, change: DiskChange | null) => void;
  readonly setSelection: (id: string, selection: TextSpan) => void;
  /** The editor moved or dropped the error marks as the text was edited. */
  readonly marksMoved: (id: string, marks: readonly ErrorMark[]) => void;
  /** Adds marks made elsewhere, as a script's failures in its file, over those of the same statements. */
  readonly markErrors: (id: string, marks: readonly ErrorMark[]) => void;
  /** Puts the caret on the next error mark after it, or the previous one; false when there is none. */
  readonly gotoError: (id: string, backward: boolean) => boolean;
  /** Puts the caret on the mark of the error the console shows; false when it has none. */
  readonly showError: (id: string) => boolean;
  /** Answers the run's question about a failed statement; nothing when it is not asking. */
  readonly answerError: (id: string, answer: ErrorAnswer) => void;
  /** Puts the editor's caret at `span.from` and flashes `span`, as Go to Declaration lands. */
  readonly jumpTo: (id: string, span: TextSpan) => void;
  readonly jumped: (id: string, seq: number) => void;
  /** Asks the editor to replace its selection with `text`, or insert it at the caret, as one undo step. */
  readonly insert: (id: string, text: string, values?: ParameterValues) => void;
  /** The editor applied the insertion numbered `seq`. */
  readonly inserted: (id: string, seq: number) => void;
  /** Reformats the selection, or the whole console when there is none (plan 019 decision 2). */
  readonly reformat: (id: string) => Promise<void>;
  /** The editor applied, or skipped as stale, the replacement numbered `seq`. */
  readonly replaced: (id: string, seq: number) => void;
  /**
   * Runs what `scope` picks, one statement after another, opening a session first when it has none.
   * `preset` answers the Parameters dialog and binds even with detection off (plan 046 decision 6).
   */
  readonly run: (id: string, scope: RunScope, preset?: ParameterValues) => Promise<void>;
  /** Asks the engine to cancel the running statement; `run` then reports it as cancelled. */
  readonly cancel: (id: string) => Promise<void>;
  /** Loads the window at `offset` unless it is loaded or on its way; evicts the furthest past the limit. */
  readonly ensureWindow: (id: string, resultId: string, offset: number) => void;
  /** Fetch Next Page, or Fetch All up to the cap (decision 025). */
  readonly fetchMore: (id: string, resultId: string, all: boolean) => Promise<void>;
  /** Stops a running fetch; the rows it got stay and the cursor stays open. */
  readonly stopFetch: (id: string, resultId: string) => Promise<void>;
  /** Sorts the fetched rows locally; no keys restores the server's order. */
  readonly sort: (id: string, resultId: string, keys: readonly SortKey[]) => Promise<void>;
  readonly setLayout: (id: string, resultId: string, layout: ColumnLayout) => void;
  readonly select: (id: string, resultId: string, selection: GridSelection | null) => void;
  /**
   * Explains the statement at the caret or the selection (plan 012 decision 9): the plugin checks
   * it first, and Analyse of a write asks before it runs.
   */
  readonly explain: (id: string, analyze: boolean) => Promise<void>;
  /**
   * Runs the tab's statement again in place, keeping its layout and sort, reconnecting when it must;
   * a plan tab explains again in the same mode.
   */
  readonly rerun: (id: string, resultId: string) => Promise<void>;
  /** Opens the reply an Output line holds as a result tab, or brings its open tab forward (decision 119). */
  readonly showReply: (id: string, entryId: number) => void;
  /** The value panel's format of a result with no source key (decision 119). */
  readonly setValueFormat: (id: string, resultId: string, format: ValueFormat) => void;
  /** The plan tab's view, selected node or collapsed nodes. */
  readonly updatePlan: (
    id: string,
    planId: string,
    change: Partial<Pick<PlanTab, "view" | "selected" | "collapsed">>,
  ) => void;
  /** The chosen rows and columns as an extractor's text, or null when the engine refused (the Output log says why). */
  readonly extract: (
    id: string,
    resultId: string,
    extractor: ExtractorKind,
    rows: readonly RowRange[],
    columns: readonly number[],
  ) => Promise<string | null>;
  /** What the selected cells add up to, or null when the engine refused. */
  readonly aggregate: (
    id: string,
    resultId: string,
    rows: readonly RowRange[],
    columns: readonly number[],
  ) => Promise<SelectionAggregates | null>;
  /** Every byte of a held cell, for an image preview; null when the engine refused. */
  readonly cellBytes: ResultWindows["cellBytes"];
  /** Writes a held cell's bytes to a file main chose (plan 043). */
  readonly saveBytes: ResultWindows["saveBytes"];
  /** Reads a file main chose into the engine for this result's edits (plan 043). */
  readonly loadBytes: ResultWindows["loadBytes"];
  /** Writes the result to `path`, draining its open cursor, and logs what it wrote. */
  readonly exportTo: (
    id: string,
    resultId: string,
    format: ExportFormat,
    path: string,
    columns: readonly number[],
    shownOnly?: boolean,
  ) => Promise<boolean>;
  /** Changes the result's find bar or local filter chips; the engine recomputes the view (plan 023). */
  readonly search: (id: string, resultId: string, change: (search: ResultSearch) => ResultSearch) => Promise<void>;
  /** Moves the find bar to the next match, or the previous one. */
  readonly findNext: (id: string, resultId: string, backward: boolean) => Promise<void>;
  readonly showResult: (id: string, resultId: string) => void;
  readonly togglePin: (id: string, resultId: string) => void;
  /** False when the engine refused, which the Output log then explains. */
  readonly setTransactionMode: (id: string, mode: TransactionMode) => Promise<boolean>;
  readonly setNode: (id: string, node: string) => void;
  readonly commit: (id: string) => Promise<boolean>;
  readonly rollback: (id: string) => Promise<boolean>;
}

export const OUTPUT_TAB = "output";
export const OUTPUT_LIMIT = 500;
export const DEFAULT_CONSOLE_NAME = "console";
const RESULT_TITLE = "Result";
/** The console has no Overwrite of its own; the key tab has (decision 115). */
const CONSOLE_CONFLICT_HINT = "Refresh the result to see the other change and edit again, or Open Key to overwrite it.";
/** Whether Run can start from this status; it reconnects from the last two. */
export function canRun(status: ConsoleStatus): boolean {
  return status === "ready" || status === "disconnected" || status === "failed";
}

/** `Result N` for the smallest N no kept tab holds. */
export function nextResultTitle(kept: readonly Pick<ResultTab, "title">[]): string {
  const taken = new Set(kept.map((tab) => tab.title));
  for (let n = 1; ; n++) if (!taken.has(`${RESULT_TITLE} ${n}`)) return `${RESULT_TITLE} ${n}`;
}

/** The shown tab when it holds rows: what the grid and its actions work on. */
export function activeResultOf(session: ConsoleSession): ResultTab | null {
  const active = activeTabOf(session);
  return active?.kind === "rows" ? active : null;
}

/** The shown result or plan tab; null while Output is shown. */
export function activeTabOf(session: ConsoleSession): ConsoleTab | null {
  return session.results.find((result) => result.id === session.activeResult) ?? null;
}

export function activePlanOf(session: ConsoleSession): PlanTab | null {
  const active = activeTabOf(session);
  return active?.kind === "plan" ? active : null;
}

const isRows = (tab: ConsoleTab): tab is ResultTab => tab.kind === "rows";

/** What the user is asked before Explain Analyse runs a write (plan 012 decision 9). */
export interface AnalyseRequest {
  readonly statement: ClassifiedStatement;
  readonly mode: TransactionMode;
}

export const ANALYSE_TITLE = "Explain Analyse runs this statement";
export const ANALYSE_CONFIRM = "Run and Explain";
const ANALYSE_COMMITS = "Its changes will be committed.";
const ANALYSE_STAYS_OPEN = "Its changes stay in the open transaction until you commit or roll back.";
export const EXPLAIN_ONE_STATEMENT = "Explain one statement at a time.";
const NOTHING_TO_EXPLAIN = "Nothing to explain";
const DECLINED = "Cancelled; nothing ran.";
/** The verb the pending-edits question names before a namespace switch. */
const SWITCH_VERB = "switch namespace";
const SWITCH_IN_TRANSACTION = "Switched inside the open transaction; a rollback switches back.";

export function analyseConfirmation({ statement, mode }: AnalyseRequest): ModalRequest {
  return {
    kind: "confirm",
    title: ANALYSE_TITLE,
    message: mode === "auto" ? ANALYSE_COMMITS : ANALYSE_STAYS_OPEN,
    items: [{ label: firstLine(statement.sql), detail: statement.destructive ?? "" }],
    confirm: ANALYSE_CONFIRM,
    destructive: true,
  };
}

/** The label Services lists an explain under (plan 012 decision 13). */
export function explainLabel(sql: string, analyze: boolean): string {
  return `${analyze ? "Explain Analyse" : "Explain"}: ${firstLine(sql)}`;
}

export interface ConsolesDependencies {
  /** The datasource's engine, connected on first use; one port per datasource per window. */
  readonly connect: (datasourceId: string) => Promise<EngineClient>;
  readonly now: () => number;
  /** Wall-clock time for Output entries; defaults to `Date.now`. */
  readonly clock?: () => number;
  /** Asks before destructive statements run (decision 9); false runs none of the batch. */
  readonly confirmDestructive?: (statements: readonly ClassifiedStatement[], datasourceId: string) => Promise<boolean>;
  /** Asks before Explain Analyse runs a write (plan 012 decision 9); false runs nothing. */
  readonly confirmAnalyse?: (request: AnalyseRequest) => Promise<boolean>;
  /** Asks for a run's parameter values (plan 019 decision 6); null runs nothing. */
  readonly askParameters?: (request: ParametersRequest) => Promise<ParameterValues | null>;
  /** DDL took effect outside a transaction: the datasource's cached catalog is stale (decision 19). */
  readonly onDdl?: (datasourceId: string) => void;
  /** Hears each statement start and end, for Services (plan 011, decision 11). */
  readonly executions?: ExecutionReporter;
  /** Each statement once it ends, for query history (decision 030); must not throw. */
  readonly record?: (entry: HistoryEntry) => void;
  /** Starts background exports of a result (decision 040). */
  readonly exports?: ExportStarter;
  /** The statement timeout for the datasource's consoles in seconds, 0 for none (decision 054). */
  readonly statementTimeout?: (datasourceId: string) => number;
  /** Whether the datasource has the database enforce that timeout too (decision 129). */
  readonly serverEnforced?: (datasourceId: string) => boolean;
  /** Asks whether to submit or discard pending result edits before `verb`; null cancels (plan 026). */
  readonly askPendingEdits?: (request: PendingEditsRequest) => Promise<PendingEditsAnswer | null>;
  /** Asks which datasource a detached file console runs on (plan 041 decision 2); null runs nothing. */
  readonly chooseDatasource?: () => Promise<string | null>;
  /** What a run of several statements does when one fails (decision 083); defaults to stopping. */
  readonly onError?: () => OnErrorChoice;
}

export interface PendingEditsRequest {
  readonly changes: number;
  readonly verb: string;
}

export type PendingEditsAnswer = "submit" | "discard";

function newConsole(datasourceId: string, name: string, sql: string, connect: boolean): ConsoleSession {
  return {
    datasourceId,
    name,
    source: SCRATCH,
    diskChanged: null,
    pendingNamespace: null,
    sessionId: null,
    status: connect ? "connecting" : "disconnected",
    error: null,
    sql,
    selection: { from: 0, to: 0 },
    results: [],
    activeResult: OUTPUT_TAB,
    output: [],
    txMode: "auto",
    node: NODE_AUTO,
    transactionOpen: false,
    namespace: null,
    lastRun: null,
    flash: null,
    jump: null,
    insertion: null,
    replacement: null,
    parameterValues: {},
    edits: {},
    errorMarks: [],
    question: null,
  };
}

/** The console patch for a reply that may carry a fresh namespace read; an absent one keeps the last. */
function namespaceOf(reply: { readonly namespace?: CurrentNamespace }): { namespace?: CurrentNamespace } {
  return reply.namespace === undefined ? {} : { namespace: reply.namespace };
}

/** The namespace patch for a statement's reply: a reconnect's start, then any read after the statement. */
function namespaceAfter(reply: { readonly namespace?: CurrentNamespace; readonly reconnected?: Reconnection }): {
  namespace?: CurrentNamespace;
} {
  return { ...namespaceOf(reply.reconnected ?? {}), ...namespaceOf(reply) };
}

function statementCount(count: number): string {
  return `${count} ${count === 1 ? "statement" : "statements"}`;
}

/** What a run may go on past; a lost connection or a cancel ends it whatever the setting says. */
const CONTINUABLE: ReadonlySet<EngineError["code"]> = new Set(["statementFailed", "statementTimedOut"]);
const FAILED_IN_TRANSACTION =
  "It failed inside a transaction: some databases, PostgreSQL among them, refuse every later statement until it is rolled back.";

function failedText(total: number, failed: number): string {
  return `${total} run, ${failed} failed.`;
}

/** A run's prompt and the values the user gave it. */
interface Bound {
  readonly prompt: ParameterPrompt;
  readonly values: ParameterValues;
}

/** The values the `index`-th statement of a run binds; undefined when it binds none. */
function boundAt(bound: Bound | null, index: number): ParameterValues | undefined {
  const prompted = bound?.prompt.statements[index];
  return prompted === undefined || bound === null ? undefined : valuesFor(prompted, bound.values);
}

/** Finishes one execution in Services and history; `executionId` names its Services row. */
type Ended = ((end: ExecutionEnd) => void) & { readonly executionId: number };

export function createConsolesStore(dependencies: ConsolesDependencies) {
  /** The client each console's session lives on; not state, because nothing renders from it. */
  const clients = new Map<string, EngineClient>();
  /** Consoles whose DDL ran inside a transaction not yet ended: Commit makes it visible. */
  const pendingDdl = new Set<string>();
  const clock = dependencies.clock ?? (() => Date.now());
  const confirmDestructive = dependencies.confirmDestructive ?? (() => Promise.resolve(true));
  const confirmAnalyse = dependencies.confirmAnalyse ?? (() => Promise.resolve(true));
  const askParameters =
    dependencies.askParameters ?? ((request: ParametersRequest) => Promise.resolve(request.initial));
  const executions = dependencies.executions ?? NO_EXECUTION_REPORTER;
  const exports = dependencies.exports ?? NO_EXPORTS;
  const statementTimeout = dependencies.statementTimeout ?? (() => 0);
  const serverEnforced = dependencies.serverEnforced ?? (() => false);
  const askPendingEdits = dependencies.askPendingEdits ?? (() => Promise.resolve<PendingEditsAnswer>("discard"));
  const onError = dependencies.onError ?? ((): OnErrorChoice => "stop");
  /** The answer each console's run waits for, by console id. */
  const answers = new Map<string, (answer: ErrorAnswer) => void>();
  /** The execution each result tab came from, by result id, so fetching more updates its row count. */
  const producedBy = new Map<string, number>();
  /** When each console's current run started; a confirmation restarts it once answered. */
  const runStarts = new Map<string, number>();
  let entries = 0;
  let flashes = 0;
  let resultIds = 0;

  return create<ConsolesState>()((set, get) => {
    const windows = createResultWindows({
      client: (id) => clients.get(id),
      result: (id, resultId) => resultOf(id, resultId),
      update: (id, resultId, change) => updateResult(id, resultId, change),
      failed: (id, result, error, window) => {
        if (window) patch(id, { error });
        else logError(id, firstLine(result.sql), error);
      },
      fetched: (id, resultId, rowCount, arrived) => {
        const executionId = producedBy.get(resultId);
        if (executionId !== undefined) executions.recount(id, executionId, rowCount, arrived);
        if (arrived !== undefined) logMessages(id, arrived);
      },
      datasourceOf: (id) => get().consoles[id]?.datasourceId,
      exports,
    });
    const { invalidate: invalidateWindows, forget } = windows;

    function patch(id: string, change: Partial<ConsoleSession>): void {
      const current = get().consoles[id];
      if (current === undefined) return;
      set({ consoles: { ...get().consoles, [id]: { ...current, ...change } } });
    }

    function log(id: string, entry: Omit<OutputEntry, "id" | "at" | "hint"> & { readonly hint?: string | null }): void {
      const current = get().consoles[id];
      if (current === undefined) return;
      const next: OutputEntry = { hint: null, ...entry, id: ++entries, at: clock() };
      patch(id, { output: [...current.output, next].slice(-OUTPUT_LIMIT) });
    }

    function logError(id: string, sql: string, error: EngineError): void {
      log(id, { sql, message: error.message, hint: error.hint, tone: "error" });
      // The engine dropped the session; the next Run opens a new one with no transaction (decisions 054, 070).
      if (error.code === "connectionLost" || error.code === "sshTunnelLost") patch(id, { transactionOpen: false });
    }

    function messagesOf(said: { readonly messages?: readonly ServerMessage[] }): Pick<ExecutionEnd, "messages"> {
      return said.messages === undefined ? {} : { messages: said.messages };
    }

    /** A line per message the server left about the statement logged just before (decision 066). */
    function logMessages(id: string, messages: readonly ServerMessage[] | undefined): void {
      for (const message of messages ?? []) {
        log(id, { sql: "", message: serverMessageText(message), tone: serverMessageTone(message) });
      }
    }

    /** Says the engine replaced a lost session before the statement ran, ahead of the statement's own line. */
    function logReconnected(id: string, reconnected: Reconnection | undefined): void {
      if (reconnected !== undefined) log(id, { sql: "", message: reconnectedText(reconnected), tone: "info" });
    }

    /** The limit a console statement sends; nothing when the console has no limit. */
    function limitOf(id: string): StatementLimit {
      const datasourceId = get().consoles[id]?.datasourceId;
      if (datasourceId === undefined) return {};
      return statementLimit(statementTimeout(datasourceId), serverEnforced(datasourceId));
    }

    /** The Run on choice, sent only when it is not the plugin's own routing. */
    function nodeOf(id: string): { node?: string } {
      const node = get().consoles[id]?.node ?? NODE_AUTO;
      return node === NODE_AUTO ? {} : { node };
    }

    /** One statement on its way to the engine: Services lists it now, history once it ends. */
    function started(
      id: string,
      sql: string,
      label: string = firstLine(sql),
      parameters: ParameterValues | null = null,
    ): Ended {
      const startedAt = clock();
      const datasourceId = get().consoles[id]?.datasourceId;
      const executionId = executions.start(id, { label, sql, startedAt });
      const ended = (end: ExecutionEnd): void => {
        const durationMs = Math.max(0, Math.round(end.durationMs));
        executions.finish(id, executionId, { ...end, durationMs });
        if (datasourceId === undefined) return;
        const { outcome, rowCount, message } = end;
        const warnings = warningCount(end.messages);
        dependencies.record?.({
          datasourceId,
          sql: end.sql ?? sql,
          startedAt,
          durationMs,
          outcome,
          rowCount,
          message,
          source: "console",
          ...(parameters === null ? {} : { parameters }),
          ...(warnings === 0 ? {} : { warnings }),
        });
      };
      return Object.assign(ended, { executionId });
    }

    function rowsOf(executed: Pick<ExecutedStatement, "columns" | "rowCount" | "rowsAffected">): number | null {
      return executed.columns.length > 0 ? executed.rowCount : executed.rowsAffected;
    }

    function failureEnd(error: EngineError, durationMs: number): ExecutionEnd {
      const cancelled = error.code === "cancelled";
      return {
        durationMs,
        outcome: cancelled ? "cancelled" : "error",
        rowCount: null,
        message: cancelled ? null : error.message,
      };
    }

    /** Runs the plugin's switch statement for `path` on an open session, saying where it landed. */
    async function switchOn(
      id: string,
      client: EngineClient,
      sessionId: string,
      path: readonly string[],
      inTransaction: boolean,
    ): Promise<RunOutcome> {
      const switching = await client.call("namespace.switchStatement", { path });
      const statement: ClassifiedStatement = {
        from: 0,
        to: 0,
        sql: switching.sql,
        kind: "other",
        destructive: null,
        parameters: [],
      };
      const outcome = await execute(id, client, sessionId, [statement], null, false);
      if (outcome !== "succeeded") return outcome;
      if (switching.transactional && inTransaction) {
        log(id, { sql: "", message: SWITCH_IN_TRANSACTION, tone: "info" });
      }
      const landed = get().consoles[id]?.namespace ?? null;
      if (landed !== null && landed.join(".") !== path.join(".")) {
        log(id, {
          sql: "",
          message: `The session is in ${landed.join(".")}, not ${path.join(".")}.`,
          tone: "warning",
        });
      }
      return outcome;
    }

    /** Opens a session for the console; false when it could not, with the console marked failed. */
    async function openSession(id: string): Promise<boolean> {
      if (get().consoles[id]?.datasourceId === DETACHED) {
        const chosen = (await dependencies.chooseDatasource?.()) ?? null;
        if (chosen === null) return false;
        get().attach(id, chosen);
      }
      const current = get().consoles[id];
      if (current === undefined || current.datasourceId === DETACHED) return false;
      patch(id, { status: "connecting", error: null });
      try {
        const client = await dependencies.connect(current.datasourceId);
        const opened = await client.call("session.open", {});
        if (get().consoles[id] === undefined) {
          // Its tab closed while the session opened.
          void client.call("session.close", { sessionId: opened.sessionId }).catch(() => undefined);
          return false;
        }
        clients.set(id, client);
        patch(id, {
          sessionId: opened.sessionId,
          status: "ready",
          error: null,
          transactionOpen: false,
          namespace: opened.namespace,
        });
        const mode = get().consoles[id]?.txMode;
        if (mode === "manual") await applyMode(id, client, opened.sessionId, mode);
        const wanted = get().consoles[id]?.pendingNamespace ?? null;
        if (wanted !== null) {
          patch(id, { pendingNamespace: null });
          if (opened.namespace?.join(".") !== wanted.join(".")) {
            // The remembered namespace may be gone; the console stays usable where the session opened.
            await switchOn(id, client, opened.sessionId, wanted, false).catch((cause: unknown) => {
              logError(id, "", toError(cause));
            });
          }
        }
        return true;
      } catch (cause) {
        patch(id, { status: "failed", error: toError(cause) });
        return false;
      }
    }

    async function applyMode(id: string, client: EngineClient, sessionId: string, mode: TransactionMode) {
      try {
        cursorsClosed(id);
        const state = await client.call("transaction.setMode", { sessionId, mode });
        patch(id, { txMode: state.mode, transactionOpen: state.transactionOpen, ...namespaceOf(state) });
        return true;
      } catch (cause) {
        logError(id, "", toError(cause));
        return false;
      }
    }

    function release(id: string, results: readonly ConsoleTab[]): void {
      const current = get().consoles[id];
      if (current !== undefined && results.some((result) => result.id in current.edits)) {
        const released = new Set(results.map((result) => result.id));
        patch(id, { edits: Object.fromEntries(Object.entries(current.edits).filter(([key]) => !released.has(key))) });
      }
      const client = clients.get(id);
      for (const result of results) {
        forget(result.id);
        producedBy.delete(result.id);
        if (result.kind === "rows" && client !== undefined && !result.stale) {
          void client.call("result.release", { handle: result.handle }).catch(() => undefined);
        }
      }
      forgetReplies(id, new Set(results.flatMap((result) => (result.kind === "rows" ? [result.handle] : []))));
    }

    /** Drops Show as Result from Output lines whose result was released with its tab. */
    function forgetReplies(id: string, handles: ReadonlySet<string>): void {
      const output = get().consoles[id]?.output;
      const released = (entry: OutputEntry) => entry.result !== undefined && handles.has(entry.result.executed.handle);
      if (output === undefined || !output.some(released)) return;
      patch(id, {
        output: output.map((entry) => {
          if (!released(entry)) return entry;
          const { result: _released, ...rest } = entry;
          return rest;
        }),
      });
    }

    function tabOf(id: string, resultId: string): ConsoleTab | undefined {
      return get().consoles[id]?.results.find((result) => result.id === resultId);
    }

    function resultOf(id: string, resultId: string): ResultTab | undefined {
      const tab = tabOf(id, resultId);
      return tab?.kind === "rows" ? tab : undefined;
    }

    function planOf(id: string, planId: string): PlanTab | undefined {
      const tab = tabOf(id, planId);
      return tab?.kind === "plan" ? tab : undefined;
    }

    function updateResult(id: string, resultId: string, change: (result: ResultTab) => ResultTab): void {
      const current = get().consoles[id];
      if (current === undefined) return;
      patch(id, {
        results: current.results.map((result) => (result.id === resultId && isRows(result) ? change(result) : result)),
      });
    }

    function updatePlan(id: string, planId: string, change: (plan: PlanTab) => PlanTab): void {
      const current = get().consoles[id];
      if (current === undefined) return;
      patch(id, {
        results: current.results.map((tab) => (tab.id === planId && tab.kind === "plan" ? change(tab) : tab)),
      });
    }

    /** The engine closes a session's open cursor when the session runs anything or its transaction ends. */
    function cursorsClosed(id: string): void {
      const current = get().consoles[id];
      if (current === undefined || !current.results.some((result) => isRows(result) && result.cursorOpen)) return;
      patch(id, {
        results: current.results.map((result) => (isRows(result) ? { ...result, cursorOpen: false } : result)),
      });
    }

    /** Drops the unpinned result tabs before a run fills new ones (decision 10). */
    function replaceUnpinned(id: string): void {
      const current = get().consoles[id];
      if (current === undefined) return;
      const kept = current.results.filter((result) => result.pinned);
      release(
        id,
        current.results.filter((result) => !result.pinned),
      );
      const activeKept = kept.some((result) => result.id === current.activeResult);
      patch(id, { results: kept, activeResult: activeKept ? current.activeResult : OUTPUT_TAB });
    }

    async function resolveTarget(
      client: EngineClient,
      session: ConsoleSession,
      scope: RunScope,
    ): Promise<readonly ClassifiedStatement[]> {
      const selected = selectionToRun(session.selection, scope);
      if (selected !== null) {
        const pieces = await client.call("script.split", { text: session.sql.slice(selected.from, selected.to) });
        return pieces.map((piece) => ({ ...piece, from: piece.from + selected.from, to: piece.to + selected.from }));
      }
      const statements = await client.call("script.split", { text: session.sql });
      const target = statementsToRun(statements, session.selection, scope);
      return target.kind === "statements" ? target.statements : [];
    }

    function afterTransactionChange(id: string, datasourceId: string, open: boolean, committed: boolean): void {
      if (open || !pendingDdl.has(id)) return;
      pendingDdl.delete(id);
      if (committed) dependencies.onDdl?.(datasourceId);
    }

    /** Ends any question the console's run waits on, as Stop does. */
    function stopAsking(id: string): void {
      const resolve = answers.get(id);
      answers.delete(id);
      resolve?.("stop");
    }

    async function askAboutError(id: string, question: ErrorQuestion): Promise<ErrorAnswer> {
      try {
        return await asked(
          id,
          () =>
            new Promise<ErrorAnswer>((resolve) => {
              answers.set(id, resolve);
              patch(id, { question });
            }),
        );
      } finally {
        answers.delete(id);
        patch(id, { question: null });
      }
    }

    /** Marks where `statement` failed, unless the text moved under the run. */
    function markFailure(id: string, statement: ClassifiedStatement, error: EngineError): void {
      const current = get().consoles[id];
      const mark = errorMarkOf(statement, error);
      if (current === undefined || mark === null) return;
      if (current.sql.slice(statement.from, statement.to) !== statement.sql) return;
      patch(id, { errorMarks: withMark(current.errorMarks, mark) });
    }

    function clearMarks(id: string, ran: readonly ClassifiedStatement[]): void {
      const current = get().consoles[id];
      if (current === undefined) return;
      const errorMarks = marksOutside(current.errorMarks, ran);
      if (errorMarks !== current.errorMarks) patch(id, { errorMarks });
    }

    /**
     * What the run does about a failed statement (decision 083): the setting, or the user's answer,
     * for a failure the run can go on past with statements left; anything else stops it.
     */
    async function decide(
      id: string,
      policy: OnErrorChoice,
      error: EngineError,
      statements: readonly ClassifiedStatement[],
      index: number,
      failedBefore: number,
    ): Promise<ErrorAnswer> {
      const last = index === statements.length - 1;
      if (!CONTINUABLE.has(error.code)) return "stop";
      if (last) return failedBefore > 0 ? "skip" : "stop";
      if (policy !== "ask") return policy === "continue" ? "skip" : "stop";
      const statement = statements[index];
      return askAboutError(id, {
        number: index + 1,
        total: statements.length,
        sql: firstLine(statement?.sql ?? ""),
        error,
      });
    }

    /**
     * Runs `statements` in order. A failure stops the rest, or, in a run of several, the console's
     * setting or the user's answer skips it or runs it again (decision 083).
     */
    async function execute(
      id: string,
      client: EngineClient,
      sessionId: string,
      statements: readonly ClassifiedStatement[],
      bound: Bound | null,
      fromEditor = true,
    ): Promise<RunOutcome> {
      let policy: OnErrorChoice = statements.length > 1 ? onError() : "stop";
      let failed = 0;
      let warnedTransaction = false;
      if (fromEditor) clearMarks(id, statements);
      for (let index = 0; index < statements.length;) {
        const statement = statements[index];
        if (statement === undefined) break;
        const sql = firstLine(statement.sql);
        const parameters = boundAt(bound, index);
        if (fromEditor) patch(id, { flash: { from: statement.from, to: statement.to, seq: ++flashes } });
        const ended = started(id, statement.sql, sql, parameters ?? null);
        const startedAt = dependencies.now();
        try {
          cursorsClosed(id);
          const paging = currentPaging();
          const { transactionOpen, namespace, reconnected, ...executed } = await client.call("statement.execute", {
            sessionId,
            sql: statement.sql,
            ...(parameters === undefined ? {} : { parameters }),
            ...paging,
            ...limitOf(id),
            ...nodeOf(id),
            ...(statement.repeat === undefined ? {} : { repeat: statement.repeat }),
          });
          const moved = namespaceAfter({ namespace, ...(reconnected === undefined ? {} : { reconnected }) });
          logReconnected(id, reconnected);
          const elapsed = dependencies.now() - startedAt;
          ended({
            durationMs: elapsed,
            outcome: "success",
            rowCount: rowsOf(executed),
            message: null,
            ...messagesOf(executed),
          });
          log(id, {
            sql,
            message: executedText(executed, elapsed, statement.kind),
            tone: "success",
            ...outputLinks(executed, statement.sql, paging),
          });
          logMessages(id, executed.messages);
          const current = get().consoles[id];
          if (current === undefined) return "cancelled";
          const datasourceId = current.datasourceId;
          if (opensTab(executed)) {
            const tab = resultTabOf(
              executed,
              { id: `${id}/result-${++resultIds}`, title: nextResultTitle(current.results) },
              statement.sql,
              paging,
              currentFormats(),
            );
            producedBy.set(tab.id, ended.executionId);
            patch(id, { results: [...current.results, tab], activeResult: tab.id, transactionOpen, ...moved });
          } else {
            patch(id, { transactionOpen, ...moved });
          }
          if (statement.kind === "ddl") {
            if (transactionOpen) pendingDdl.add(id);
            else dependencies.onDdl?.(datasourceId);
          }
          if (statement.kind === "transaction") {
            // Whether a typed end committed is the plugin's to know (decision 008); re-reading after a
            // rollback costs a describe and shows the same tree.
            afterTransactionChange(id, datasourceId, transactionOpen, true);
          }
          index++;
        } catch (cause) {
          const error = toError(cause);
          ended(failureEnd(error, dependencies.now() - startedAt));
          const cancelled = error.code === "cancelled";
          if (cancelled) log(id, { sql, message: cancelledText(error), tone: "warning" });
          else logError(id, sql, error);
          if (fromEditor) markFailure(id, statement, error);
          patch(id, { error });
          const answer = await decide(id, policy, error, statements, index, failed);
          if (get().consoles[id] === undefined) return "cancelled";
          if (answer === "retry") {
            if (fromEditor) clearMarks(id, [statement]);
            continue;
          }
          if (answer === "stop") {
            const skipped = statements.length - index - 1;
            if (skipped > 0) {
              log(id, {
                sql: "",
                message: `${statementCount(skipped)} skipped after the ${cancelled ? "cancel" : "error"}.`,
                tone: "warning",
              });
            }
            if (failed > 0) log(id, { sql: "", message: failedText(index + 1, failed + 1), tone: "warning" });
            patch(id, { activeResult: OUTPUT_TAB });
            return cancelled ? "cancelled" : "failed";
          }
          if (answer === "skipAll") policy = "continue";
          failed++;
          const current = get().consoles[id];
          if (!warnedTransaction && (current?.transactionOpen === true || current?.txMode === "manual")) {
            warnedTransaction = true;
            log(id, { sql: "", message: FAILED_IN_TRANSACTION, tone: "warning" });
          }
          index++;
        }
      }
      if (failed === 0) return "succeeded";
      log(id, { sql: "", message: failedText(statements.length, failed), tone: "warning" });
      patch(id, { activeResult: OUTPUT_TAB });
      return "failed";
    }

    async function endTransaction(id: string, method: "transaction.commit" | "transaction.rollback") {
      const current = get().consoles[id];
      const client = clients.get(id);
      if (current?.sessionId == null || client === undefined) return true;
      try {
        cursorsClosed(id);
        const state: TransactionState = await client.call(method, { sessionId: current.sessionId });
        patch(id, { transactionOpen: state.transactionOpen, ...namespaceOf(state) });
        const committed = method === "transaction.commit";
        log(id, { sql: "", message: committed ? "Committed" : "Rolled back", tone: "info" });
        afterTransactionChange(id, current.datasourceId, state.transactionOpen, committed);
        return true;
      } catch (cause) {
        logError(id, "", toError(cause));
        return false;
      }
    }

    function setEdits(id: string, resultId: string, edits: ConsoleResultEdits | null): void {
      const current = get().consoles[id];
      if (current === undefined) return;
      const { [resultId]: _dropped, ...rest } = current.edits;
      patch(id, { edits: edits === null ? rest : { ...rest, [resultId]: edits } });
    }

    /**
     * Submits a result's edits on the console's session (plan 026): its transaction mode decides
     * whether they commit, and the result runs again to show the rows as stored.
     */
    async function submitResultEdits(
      id: string,
      resultId: string,
      client: EngineClient,
      sessionId: string,
      edits: ConsoleResultEdits,
    ): Promise<boolean> {
      if (edits.key !== undefined) return submitKeyEdits(id, resultId, client, edits, edits.key);
      const changes = toEdits(edits.buffer);
      const preview = await client.call("edits.preview", { handle: edits.handle, edits: changes }).catch(() => null);
      const script = preview === null ? "" : submittedScript(preview);
      const label = submitLabel(preview?.length ?? pendingCount(edits.buffer));
      runStarts.set(id, dependencies.now());
      patch(id, { status: "running", error: null });
      const ended = started(id, script, label);
      const startedAt = dependencies.now();
      try {
        cursorsClosed(id);
        const submitted = await client.call("edits.submit", { sessionId, handle: edits.handle, edits: changes });
        const sql = submittedScript(submitted.statements);
        ended({
          durationMs: dependencies.now() - startedAt,
          outcome: "success",
          rowCount: submitted.rowsAffected,
          message: null,
          sql,
        });
        const done = submittedText(submitted.statements.length);
        log(id, {
          sql: "",
          message: submitted.transactionOpen ? `${done}; they stay in the open transaction` : done,
          tone: "success",
        });
        const latest = get().consoles[id]?.edits[resultId];
        if (latest !== undefined)
          setEdits(id, resultId, { ...latest, buffer: EMPTY_BUFFER, editing: null, panel: null });
        patch(id, { transactionOpen: submitted.transactionOpen, status: "ready" });
        await get().rerun(id, resultId);
        return true;
      } catch (cause) {
        const error = toError(cause);
        ended(failureEnd(error, dependencies.now() - startedAt));
        logError(id, firstLine(script), error);
        const latest = get().consoles[id];
        const kept = latest?.edits[resultId];
        if (kept !== undefined) setEdits(id, resultId, { ...kept, error });
        patch(id, {
          status: latest?.status === "disconnected" || latest?.status === "failed" ? latest.status : "ready",
        });
        return false;
      }
    }

    /**
     * Applies a whole-key result's edits as the key tab does (decision 119): one guarded `MULTI` on
     * the engine's helper session, which fails with `conflict` when the key changed since the read;
     * then the result runs again to show the key as stored.
     */
    async function submitKeyEdits(
      id: string,
      resultId: string,
      client: EngineClient,
      edits: ConsoleResultEdits,
      key: KeySource,
    ): Promise<boolean> {
      const result = resultOf(id, resultId);
      if (result === undefined) return false;
      const pending = resultKeyChanges(result, key, edits.buffer);
      if ("problem" in pending) {
        setEdits(id, resultId, { ...edits, error: keyProblemError(pending.problem) });
        return false;
      }
      if (pending.changes.length === 0) return false;
      const options = { type: key.type, guard: true };
      const preview = await client
        .call("keyspace.preview", { key: key.key, changes: pending.changes, options })
        .catch(() => null);
      const script = preview === null ? "" : preview.join("\n");
      const ended = started(id, script, submitCommandsLabel(preview?.length ?? pending.changes.length));
      const startedAt = dependencies.now();
      try {
        const applied = await client.call("keyspace.apply", {
          database: key.database,
          key: key.key,
          changes: pending.changes,
          options,
        });
        ended({
          durationMs: dependencies.now() - startedAt,
          outcome: "success",
          rowCount: null,
          message: null,
          sql: applied.commands.join("\n"),
        });
        log(id, { sql: "", message: submittedCommandsText(applied.commands.length), tone: "success" });
        const latest = get().consoles[id]?.edits[resultId];
        if (latest !== undefined)
          setEdits(id, resultId, { ...latest, buffer: EMPTY_BUFFER, editing: null, panel: null, error: null });
        await get().rerun(id, resultId);
        return true;
      } catch (cause) {
        const thrown = toError(cause);
        const error = thrown.code === "conflict" ? { ...thrown, hint: CONSOLE_CONFLICT_HINT } : thrown;
        ended(failureEnd(error, dependencies.now() - startedAt));
        logError(id, firstLine(script), error);
        const kept = get().consoles[id]?.edits[resultId];
        if (kept !== undefined) setEdits(id, resultId, { ...kept, error });
        return false;
      }
    }

    const consoleEdits = createConsoleEdits({
      session: (id) => get().consoles[id],
      result: (id, resultId) => resultOf(id, resultId),
      client: (id) => clients.get(id),
      setEdits,
      updateResult,
      submit: submitResultEdits,
    });

    async function settleEdits(id: string, verb: string, resultIds?: readonly string[]): Promise<boolean> {
      const current = get().consoles[id];
      const pending = pendingResults(current, resultIds);
      if (current === undefined || pending.length === 0) return true;
      for (const resultId of pending) consoleEdits.commitEdit(id, resultId);
      const latest = get().consoles[id];
      const changes = pending.reduce((sum, resultId) => sum + pendingEditsOf(latest?.edits[resultId]), 0);
      if (changes === 0) return true;
      const answer = await askPendingEdits({ changes, verb });
      if (answer === null) return false;
      if (answer === "discard") {
        for (const resultId of pending) consoleEdits.revertAllEdits(id, resultId);
        return true;
      }
      for (const resultId of pending) if (!(await consoleEdits.submitEdits(id, resultId))) return false;
      return true;
    }

    /** The unpinned results a run replaces (decision 10). */
    function unpinned(id: string): readonly string[] {
      return (get().consoles[id]?.results ?? []).filter((result) => !result.pinned).map((result) => result.id);
    }

    /** Whether reordering the result would move its pending edits to other rows. */
    function editsPinOrder(id: string, resultId: string): boolean {
      return pendingResults(get().consoles[id], [resultId]).length > 0;
    }

    /**
     * Runs `body` on the console's session as Run does: opening one first when it has none, marking
     * the console running, and recording the outcome as its last run.
     */
    async function onSession(
      id: string,
      body: (client: EngineClient, sessionId: string, session: ConsoleSession) => Promise<RunOutcome>,
    ): Promise<void> {
      const before = get().consoles[id];
      if (before === undefined || !canRun(before.status)) return;
      if (before.status !== "ready" && !(await openSession(id))) return;
      const current = get().consoles[id];
      const client = clients.get(id);
      if (current?.sessionId == null || current.status !== "ready" || client === undefined) return;
      runStarts.set(id, dependencies.now());
      patch(id, { status: "running", error: null });
      let outcome: RunOutcome = "failed";
      try {
        outcome = await body(client, current.sessionId, current);
      } catch (cause) {
        const error = toError(cause);
        logError(id, "", error);
        patch(id, { error, activeResult: OUTPUT_TAB });
      }
      const latest = get().consoles[id];
      patch(id, {
        // A detach while running already said the session is gone, and why.
        status: latest?.status === "disconnected" || latest?.status === "failed" ? latest.status : "ready",
        lastRun: { durationMs: runTime(id), outcome },
      });
    }

    /**
     * The values `statements` bind, asking for them when any has a parameter; null when the user
     * cancelled. Detection off, or no parameters, binds nothing and the statements run verbatim.
     * `preset` values answer without asking when they cover every name, detection on or off.
     */
    async function bindValues(
      id: string,
      statements: readonly ClassifiedStatement[],
      preset?: ParameterValues,
    ): Promise<Bound | null | false> {
      if (preset === undefined && !detectsParameters()) return null;
      const prompt = parameterPrompt(statements);
      if (prompt.names.length === 0) return null;
      const initial = { ...get().consoles[id]?.parameterValues, ...preset };
      if (preset !== undefined && prompt.names.every((name) => preset[name] !== undefined)) {
        patch(id, { parameterValues: initial });
        return { prompt, values: initial };
      }
      const values = await asked(id, () => askParameters({ prompt, initial }));
      if (values === null) return false;
      const current = get().consoles[id];
      if (current !== undefined) patch(id, { parameterValues: { ...current.parameterValues, ...values } });
      return { prompt, values };
    }

    /** Asks `ask` with the console waiting on the answer; the run's time starts once it is given. */
    async function confirmed(id: string, ask: () => Promise<boolean>): Promise<boolean> {
      return asked(id, ask);
    }

    async function asked<T>(id: string, ask: () => Promise<T>): Promise<T> {
      patch(id, { status: "confirming" });
      try {
        return await ask();
      } finally {
        // A detach while asking already said the session is gone.
        if (get().consoles[id]?.status === "confirming") patch(id, { status: "running" });
        runStarts.set(id, dependencies.now());
      }
    }

    function runTime(id: string): number {
      const now = dependencies.now();
      const startedAt = runStarts.get(id) ?? now;
      runStarts.delete(id);
      return now - startedAt;
    }

    /** Refused or declined: Output says why and nothing runs (plan 012 decision 9). */
    function notRun(id: string, sql: string, message: string): RunOutcome {
      log(id, { sql, message, tone: "warning" });
      patch(id, { activeResult: OUTPUT_TAB });
      return "cancelled";
    }

    /**
     * Explains one statement: the plugin's check, the question when Analyse writes, then the plan
     * into a new tab, or into `replacing` when a plan tab explains again.
     */
    async function explainOne(
      id: string,
      client: EngineClient,
      sessionId: string,
      statement: ClassifiedStatement,
      analyze: boolean,
      replacing: PlanTab | null,
    ): Promise<RunOutcome> {
      const sql = firstLine(statement.sql);
      const verdict = await client.call("sql.explainable", { sql: statement.sql, analyze });
      if (!verdict.ok) return notRun(id, sql, verdict.reason);
      const mode = get().consoles[id]?.txMode ?? "auto";
      if (analyze && verdict.writes && !(await confirmed(id, () => confirmAnalyse({ statement, mode })))) {
        return notRun(id, "", DECLINED);
      }
      if (replacing === null) {
        replaceUnpinned(id);
        patch(id, { flash: { from: statement.from, to: statement.to, seq: ++flashes } });
      }
      cursorsClosed(id);
      const ended = started(id, statement.sql, explainLabel(statement.sql, analyze));
      const startedAt = dependencies.now();
      try {
        const { plan, transactionOpen, reconnected } = await client.call("statement.explain", {
          sessionId,
          sql: statement.sql,
          analyze,
          ...limitOf(id),
        });
        logReconnected(id, reconnected);
        const moved = reconnected === undefined ? {} : namespaceOf(reconnected);
        const elapsed = dependencies.now() - startedAt;
        ended({
          durationMs: elapsed,
          outcome: "success",
          rowCount: null,
          message: null,
          sql: plan.statement,
          ...messagesOf(plan),
        });
        log(id, { sql, message: explainedText(analyze, elapsed), tone: "success" });
        logMessages(id, plan.messages);
        const current = get().consoles[id];
        if (current === undefined) return "cancelled";
        const effect: AnalysedEffect =
          analyze && verdict.writes ? (transactionOpen ? "inTransaction" : "committed") : "none";
        if (replacing === null) {
          const tab = planTabOf(`${id}/plan-${++resultIds}`, statement.sql, plan, effect);
          patch(id, { results: [...current.results, tab], activeResult: tab.id, transactionOpen, ...moved });
        } else {
          updatePlan(id, replacing.id, (latest) => ({
            ...planTabOf(latest.id, latest.sql, plan, effect),
            view: latest.view,
            pinned: latest.pinned,
          }));
          patch(id, { transactionOpen, ...moved });
        }
        if (analyze && statement.kind === "ddl") {
          if (transactionOpen) pendingDdl.add(id);
          else dependencies.onDdl?.(current.datasourceId);
        }
        return "succeeded";
      } catch (cause) {
        const error = toError(cause);
        ended(failureEnd(error, dependencies.now() - startedAt));
        const cancelled = error.code === "cancelled";
        if (cancelled) log(id, { sql, message: cancelledText(error), tone: "warning" });
        else logError(id, sql, error);
        patch(id, { error, activeResult: OUTPUT_TAB });
        return cancelled ? "cancelled" : "failed";
      }
    }

    return {
      consoles: {},
      ...consoleEdits,
      settleEdits,

      async open(id, datasourceId, options = {}) {
        const connect = options.connect ?? true;
        const session = newConsole(datasourceId, options.name ?? DEFAULT_CONSOLE_NAME, options.sql ?? "", connect);
        set({
          consoles: {
            ...get().consoles,
            [id]: {
              ...session,
              parameterValues: options.parameterValues ?? session.parameterValues,
              source: options.source ?? session.source,
              pendingNamespace: options.namespace ?? null,
            },
          },
        });
        if (connect) await openSession(id);
      },

      attach(id, datasourceId) {
        const current = get().consoles[id];
        if (current === undefined || current.datasourceId !== DETACHED) return;
        patch(id, { datasourceId, status: "disconnected", error: null });
      },

      saved(id, source, name) {
        patch(id, { source, diskChanged: null, ...(name === undefined ? {} : { name }) });
      },

      reloaded(id, sql, source) {
        patch(id, { sql, source, diskChanged: null, errorMarks: [] });
      },

      setDiskChanged(id, diskChanged) {
        if (get().consoles[id]?.diskChanged === diskChanged) return;
        patch(id, { diskChanged });
      },

      close(id) {
        const closing = get().consoles[id];
        if (closing === undefined) return;
        const { [id]: _closed, ...rest } = get().consoles;
        set({ consoles: rest });
        stopAsking(id);
        for (const result of closing.results) forget(result.id);
        pendingDdl.delete(id);
        const client = clients.get(id);
        clients.delete(id);
        if (closing.sessionId === null || client === undefined) return;
        void client.call("session.close", { sessionId: closing.sessionId }).catch(() => undefined);
      },

      detach(datasourceId, error) {
        for (const [id, session] of Object.entries(get().consoles)) {
          if (session.datasourceId !== datasourceId) continue;
          stopAsking(id);
          clients.delete(id);
          pendingDdl.delete(id);
          for (const result of session.results) invalidateWindows(result.id);
          if (session.transactionOpen) {
            log(id, { sql: "", message: "The session closed; its open transaction was rolled back.", tone: "warning" });
          }
          if (pendingResults(session).length > 0) {
            log(id, {
              sql: "",
              message: "The session closed; the results' pending edits were discarded.",
              tone: "warning",
            });
          }
          patch(id, {
            edits: {},
            sessionId: null,
            status: error === null ? "disconnected" : "failed",
            error: error ?? session.error,
            transactionOpen: false,
            namespace: null,
            results: session.results.map((result) =>
              isRows(result) ? { ...result, stale: true, cursorOpen: false, fetching: null } : result,
            ),
          });
        }
      },

      release(id) {
        const session = get().consoles[id];
        if (session === undefined) return;
        clients.delete(id);
        pendingDdl.delete(id);
        for (const result of session.results) invalidateWindows(result.id);
        patch(id, {
          datasourceId: DETACHED,
          edits: {},
          sessionId: null,
          status: "disconnected",
          error: null,
          transactionOpen: false,
          namespace: null,
          pendingNamespace: null,
          results: [],
          activeResult: OUTPUT_TAB,
        });
      },

      setSql(id, sql) {
        patch(id, { sql });
      },

      setSelection(id, selection) {
        const current = get().consoles[id];
        if (current === undefined) return;
        if (current.selection.from === selection.from && current.selection.to === selection.to) return;
        patch(id, { selection });
      },

      insert(id, text, values) {
        const current = get().consoles[id];
        if (current === undefined) return;
        flashes += 1;
        patch(id, {
          insertion: { text, seq: flashes },
          ...(values === undefined ? {} : { parameterValues: { ...current.parameterValues, ...values } }),
        });
      },

      async reformat(id) {
        const current = get().consoles[id];
        if (current === undefined) return;
        const { sql, selection } = current;
        const whole = selection.from === selection.to;
        const from = whole ? 0 : Math.min(selection.from, selection.to);
        const to = whole ? sql.length : Math.max(selection.from, selection.to);
        const before = sql.slice(from, to);
        if (before.trim() === "") return;
        try {
          const client = await dependencies.connect(current.datasourceId);
          const text = await client.call("sql.format", { text: before, options: currentFormatOptions() });
          if (text === before || get().consoles[id] === undefined) return;
          const caret = from + caretAfterReformat(before, text, selection.to - from);
          flashes += 1;
          patch(id, {
            replacement: {
              from,
              to,
              before,
              text,
              selection: whole ? { from: caret, to: caret } : { from, to: from + text.length },
              seq: flashes,
            },
          });
        } catch (cause) {
          const error = toError(cause);
          log(id, {
            sql: "",
            message: `${REFORMAT_FAILED}: ${firstLine(error.message)}`,
            hint: error.hint,
            tone: "error",
          });
        }
      },

      replaced(id, seq) {
        if (get().consoles[id]?.replacement?.seq !== seq) return;
        patch(id, { replacement: null });
      },

      inserted(id, seq) {
        if (get().consoles[id]?.insertion?.seq !== seq) return;
        patch(id, { insertion: null });
      },

      marksMoved(id, errorMarks) {
        if (get().consoles[id]?.errorMarks === errorMarks) return;
        patch(id, { errorMarks });
      },

      markErrors(id, marks) {
        const current = get().consoles[id];
        if (current === undefined || marks.length === 0) return;
        patch(id, { errorMarks: marks.reduce(withMark, current.errorMarks) });
      },

      gotoError(id, backward) {
        const current = get().consoles[id];
        if (current === undefined) return false;
        const { from, to } = current.selection;
        const mark = nextMark(current.errorMarks, backward ? Math.min(from, to) : Math.max(from, to), backward);
        if (mark === null) return false;
        get().jumpTo(id, mark);
        return true;
      },

      showError(id) {
        const current = get().consoles[id];
        const mark = current === undefined ? null : markOfError(current.errorMarks, current.error);
        if (mark === null) return false;
        get().jumpTo(id, mark);
        return true;
      },

      answerError(id, answer) {
        const resolve = answers.get(id);
        answers.delete(id);
        resolve?.(answer);
      },

      jumpTo(id, span) {
        if (get().consoles[id] === undefined) return;
        flashes += 1;
        patch(id, {
          selection: { from: span.from, to: span.from },
          jump: { ...span, seq: flashes },
          flash: { ...span, seq: flashes },
        });
      },

      jumped(id, seq) {
        if (get().consoles[id]?.jump?.seq !== seq) return;
        patch(id, { jump: null });
      },

      async switchNamespace(id, path) {
        const before = get().consoles[id];
        if (before === undefined || !canRun(before.status)) return;
        if (!(await settleEdits(id, SWITCH_VERB))) return;
        await onSession(id, (client, sessionId, session) =>
          switchOn(id, client, sessionId, path, session.transactionOpen),
        );
      },

      async run(id, scope, preset) {
        const before = get().consoles[id];
        if (before === undefined || !canRun(before.status)) return;
        if (!(await settleEdits(id, "run", unpinned(id)))) return;
        if (before.status !== "ready" && !(await openSession(id))) return;
        const current = get().consoles[id];
        const client = clients.get(id);
        if (current?.sessionId == null || current.status !== "ready" || client === undefined) return;
        const { sessionId } = current;
        runStarts.set(id, dependencies.now());
        patch(id, { status: "running", error: null });
        let outcome: RunOutcome = "failed";
        try {
          const statements = await resolveTarget(client, current, scope);
          if (statements.length === 0) {
            log(id, { sql: "", message: "Nothing to run", tone: "info" });
            patch(id, { activeResult: OUTPUT_TAB });
            outcome = "succeeded";
          } else {
            const destructive = statements.filter((statement) => statement.destructive !== null);
            const declined =
              destructive.length > 0 &&
              !(await confirmed(id, () => confirmDestructive(destructive, current.datasourceId)));
            const bound = declined ? false : await bindValues(id, statements, preset);
            if (bound === false) {
              log(id, { sql: "", message: DECLINED, tone: "warning" });
              patch(id, { activeResult: OUTPUT_TAB });
              outcome = "cancelled";
            } else {
              replaceUnpinned(id);
              outcome = await execute(id, client, sessionId, statements, bound);
            }
          }
        } catch (cause) {
          const error = toError(cause);
          logError(id, "", error);
          patch(id, { error, activeResult: OUTPUT_TAB });
        }
        const latest = get().consoles[id];
        patch(id, {
          // A detach while running already said the session is gone, and why.
          status: latest?.status === "disconnected" || latest?.status === "failed" ? latest.status : "ready",
          lastRun: { durationMs: runTime(id), outcome },
        });
      },

      async cancel(id) {
        if (answers.has(id)) {
          stopAsking(id);
          return;
        }
        const current = get().consoles[id];
        const client = clients.get(id);
        if (current?.sessionId == null || current.status !== "running" || client === undefined) return;
        try {
          await client.call("statement.cancel", { sessionId: current.sessionId });
        } catch (cause) {
          patch(id, { error: toError(cause) });
        }
      },

      ensureWindow: windows.ensureWindow,
      async fetchMore(id, resultId, all) {
        // Rows fetched into a sorted result take positions among the held ones, which edits name.
        const sorted = (resultOf(id, resultId)?.sort.length ?? 0) > 0;
        if (sorted && editsPinOrder(id, resultId) && !(await settleEdits(id, "fetch more rows", [resultId]))) return;
        await windows.fetchMore(id, resultId, all);
      },
      stopFetch: windows.stopFetch,

      async sort(id, resultId, keys) {
        if (editsPinOrder(id, resultId) && !(await settleEdits(id, "sort", [resultId]))) return;
        const result = resultOf(id, resultId);
        const client = clients.get(id);
        if (result === undefined) return;
        if (client === undefined || result.stale) {
          // Sorting is the engine's (decision 009); a closed connection's rows keep their order.
          return;
        }
        try {
          const state = await client.call("result.sort", { handle: result.handle, keys: [...keys] });
          invalidateWindows(resultId);
          updateResult(id, resultId, (latest) => ({
            ...latest,
            ...state,
            sort: keys,
            windows: {},
            matches: {},
            selection: null,
            search: { ...latest.search, current: null },
          }));
          await windows.refreshView(id, resultId);
        } catch (cause) {
          logError(id, firstLine(result.sql), toError(cause));
        }
      },

      setLayout(id, resultId, layout) {
        const before = resultOf(id, resultId);
        updateResult(id, resultId, (latest) => {
          const visible = layout.hidden.filter((hidden) => !hidden).length;
          const hiddenChanged = layout.hidden.some((hidden, index) => hidden !== latest.layout.hidden[index]);
          const selection = hiddenChanged
            ? null
            : clampSelection(latest.selection, { rows: shownRowCount(latest), columns: visible });
          return { ...latest, layout, selection };
        });
        if (before !== undefined && searchedColumnsChanged(before.layout, layout)) void windows.applyView(id, resultId);
      },

      async search(id, resultId, change) {
        // An open editor names its cell by shown row, which a new view moves; edits name held rows and stay.
        consoleEdits.commitEdit(id, resultId);
        consoleEdits.applyPanel(id, resultId);
        const result = resultOf(id, resultId);
        // A sorted result's rows are held by position until filtered, then by arrival (plan 026).
        const refilters =
          result !== undefined && result.sort.length > 0 && filterOf(change(result.search)) !== filterOf(result.search);
        if (refilters && editsPinOrder(id, resultId) && !(await settleEdits(id, "filter", [resultId]))) return;
        await windows.search(id, resultId, change);
      },
      findNext: windows.findNext,

      select(id, resultId, selection) {
        updateResult(id, resultId, (latest) => (latest.selection === selection ? latest : { ...latest, selection }));
      },

      explain: async (id, analyze) => {
        if (!(await settleEdits(id, "explain", unpinned(id)))) return;
        await onSession(id, async (client, sessionId, session) => {
          const statements = await resolveTarget(client, session, "caret");
          const [statement] = statements;
          if (statement === undefined) {
            log(id, { sql: "", message: NOTHING_TO_EXPLAIN, tone: "info" });
            patch(id, { activeResult: OUTPUT_TAB });
            return "succeeded";
          }
          if (statements.length > 1) return notRun(id, "", EXPLAIN_ONE_STATEMENT);
          return explainOne(id, client, sessionId, statement, analyze, null);
        });
      },

      async rerun(id, resultId) {
        const plan = planOf(id, resultId);
        if (plan !== undefined) {
          await onSession(id, async (client, sessionId) => {
            const [statement] = await client.call("script.split", { text: plan.sql });
            if (statement === undefined) return notRun(id, "", NOTHING_TO_EXPLAIN);
            const latest = planOf(id, resultId);
            if (latest === undefined) return "cancelled";
            return explainOne(id, client, sessionId, statement, plan.analyzed, latest);
          });
          return;
        }
        const before = get().consoles[id];
        if (before === undefined || resultOf(id, resultId) === undefined || !canRun(before.status)) return;
        if (!(await settleEdits(id, "run it again", [resultId]))) return;
        if (before.status !== "ready" && !(await openSession(id))) return;
        const current = get().consoles[id];
        const client = clients.get(id);
        const tab = resultOf(id, resultId);
        if (current?.sessionId == null || current.status !== "ready" || client === undefined || tab === undefined)
          return;
        const { sessionId } = current;
        const sql = firstLine(tab.sql);
        runStarts.set(id, dependencies.now());
        patch(id, { status: "running", error: null });
        let outcome: RunOutcome;
        let ended: Ended | null = null;
        let statementStartedAt = dependencies.now();
        try {
          const [statement] = await client.call("script.split", { text: tab.sql });
          const declined =
            statement !== undefined &&
            statement.destructive !== null &&
            !(await confirmed(id, () => confirmDestructive([statement], current.datasourceId)));
          const bound = declined ? false : await bindValues(id, statement === undefined ? [] : [statement]);
          const parameters = bound === false ? undefined : boundAt(bound, 0);
          if (bound === false) {
            log(id, { sql: "", message: DECLINED, tone: "warning" });
            outcome = "cancelled";
          } else {
            cursorsClosed(id);
            ended = started(id, tab.sql, sql, parameters ?? null);
            producedBy.set(resultId, ended.executionId);
            statementStartedAt = dependencies.now();
            const paging = currentPaging();
            const { transactionOpen, namespace, reconnected, ...executed } = await client.call("statement.execute", {
              sessionId,
              sql: tab.sql,
              ...(parameters === undefined ? {} : { parameters }),
              ...paging,
              ...limitOf(id),
              ...nodeOf(id),
            });
            logReconnected(id, reconnected);
            const kind = statement?.kind ?? "read";
            const elapsed = dependencies.now() - statementStartedAt;
            ended({
              durationMs: elapsed,
              outcome: "success",
              rowCount: rowsOf(executed),
              message: null,
              ...messagesOf(executed),
            });
            ended = null;
            log(id, {
              sql,
              message: executedText(executed, elapsed, kind),
              tone: "success",
              ...(executed.source === undefined ? {} : { key: executed.source }),
            });
            logMessages(id, executed.messages);
            const latest = resultOf(id, resultId);
            if (latest === undefined) {
              void client.call("result.release", { handle: executed.handle }).catch(() => undefined);
            } else {
              if (!latest.stale) void client.call("result.release", { handle: latest.handle }).catch(() => undefined);
              invalidateWindows(resultId);
              const fresh = resultTabOf(
                executed,
                { id: latest.id, title: latest.title },
                latest.sql,
                paging,
                currentFormats(),
              );
              const names = (columns: readonly Column[]) => columns.map((column) => column.name);
              const layout = carriedLayout(latest.layout, names(latest.columns), names(fresh.columns));
              const kept = layout === latest.layout;
              const sort = kept ? latest.sort : [];
              const state =
                sort.length > 0 ? await client.call("result.sort", { handle: fresh.handle, keys: [...sort] }) : fresh;
              updateResult(id, resultId, () => ({
                ...fresh,
                ...state,
                pinned: latest.pinned,
                ...(latest.valueFormat === undefined ? {} : { valueFormat: latest.valueFormat }),
                layout,
                autoChars: kept ? latest.autoChars : fresh.autoChars,
                sort,
                windows: sort.length > 0 ? {} : fresh.windows,
                search: kept ? { ...latest.search, current: null } : fresh.search,
              }));
              if (kept) await windows.applyView(id, resultId);
            }
            patch(id, {
              transactionOpen,
              ...namespaceAfter({ namespace, ...(reconnected === undefined ? {} : { reconnected }) }),
            });
            outcome = "succeeded";
          }
        } catch (cause) {
          const error = toError(cause);
          ended?.(failureEnd(error, dependencies.now() - statementStartedAt));
          if (error.code === "cancelled") log(id, { sql, message: cancelledText(error), tone: "warning" });
          else logError(id, sql, error);
          patch(id, { error, activeResult: OUTPUT_TAB });
          outcome = error.code === "cancelled" ? "cancelled" : "failed";
        }
        const latest = get().consoles[id];
        patch(id, {
          status: latest?.status === "disconnected" || latest?.status === "failed" ? latest.status : "ready",
          lastRun: { durationMs: runTime(id), outcome },
        });
      },

      extract: windows.extract,
      aggregate: windows.aggregate,
      cellBytes: windows.cellBytes,
      saveBytes: windows.saveBytes,
      loadBytes: windows.loadBytes,

      async exportTo(id, resultId, format, path, columns, shownOnly) {
        const task = await windows.exportTo(id, resultId, format, path, columns, shownOnly);
        const result = resultOf(id, resultId);
        if (task === null || result === undefined) return false;
        const sql = firstLine(result.sql);
        void exports.finished(task.taskId).then((ended) => {
          if (ended.state === "done") log(id, { sql, message: exportedText(ended), tone: "success" });
          else if (ended.error !== null) {
            log(id, {
              sql,
              message: ended.error.message,
              hint: ended.error.hint,
              tone: ended.state === "cancelled" ? "warning" : "error",
            });
          }
        });
        return true;
      },

      showResult(id, resultId) {
        const current = get().consoles[id];
        if (current === undefined) return;
        if (resultId !== OUTPUT_TAB && !current.results.some((result) => result.id === resultId)) return;
        patch(id, { activeResult: resultId });
      },

      showReply(id, entryId) {
        const current = get().consoles[id];
        const shown = current?.output.find((entry) => entry.id === entryId)?.result;
        if (current === undefined || shown === undefined) return;
        const open = current.results.find((tab) => tab.kind === "rows" && tab.handle === shown.executed.handle);
        if (open !== undefined) {
          patch(id, { activeResult: open.id });
          return;
        }
        const tab = resultTabOf(
          shown.executed,
          { id: `${id}/result-${++resultIds}`, title: nextResultTitle(current.results) },
          shown.sql,
          shown.paging,
          currentFormats(),
        );
        patch(id, { results: [...current.results, tab], activeResult: tab.id });
      },

      setValueFormat(id, resultId, format) {
        updateResult(id, resultId, (result) => ({ ...result, valueFormat: format }));
      },

      updatePlan(id, planId, change) {
        updatePlan(id, planId, (latest) => ({ ...latest, ...change }));
      },

      togglePin(id, resultId) {
        const current = get().consoles[id];
        if (current === undefined) return;
        patch(id, {
          results: current.results.map((result) =>
            result.id === resultId ? { ...result, pinned: !result.pinned } : result,
          ),
        });
      },

      setNode(id, node) {
        patch(id, { node });
      },

      async setTransactionMode(id, mode) {
        const current = get().consoles[id];
        if (current === undefined) return false;
        const client = clients.get(id);
        if (current.sessionId === null || client === undefined || current.status !== "ready") {
          patch(id, { txMode: mode });
          return true;
        }
        return applyMode(id, client, current.sessionId, mode);
      },

      commit: (id) => endTransaction(id, "transaction.commit"),
      rollback: (id) => endTransaction(id, "transaction.rollback"),
    };
  });
}

export type ConsolesStore = ReturnType<typeof createConsolesStore>;

/** What decides a local filter's rows: the find query counts only while it filters. */
function filterOf(search: ResultSearch): string {
  return JSON.stringify({ filters: search.filters, query: search.rowsOnly ? search.query : null });
}

async function askPendingEditsInDialog({ changes, verb }: PendingEditsRequest): Promise<PendingEditsAnswer | null> {
  const answer = await useModal.getState().ask({
    kind: "choice",
    title: "Pending changes",
    message: `This result has changes not yet submitted. Submit or discard them to ${verb}.`,
    items: [{ label: pendingText(changes) ?? "", detail: "" }],
    choices: [
      { id: "submit", label: "Submit", variant: "primary" },
      { id: "discard", label: "Discard", variant: "danger" },
    ],
  });
  return answer === "submit" || answer === "discard" ? answer : null;
}

/**
 * The destructive-statement confirmation (decision 9): one dialog for the whole batch. A statement
 * marked `confirmByName`, such as FLUSHDB, makes the user type the datasource's name (decision 112).
 */
export function destructiveConfirmation(
  statements: readonly ClassifiedStatement[],
  datasourceName: string,
): ModalRequest {
  const byName = statements.some((statement) => statement.confirmByName === true);
  return {
    kind: "confirm",
    title:
      statements.length === 1 ? "Run a destructive statement?" : `Run ${statements.length} destructive statements?`,
    message: byName
      ? `These statements can remove data that cannot be recovered. Type ${datasourceName} to run them:`
      : "These statements can change or remove data that cannot be recovered:",
    items: statements.map((statement) => ({ label: firstLine(statement.sql), detail: statement.destructive ?? "" })),
    confirm: "Execute",
    destructive: true,
    ...(byName ? { typed: datasourceName } : {}),
  };
}

async function askDestructive(statements: readonly ClassifiedStatement[], datasourceId: string): Promise<boolean> {
  const name = datasourceById(useDatasources.getState(), datasourceId)?.name ?? datasourceId;
  return (await useModal.getState().ask(destructiveConfirmation(statements, name))) !== null;
}

export const PARAMETERS_TITLE = "Parameters";

/** The Parameters dialog's question for a prompt; each statement shows its placeholders marked. */
export function parametersQuestion(request: ParametersRequest): ModalRequest {
  return {
    kind: "parameters",
    title: PARAMETERS_TITLE,
    names: request.prompt.names,
    initial: request.initial,
    statements: request.prompt.statements.map(({ statement }) => ({
      sql: statement.sql,
      marks: statement.parameters.map(({ from, to }) => ({ from, to })),
    })),
  };
}

async function askParametersInDialog(request: ParametersRequest): Promise<ParameterValues | null> {
  const answer = await useModal.getState().ask(parametersQuestion(request));
  return answer === null ? null : parseParametersAnswer(answer);
}

async function askAnalyse(request: AnalyseRequest): Promise<boolean> {
  return (await useModal.getState().ask(analyseConfirmation(request))) !== null;
}

export const CHOOSE_DATASOURCE_TITLE = "Run on Data Source";

/** Asks which datasource a detached file console runs on. */
export async function chooseDatasourceInDialog(title = CHOOSE_DATASOURCE_TITLE): Promise<string | null> {
  return useModal.getState().ask({
    kind: "pick",
    title,
    searchLabel: "Data sources",
    items: useDatasources.getState().datasources.map((datasource) => ({
      id: datasource.id,
      label: datasource.name,
      detail: datasource.pluginId,
    })),
    empty: "No data sources. Add one with New Data Source….",
    confirm: "Choose",
  });
}

export const useConsoles = createConsolesStore({
  connect: (datasourceId) => useDatasources.getState().connect(datasourceId),
  chooseDatasource: () => chooseDatasourceInDialog(),
  exports: useExports.getState(),
  statementTimeout: (datasourceId) => statementTimeoutOf(datasourceById(useDatasources.getState(), datasourceId)),
  serverEnforced: (datasourceId) => serverEnforcedOf(datasourceById(useDatasources.getState(), datasourceId)),
  now: () => performance.now(),
  confirmDestructive: askDestructive,
  confirmAnalyse: askAnalyse,
  askParameters: askParametersInDialog,
  askPendingEdits: askPendingEditsInDialog,
  onError: runAllOnError,
  onDdl: (datasourceId) => void useCatalog.getState().refreshCached(datasourceId),
  executions: {
    start: (tabId, start) => useExecutions.getState().start(tabId, start),
    finish: (tabId, executionId, end) => useExecutions.getState().finish(tabId, executionId, end),
    recount: (tabId, executionId, rowCount) => useExecutions.getState().recount(tabId, executionId, rowCount),
  },
  record: (entry) => history.record(entry),
});

/** The consoles open on a datasource, by console id. */
export function consolesOf(consoles: ConsolesState["consoles"], datasourceId: string): readonly string[] {
  return Object.entries(consoles)
    .filter(([, session]) => session.datasourceId === datasourceId)
    .map(([id]) => id);
}

/** The consoles holding an open transaction, by console id. */
export function openTransactions(consoles: ConsolesState["consoles"]): readonly string[] {
  return Object.entries(consoles)
    .filter(([, session]) => session.transactionOpen)
    .map(([id]) => id);
}
