import { create } from "zustand";
import type {
  CellInput,
  EngineError,
  KeyBytes,
  KeyDetails,
  KeyName,
  KeyHistoryEvent,
  KeyApplyOptions,
  KeyLeaseAssignment,
  KeyReadRange,
  KeyType,
  Row,
  SortKey,
  WireValue,
} from "@table-craft/desktop/engine/protocol.js";
import type { EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import { carriedLayout } from "@table-craft/desktop/renderer/model/columnLayout.js";
import {
  appendHistory,
  EMPTY_KEY_HISTORY,
  historyEventId,
  type KeyHistoryState,
} from "@table-craft/desktop/renderer/model/keyHistory.js";
import { mergeKeyText } from "@table-craft/desktop/renderer/model/keyMerge.js";
import { readOnlyReason, savedNoticeText, sameStringBytes } from "./keyTabSave.js";
import { isKubernetesKeyValue } from "@table-craft/desktop/renderer/model/valueFormats.js";
import {
  beginKeyMerge,
  canSaveKeyMerge,
  type KeyMergeSession,
} from "@table-craft/desktop/renderer/model/keyMergeSession.js";
import {
  EMPTY_BUFFER,
  pendingCount,
  type BufferCell,
  type EditBuffer,
} from "@table-craft/desktop/renderer/model/editBuffer.js";
import {
  editsRows,
  bytesOfValue,
  keyChangesOf,
  keyReadOnlyColumns,
  recreateChanges,
  stringChanges,
  type KeyChanges,
} from "@table-craft/desktop/renderer/model/keyChanges.js";
import {
  canEditCell,
  clampedTo,
  editCellText,
  editorAt,
  withAddedRow,
  withCells,
  withDeletes,
  withDuplicates,
  withReverted,
  type CellEditor,
  type EditTarget,
} from "@table-craft/desktop/renderer/model/resultEdits.js";
import { clampSelection } from "@table-craft/desktop/renderer/model/gridSelection.js";
import { datasourceById, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { NO_EXPORTS, useExports, type ExportStarter } from "@table-craft/desktop/renderer/state/exports.js";
import {
  NO_EXECUTION_REPORTER,
  useExecutions,
  type ExecutionReporter,
} from "@table-craft/desktop/renderer/state/executions.js";
import {
  resultTabOf,
  rowAt,
  searchedColumnsChanged,
  shownRowCount,
  type ResultTab,
} from "@table-craft/desktop/renderer/state/resultTab.js";
import { createResultWindows, toError } from "@table-craft/desktop/renderer/state/resultWindows.js";
import { currentFormats, currentPaging, statementTimeoutOf } from "@table-craft/desktop/renderer/state/settings.js";

/** Which key a key tab shows (plan 058 decision 14). */
export interface KeyTarget {
  readonly datasourceId: string;
  readonly database: number;
  readonly key: KeyName;
}

export type KeyTabStatus = "connecting" | "ready" | "loading" | "submitting" | "failed" | "disconnected";

/** The filter bar's fields: a MATCH glob for hashes, sets and sorted sets, From and To ids for streams. */
export interface KeyRangeDraft {
  readonly match: string;
  readonly from: string;
  readonly to: string;
}

export const EMPTY_RANGE: KeyRangeDraft = { match: "", from: "", to: "" };

export interface KeyTab extends KeyTarget {
  readonly leaseAssignmentAvailable?: boolean;
  readonly leaseDraft?: KeyLeaseAssignment | null;
  readonly merge?: KeyMergeSession | null;
  readonly history?: KeyHistoryState;
  readonly historyAvailable?: boolean;
  readonly revisionGuardAvailable?: boolean;
  readonly sessionId: string | null;
  readonly status: KeyTabStatus;
  /** What went wrong reaching the server. */
  readonly error: EngineError | null;
  /** What the server said of the last read, such as a bad MATCH pattern. */
  readonly queryError: EngineError | null;
  /** Null until the first read answers. */
  readonly details: KeyDetails | null;
  /** When `details` was read, by the store's clock: the TTL counts down from it. */
  readonly readAt: number | null;
  /** A string key's value; null for the other types, which show rows. */
  readonly value: WireValue | null;
  /** Why the key opens read-only, such as a RedisJSON document; null when it takes edits. */
  readonly readOnly: string | null;
  readonly result: ResultTab | null;
  readonly applied: KeyRangeDraft;
  readonly draft: KeyRangeDraft;
  /** Pending changes to the rows (decision 115). */
  readonly buffer: EditBuffer;
  readonly editing: CellEditor | null;
  readonly panel: CellEditor | null;
  readonly readOnlyColumns: readonly boolean[];
  /** A string key's pending value; null while it is unchanged. */
  readonly stringValue: KeyBytes | null;
  /** Replaces the editor document without changing the server revision or read-time baseline. */
  readonly editorGeneration?: number;
  readonly stringProblem?: string | null;
  /** The type the key had before it went missing: its last rows stay shown, for Recreate. */
  readonly lostType: KeyType | null;
  /** Recreate is pending: Submit writes the last rows back as a new key. */
  readonly recreating: boolean;
  /** A guarded submit found the key changed since it was read. */
  readonly conflict: EngineError | null;
  /** What the last submit did, for the footer. */
  readonly notice: string | null;
}

export interface KeyTabsState {
  readonly setLease: (id: string, lease: KeyLeaseAssignment) => void;
  readonly editMerge: (id: string, text: string) => void;
  readonly chooseMerge: (id: string, path: string, side: "theirs" | "yours") => void;
  readonly acknowledgeMerge: (id: string) => void;
  readonly nextMergeConflict: (id: string) => void;
  readonly previousMergeConflict: (id: string) => void;
  readonly cancelMerge: (id: string) => void;
  readonly discardMerge: (id: string) => void;
  readonly saveMerge: (id: string) => Promise<boolean>;
  readonly historyMode: (id: string, mode: "value" | "history") => void;
  readonly loadHistory: (id: string) => Promise<void>;
  readonly selectHistory: (id: string, eventId: string) => void;
  readonly restoreHistory: (id: string) => boolean;
  readonly tabs: Readonly<Record<string, KeyTab>>;
  readonly open: (id: string, target: KeyTarget, options?: { readonly connect?: boolean }) => Promise<void>;
  readonly close: (id: string) => void;
  readonly detach: (datasourceId: string, error: EngineError | null) => void;
  /** Reads the key again with the filter bar's fields; false when it could not. */
  readonly reload: (id: string, range?: KeyRangeDraft) => Promise<boolean>;
  readonly setDraft: (id: string, draft: Partial<KeyRangeDraft>) => void;
  readonly revertDraft: (id: string) => void;
  readonly ensureWindow: (id: string, resultId: string, offset: number) => void;
  readonly fetchMore: (id: string, resultId: string, all: boolean) => Promise<void>;
  readonly stopFetch: (id: string, resultId: string) => Promise<void>;
  readonly sort: (id: string, resultId: string, keys: readonly SortKey[]) => Promise<void>;
  readonly setLayout: KeyTabsHost["setLayout"];
  readonly select: KeyTabsHost["select"];
  readonly extract: KeyTabsHost["extract"];
  readonly aggregate: KeyTabsHost["aggregate"];
  readonly cellBytes: KeyTabsHost["cellBytes"];
  readonly saveBytes: KeyTabsHost["saveBytes"];
  readonly loadBytes: KeyTabsHost["loadBytes"];
  readonly exportTo: KeyTabsHost["exportTo"];
  readonly search: KeyTabsHost["search"];
  readonly findNext: KeyTabsHost["findNext"];
  readonly beginEdit: (id: string, cell: BufferCell, text?: string) => void;
  readonly changeEdit: (id: string, text: string) => void;
  readonly commitEdit: (id: string) => boolean;
  readonly cancelEdit: (id: string) => void;
  readonly editPanel: (id: string, cell: BufferCell | null, text?: string) => void;
  readonly applyPanel: (id: string) => boolean;
  readonly setCells: (id: string, cells: readonly BufferCell[], input: CellInput) => void;
  readonly addRow: (id: string) => void;
  readonly duplicateRows: (id: string, rows: readonly number[]) => void;
  readonly deleteRows: (id: string, rows: readonly number[]) => void;
  readonly revert: (id: string, cells: readonly BufferCell[]) => void;
  readonly revertAll: (id: string) => void;
  /** A string key's new value; null drops the change. */
  readonly setStringValue: (id: string, value: KeyBytes | null) => void;
  readonly setStringProblem: (id: string, problem: string) => void;
  /** Makes the last rows of a key that went missing pending, to submit as a new key. */
  readonly recreate: (id: string) => void;
  readonly preview: (id: string) => Promise<readonly string[] | null>;
  /** Applies the pending changes; unguarded only after a conflict, to overwrite. */
  readonly submit: (id: string, guard?: boolean) => Promise<boolean>;
  readonly dismissConflict: (id: string) => void;
}

type ResultWindows = ReturnType<typeof createResultWindows>;

interface KeyTabsHost {
  readonly setLayout: (id: string, resultId: string, layout: ResultTab["layout"]) => void;
  readonly select: (id: string, resultId: string, selection: ResultTab["selection"]) => void;
  readonly extract: ResultWindows["extract"];
  readonly aggregate: ResultWindows["aggregate"];
  readonly cellBytes: ResultWindows["cellBytes"];
  readonly saveBytes: ResultWindows["saveBytes"];
  readonly loadBytes: ResultWindows["loadBytes"];
  readonly exportTo: (...args: Parameters<ResultWindows["exportTo"]>) => Promise<boolean>;
  readonly search: ResultWindows["search"];
  readonly findNext: ResultWindows["findNext"];
}

export interface KeyTabsDependencies {
  readonly connect: (datasourceId: string) => Promise<EngineClient>;
  /** Milliseconds for the TTL countdown; `Date.now` outside tests. */
  readonly clock?: () => number;
  readonly executions?: ExecutionReporter;
  readonly exports?: ExportStarter;
  readonly statementTimeout?: (datasourceId: string) => number;
  /** Whether the datasource is read-only, so its key tabs take no edits. */
  readonly readOnly?: (datasourceId: string) => boolean;
}

const LOAD_LABEL = "Read key";
const SUBMIT_LABEL = "Submit key changes";
const RECREATE_UNLOADED = "Recreate writes back the rows read last; fetch them all first.";
export const KEY_SAVED_NOTICE_MS = 4_000;
const HISTORY_COUNT = 20;
const HISTORY_BYTES = 1_048_576;
const HISTORY_TIMEOUT_MS = 5_000;
const RESTORE_NOTICE = "Historical value staged. The current lease is kept; an old lease is not restored.";

/** Which filter fields a key type reads: streams page by id, the scanned types by MATCH. */
export function rangeFields(type: KeyType | null): "match" | "ids" | null {
  if (type === "hash" || type === "set" || type === "zset") return "match";
  if (type === "stream") return "ids";
  return null;
}

/** The read range the filter bar's fields ask for; blank fields read everything. */
export function keyRangeOf(type: KeyType | null, draft: KeyRangeDraft): KeyReadRange {
  const fields = rangeFields(type);
  const match = draft.match.trim();
  const from = draft.from.trim();
  const to = draft.to.trim();
  if (fields === "match") return match === "" ? {} : { match };
  if (fields === "ids") return { ...(from === "" ? {} : { from }), ...(to === "" ? {} : { to }) };
  return {};
}

/** The TTL left now, counted down from when the key was read; null when it does not expire. */
export function remainingTtl(details: KeyDetails | null, readAt: number | null, now: number): number | null {
  if (details?.ttlMs == null || readAt === null) return null;
  return Math.max(0, details.ttlMs - Math.max(0, now - readAt));
}

/** The key is gone: a read answered that no key has the name. */
export function keyMissing(tab: KeyTab): boolean {
  return tab.details !== null && tab.details.type === null;
}

export function canReloadKey(status: KeyTabStatus): boolean {
  return status !== "connecting" && status !== "loading" && status !== "submitting";
}

function typeOf(tab: KeyTab): KeyType {
  return tab.details?.type ?? tab.lostType ?? "other";
}

function problemError(message: string): EngineError {
  return { code: "statementFailed", message, hint: "" };
}

function newTab(target: KeyTarget): KeyTab {
  return {
    ...target,
    sessionId: null,
    status: "disconnected",
    error: null,
    queryError: null,
    details: null,
    readAt: null,
    value: null,
    editorGeneration: 0,
    readOnly: null,
    result: null,
    applied: EMPTY_RANGE,
    draft: EMPTY_RANGE,
    ...NO_EDITS,
    readOnlyColumns: [],
    lostType: null,
    notice: null,
  };
}

const NO_EDITS = {
  leaseDraft: null,
  merge: null,
  buffer: EMPTY_BUFFER,
  editing: null,
  panel: null,
  stringValue: null,
  stringProblem: null,
  recreating: false,
  conflict: null,
} as const;

/** The key tab as the grid's edit functions see it. */
export function keyEditTarget(tab: KeyTab): EditTarget {
  return { result: tab.result, buffer: tab.buffer, editable: null, columns: [], readOnlyColumns: tab.readOnlyColumns };
}

/** Whether the tab takes edits now: a live, writable key of a type edited row by row or as a string. */
export function isKeyEditable(tab: KeyTab | undefined, datasourceReadOnly: boolean): tab is KeyTab {
  if (tab === undefined || datasourceReadOnly || tab.status !== "ready" || tab.readOnly !== null) return false;
  if ((tab.merge != null || tab.recreating) && tab.lostType === "string") return true;
  if (keyMissing(tab) || tab.recreating) return false;
  if (tab.details?.type === "string") return true;
  return editsRows(tab.details?.type ?? null) && tab.result !== null && !tab.result.stale;
}

/** The tab's pending changes as changes to the key; a problem when one cannot be written. */
export function pendingKeyChanges(tab: KeyTab): KeyChanges {
  if (tab.stringProblem != null) return { problem: tab.stringProblem };
  if (tab.merge != null) {
    if (!canSaveKeyMerge(tab.merge)) return { problem: "Resolve every conflict before saving the merged value." };
    return {
      changes: [{ kind: "setString", value: { text: tab.merge.text, hex: null }, original: tab.merge.snapshot.value }],
    };
  }
  const columns = tab.result?.columns.map((column) => column.name) ?? [];
  if (tab.recreating && tab.lostType !== null) {
    if (tab.lostType === "string" && tab.stringValue !== null)
      return { changes: [{ kind: "setString", value: tab.stringValue, original: null }] };
    const rows: Row[] = [];
    const count = tab.result?.rowCount ?? 0;
    for (let row = 0; row < count; row++) {
      const values = tab.result === null ? undefined : rowAt(tab.result.windows, row);
      if (values === undefined) return { problem: RECREATE_UNLOADED };
      rows.push(values);
    }
    if (tab.result !== null && !tab.result.complete) return { problem: RECREATE_UNLOADED };
    return recreateChanges(tab.lostType, columns, rows, tab.value);
  }
  const type = tab.details?.type ?? null;
  if (type === "string") {
    if (tab.stringValue === null) return { changes: [] };
    if (tab.leaseDraft != null && sameStringBytes(tab.value, tab.stringValue)) return { changes: [] };
    return stringChanges(tab.stringValue, tab.value);
  }
  if (type === null || tab.result === null) return { changes: [] };
  const result = tab.result;
  return keyChangesOf(type, columns, tab.buffer, (row) => rowAt(result.windows, row));
}

/** Rows touched, or one for a changed string or a pending Recreate. */
export function pendingKeyCount(tab: KeyTab): number {
  if (tab.leaseDraft != null && tab.leaseDraft.kind !== "preserve") return Math.max(1, pendingCount(tab.buffer));
  if (tab.merge != null) return 1;
  if (tab.stringProblem != null) return 1;
  if (tab.recreating) return 1;
  if (tab.stringValue !== null) return 1;
  return pendingCount(tab.buffer);
}

export function createKeyTabsStore(dependencies: KeyTabsDependencies) {
  const clients = new Map<string, EngineClient>();
  const historyRequests = new Map<string, symbol>();
  const lifetimes = new Map<string, symbol>();
  const noticeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const clock = dependencies.clock ?? (() => Date.now());
  const executions = dependencies.executions ?? NO_EXECUTION_REPORTER;
  let resultIds = 0;

  return create<KeyTabsState>()((set, get) => {
    const windows = createResultWindows({
      client: (id) => clients.get(id),
      result: (id, resultId) => resultOf(id, resultId),
      update: (id, resultId, change) => updateResult(id, resultId, change),
      failed: (id, _result, error) => patch(id, { error }),
      fetched: () => undefined,
      datasourceOf: (id) => get().tabs[id]?.datasourceId,
      exports: dependencies.exports ?? NO_EXPORTS,
    });

    function patch(id: string, change: Partial<KeyTab>): void {
      const current = get().tabs[id];
      if (current === undefined) return;
      set({ tabs: { ...get().tabs, [id]: { ...current, ...change } } });
    }

    function stepMergeConflict(id: string, step: number): void {
      const merge = get().tabs[id]?.merge;
      const count = merge?.merged.conflicts.length ?? 0;
      if (merge != null && count > 0)
        patch(id, { merge: { ...merge, conflictIndex: (merge.conflictIndex + step + count) % count } });
    }

    function clearNoticeTimer(id: string): void {
      clearTimeout(noticeTimers.get(id));
      noticeTimers.delete(id);
    }

    function savedNotice(id: string, before: KeyTab): void {
      clearNoticeTimer(id);
      const notice = savedNoticeText(before);
      patch(id, { notice });
      noticeTimers.set(
        id,
        setTimeout(() => {
          noticeTimers.delete(id);
          if (get().tabs[id]?.notice === notice) patch(id, { notice: null });
        }, KEY_SAVED_NOTICE_MS),
      );
    }

    function applyOptions(tab: KeyTab, guard = true): KeyApplyOptions {
      const revision = tab.merge != null ? tab.merge.snapshot.revision : tab.details?.revision;
      const revisionAware = tab.revisionGuardAvailable === true || tab.merge != null;
      return {
        type: typeOf(tab),
        guard: revisionAware ? true : guard,
        ...(revisionAware ? { revisionGuard: { modRevision: revision?.modRevision ?? "0" } } : {}),
        ...(tab.leaseAssignmentAvailable === true && tab.leaseDraft != null ? { lease: tab.leaseDraft } : {}),
      };
    }

    function resultOf(id: string, resultId: string): ResultTab | undefined {
      const result = get().tabs[id]?.result;
      return result?.id === resultId ? result : undefined;
    }

    function updateResult(id: string, resultId: string, change: (result: ResultTab) => ResultTab): void {
      const result = resultOf(id, resultId);
      if (result !== undefined) patch(id, { result: change(result) });
    }

    async function openSession(id: string): Promise<boolean> {
      const current = get().tabs[id];
      if (current === undefined) return false;
      const lifetime = lifetimes.get(id);
      patch(id, { status: "connecting", error: null });
      try {
        const client = await dependencies.connect(current.datasourceId);
        const opened = await client.call("session.open", {});
        if (lifetimes.get(id) !== lifetime) {
          void client.call("session.close", { sessionId: opened.sessionId }).catch(() => undefined);
          return false;
        }
        clients.set(id, client);
        patch(id, { sessionId: opened.sessionId, status: "ready", error: null });
        return true;
      } catch (cause) {
        if (lifetimes.get(id) === lifetime) patch(id, { status: "failed", error: toError(cause) });
        return false;
      }
    }

    function settled(id: string): KeyTabStatus {
      const status = get().tabs[id]?.status;
      return status === "disconnected" || status === "failed" ? status : "ready";
    }

    function editableTab(id: string): KeyTab | null {
      const current = get().tabs[id];
      const readOnly = current === undefined ? false : (dependencies.readOnly?.(current.datasourceId) ?? false);
      return isKeyEditable(current, readOnly) ? current : null;
    }

    function editBuffer(id: string, change: (target: EditTarget) => EditBuffer): void {
      const current = editableTab(id);
      if (current === null || current.result === null) return;
      const buffer = change(keyEditTarget(current));
      if (buffer !== current.buffer) {
        patch(id, { buffer, notice: null, result: clampedTo(current.result, buffer) });
      }
    }

    function release(id: string, result: ResultTab | null): void {
      if (result === null) return;
      windows.forget(result.id);
      const client = clients.get(id);
      if (!result.stale) void client?.call("result.release", { handle: result.handle }).catch(() => undefined);
    }

    async function read(id: string, draft: KeyRangeDraft): Promise<boolean> {
      const before = get().tabs[id];
      if (before === undefined || !canReloadKey(before.status)) return false;
      if (before.status !== "ready" && !(await openSession(id))) return false;
      const current = get().tabs[id];
      const client = clients.get(id);
      if (current?.sessionId == null || client === undefined) return false;
      const lifetime = lifetimes.get(id);
      const live = () => lifetimes.get(id) === lifetime && get().tabs[id]?.sessionId === current.sessionId;
      historyRequests.delete(id);
      clearNoticeTimer(id);
      patch(id, {
        status: "loading",
        error: null,
        notice: null,
        draft,
        history: { ...EMPTY_KEY_HISTORY, mode: current.history?.mode ?? "value" },
      });
      const executionId = executions.start(id, { label: LOAD_LABEL, sql: current.key.text, startedAt: clock() });
      const begun = clock();
      try {
        const paging = currentPaging();
        const timeoutSeconds = dependencies.statementTimeout?.(current.datasourceId) ?? 0;
        const answer = await client.call("keyspace.open", {
          sessionId: current.sessionId,
          database: current.database,
          key: current.key,
          range: keyRangeOf(current.details?.type ?? null, draft),
          ...paging,
          ...(timeoutSeconds > 0 ? { timeoutSeconds } : {}),
        });
        const discovery = await client.call("keyspace.databases", {});
        const features = discovery?.features;
        const rowCount = answer.statement?.rowCount ?? null;
        executions.finish(id, executionId, {
          outcome: "success",
          rowCount,
          message: null,
          durationMs: Math.max(0, clock() - begun),
        });
        const latest = get().tabs[id];
        if (latest === undefined || !live()) {
          if (answer.statement !== null) {
            void client.call("result.release", { handle: answer.statement.handle }).catch(() => undefined);
          }
          return false;
        }
        const previous = latest.result;
        const lostType = answer.details.type === null ? (latest.details?.type ?? latest.lostType) : null;
        if (lostType !== null) {
          // The rows read last stay, for Recreate to write back.
          patch(id, {
            details: answer.details,
            historyAvailable: features?.history === true,
            revisionGuardAvailable: features?.revisionGuard === true,
            leaseAssignmentAvailable: features?.leaseAssignment === true,
            readAt: clock(),
            lostType,
            ...NO_EDITS,
            queryError: null,
          });
          return true;
        }
        release(id, previous);
        let result: ResultTab | null = null;
        if (answer.statement !== null) {
          const fresh = resultTabOf(
            answer.statement,
            { id: `${id}/key-${String(++resultIds)}`, title: current.key.text },
            current.key.text,
            paging,
            currentFormats(),
          );
          const names = (columns: readonly { readonly name: string }[]) => columns.map((column) => column.name);
          const layout =
            previous === null
              ? fresh.layout
              : carriedLayout(previous.layout, names(previous.columns), names(fresh.columns));
          result = { ...fresh, layout };
        }
        patch(id, {
          details: answer.details,
          historyAvailable: features?.history === true,
          revisionGuardAvailable: features?.revisionGuard === true,
          leaseAssignmentAvailable: features?.leaseAssignment === true,
          readAt: clock(),
          value: answer.value,
          readOnly: readOnlyReason(features?.revisionGuard === true, answer.value, answer.readOnly),
          result,
          applied: draft,
          draft,
          queryError: null,
          ...NO_EDITS,
          lostType: null,
          readOnlyColumns: keyReadOnlyColumns(answer.details.type, result?.columns.map((column) => column.name) ?? []),
        });
        return true;
      } catch (cause) {
        const error = toError(cause);
        executions.finish(id, executionId, {
          outcome: error.code === "cancelled" ? "cancelled" : "error",
          rowCount: null,
          message: error.message,
          durationMs: Math.max(0, clock() - begun),
        });
        if (live()) {
          if (error.code === "statementFailed") patch(id, { queryError: error });
          else patch(id, { error });
        }
        return false;
      } finally {
        if (live()) {
          patch(id, { status: settled(id) });
          if (get().tabs[id]?.history?.mode === "history") void get().loadHistory(id);
        }
      }
    }

    return {
      tabs: {},

      setLease(id, lease) {
        const tab = editableTab(id);
        if (tab === null || tab.leaseAssignmentAvailable !== true || tab.revisionGuardAvailable !== true) return;
        if (lease.kind === "attach" && !/^-?[1-9]\d{0,19}$/.test(lease.leaseId)) return;
        patch(id, { leaseDraft: lease.kind === "preserve" ? null : lease, notice: null });
      },

      async open(id, target, options = {}) {
        clearNoticeTimer(id);
        lifetimes.set(id, Symbol());
        set({ tabs: { ...get().tabs, [id]: newTab(target) } });
        if (options.connect ?? true) await read(id, EMPTY_RANGE);
      },

      close(id) {
        clearNoticeTimer(id);
        lifetimes.delete(id);
        historyRequests.delete(id);
        const closing = get().tabs[id];
        if (closing === undefined) return;
        const { [id]: _closed, ...rest } = get().tabs;
        set({ tabs: rest });
        if (closing.result !== null) windows.forget(closing.result.id);
        const client = clients.get(id);
        clients.delete(id);
        if (closing.sessionId === null || client === undefined) return;
        void client.call("session.close", { sessionId: closing.sessionId }).catch(() => undefined);
      },

      detach(datasourceId, error) {
        for (const [id, tab] of Object.entries(get().tabs)) {
          if (tab.datasourceId !== datasourceId) continue;
          lifetimes.set(id, Symbol());
          historyRequests.delete(id);
          clients.delete(id);
          if (tab.result !== null) windows.invalidate(tab.result.id);
          patch(id, {
            sessionId: null,
            status: error === null ? "disconnected" : "failed",
            error: error ?? tab.error,
            result: tab.result === null ? null : { ...tab.result, stale: true, cursorOpen: false, fetching: null },
            history: { ...(tab.history ?? EMPTY_KEY_HISTORY), loading: false },
          });
        }
      },

      reload: (id, range) => {
        const current = get().tabs[id];
        return current === undefined ? Promise.resolve(false) : read(id, range ?? current.draft);
      },

      setDraft(id, draft) {
        const current = get().tabs[id];
        if (current === undefined) return;
        const next = { ...current.draft, ...draft };
        if (next.match === current.draft.match && next.from === current.draft.from && next.to === current.draft.to) {
          return;
        }
        patch(id, { draft: next });
      },

      revertDraft(id) {
        const current = get().tabs[id];
        if (current !== undefined) patch(id, { draft: current.applied, queryError: null });
      },

      ensureWindow: windows.ensureWindow,
      fetchMore: windows.fetchMore,
      stopFetch: windows.stopFetch,

      async sort(id, resultId, keys) {
        const result = resultOf(id, resultId);
        const client = clients.get(id);
        // Sorting is the engine's (decision 009); a closed connection's rows keep their order.
        if (result === undefined || client === undefined || result.stale) return;
        try {
          const state = await client.call("result.sort", { handle: result.handle, keys: [...keys] });
          windows.invalidate(resultId);
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
          patch(id, { error: toError(cause) });
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

      search: windows.search,
      findNext: windows.findNext,

      select(id, resultId, selection) {
        updateResult(id, resultId, (latest) => (latest.selection === selection ? latest : { ...latest, selection }));
      },

      extract: windows.extract,
      aggregate: windows.aggregate,
      cellBytes: windows.cellBytes,
      saveBytes: windows.saveBytes,
      loadBytes: windows.loadBytes,

      async exportTo(...args) {
        return (await windows.exportTo(...args)) !== null;
      },

      beginEdit(id, cell, text) {
        const current = editableTab(id);
        const editing = current === null ? null : editorAt(keyEditTarget(current), cell, text);
        if (editing !== null) patch(id, { editing });
      },

      changeEdit(id, text) {
        const editing = get().tabs[id]?.editing;
        if (editing != null && editing.text !== text) patch(id, { editing: { ...editing, text } });
      },

      commitEdit(id) {
        const editing = get().tabs[id]?.editing;
        if (editing == null) return false;
        patch(id, { editing: null });
        if (editing.text !== editing.initial) get().setCells(id, [editing], { kind: "text", text: editing.text });
        return true;
      },

      cancelEdit(id) {
        if (get().tabs[id]?.editing != null) patch(id, { editing: null });
      },

      editPanel(id, cell, text) {
        const current = get().tabs[id];
        if (current === undefined) return;
        if (cell === null) {
          if (current.panel !== null) patch(id, { panel: null });
          return;
        }
        const target = keyEditTarget(current);
        if (editableTab(id) === null || !canEditCell(target, cell)) return;
        const same = current.panel?.row === cell.row && current.panel.column === cell.column;
        const initial = same ? current.panel.initial : editCellText(target, cell);
        patch(id, { panel: { row: cell.row, column: cell.column, text: text ?? initial, initial } });
      },

      applyPanel(id) {
        const panel = get().tabs[id]?.panel;
        if (panel == null) return false;
        patch(id, { panel: null });
        if (panel.text !== panel.initial) get().setCells(id, [panel], { kind: "text", text: panel.text });
        return true;
      },

      setCells: (id, cells, input) => editBuffer(id, (target) => withCells(target, cells, input)),
      addRow: (id) => editBuffer(id, withAddedRow),
      duplicateRows: (id, rows) => editBuffer(id, (target) => withDuplicates(target, rows)),
      deleteRows: (id, rows) => editBuffer(id, (target) => withDeletes(target, rows)),
      revert: (id, cells) => editBuffer(id, (target) => withReverted(target, cells)),

      revertAll(id) {
        const tab = get().tabs[id];
        if (tab !== undefined)
          patch(id, { ...NO_EDITS, notice: null, editorGeneration: (tab.editorGeneration ?? 0) + 1 });
      },

      setStringValue(id, value) {
        if (editableTab(id) !== null) patch(id, { stringValue: value, stringProblem: null, notice: null, merge: null });
      },

      setStringProblem(id, problem) {
        if (editableTab(id) !== null) patch(id, { stringProblem: problem, notice: null });
      },

      editMerge(id, text) {
        const merge = get().tabs[id]?.merge;
        if (merge != null && editableTab(id) !== null && !merge.binary)
          patch(id, { merge: { ...merge, text, manual: true, acknowledged: false } });
      },

      chooseMerge(id, path, side) {
        const merge = get().tabs[id]?.merge;
        if (merge == null || editableTab(id) === null || merge.binary || merge.manual) return;
        if (merge.snapshot.value === null) {
          if (side === "yours") patch(id, { merge: { ...merge, acknowledged: true } });
          else get().discardMerge(id);
          return;
        }
        const choices = { ...merge.choices, [path]: side };
        const merged = mergeKeyText(merge.base, merge.snapshot.value.text, merge.yours, choices);
        patch(id, { merge: { ...merge, choices, merged, text: merged.text, conflictIndex: 0 } });
      },

      acknowledgeMerge(id) {
        const merge = get().tabs[id]?.merge;
        if (merge != null && editableTab(id) !== null && !merge.binary)
          patch(id, { merge: { ...merge, acknowledged: true } });
      },

      nextMergeConflict(id) {
        stepMergeConflict(id, 1);
      },

      previousMergeConflict(id) {
        stepMergeConflict(id, -1);
      },

      cancelMerge(id) {
        const tab = get().tabs[id];
        const merge = tab?.merge;
        if (merge != null && tab?.status === "ready")
          patch(id, {
            merge: { ...merge, visible: false },
            stringValue: merge.binary ? tab.stringValue : { text: merge.text, hex: null },
            editorGeneration: (tab.editorGeneration ?? 0) + 1,
          });
      },

      discardMerge(id) {
        if (editableTab(id) === null) return;
        get().revertAll(id);
        void get().reload(id);
      },

      async saveMerge(id) {
        const merge = get().tabs[id]?.merge;
        if (merge == null || !canSaveKeyMerge(merge) || editableTab(id) === null) return false;
        return get().submit(id);
      },

      historyMode(id, mode) {
        const tab = get().tabs[id];
        if (tab === undefined || !tab.historyAvailable || tab.merge?.visible === true) return;
        patch(id, { history: { ...(tab.history ?? EMPTY_KEY_HISTORY), mode } });
        if (mode === "history" && tab.history?.page == null) void get().loadHistory(id);
      },

      async loadHistory(id) {
        const tab = get().tabs[id];
        const client = clients.get(id);
        const history = tab?.history ?? EMPTY_KEY_HISTORY;
        if (
          tab === undefined ||
          !tab.historyAvailable ||
          client === undefined ||
          tab.status !== "ready" ||
          history.loading
        )
          return;
        if (history.page !== null && history.page.cursor === null) return;
        const request = Symbol();
        historyRequests.set(id, request);
        patch(id, { history: { ...history, loading: true, error: null } });
        try {
          const page = await client.call("keyspace.history", {
            database: tab.database,
            key: tab.key,
            cursor: history.page?.cursor ?? null,
            count: HISTORY_COUNT,
            maxBytes: HISTORY_BYTES,
            timeoutMs: HISTORY_TIMEOUT_MS,
          });
          if (historyRequests.get(id) !== request || get().tabs[id]?.sessionId !== tab.sessionId) return;
          const latest = get().tabs[id]?.history ?? history;
          const events = appendHistory(history.events, page.events);
          const gaps = [...(history.page?.gaps ?? []), ...page.gaps].filter(
            (gap, index, all) =>
              all.findIndex(
                (candidate) => candidate.fromRevision === gap.fromRevision && candidate.toRevision === gap.toRevision,
              ) === index,
          );
          patch(id, {
            history: {
              ...latest,
              events,
              page: {
                ...page,
                gaps,
                unavailableThrough: page.unavailableThrough ?? history.page?.unavailableThrough ?? null,
              },
              selected: latest.selected ?? (events[0] === undefined ? null : historyEventId(events[0])),
              loading: false,
            },
          });
        } catch (cause) {
          if (historyRequests.get(id) !== request) return;
          const latest = get().tabs[id]?.history ?? history;
          patch(id, { history: { ...latest, loading: false, error: toError(cause) } });
        }
      },

      selectHistory(id, eventId) {
        const history = get().tabs[id]?.history;
        if (history?.events.some((event) => historyEventId(event) === eventId)) {
          patch(id, { history: { ...history, selected: eventId } });
        }
      },

      restoreHistory(id) {
        const tab = get().tabs[id];
        if (
          tab === undefined ||
          tab.status !== "ready" ||
          dependencies.readOnly?.(tab.datasourceId) === true ||
          tab.readOnly !== null ||
          !tab.historyAvailable ||
          !tab.revisionGuardAvailable ||
          pendingKeyCount(tab) > 0 ||
          tab.details === null ||
          (tab.details.type !== "string" && tab.details.type !== null)
        )
          return false;
        const event: KeyHistoryEvent | undefined = tab.history?.events.find(
          (candidate) => historyEventId(candidate) === tab.history?.selected,
        );
        if (
          event?.kind !== "PUT" ||
          event.value === null ||
          isKubernetesKeyValue(event.value) ||
          tab.history === undefined ||
          event.modRevision === tab.details.revision?.modRevision
        )
          return false;
        patch(id, {
          stringValue: event.value,
          leaseDraft: null,
          editorGeneration: (tab.editorGeneration ?? 0) + 1,
          ...(keyMissing(tab) ? { recreating: true, lostType: "string" } : {}),
          history: { ...tab.history, mode: "value" },
          notice: RESTORE_NOTICE,
        });
        return true;
      },

      recreate(id) {
        const current = get().tabs[id];
        if (current?.lostType != null && current.status === "ready") patch(id, { recreating: true, notice: null });
      },

      async preview(id) {
        const current = get().tabs[id];
        const client = clients.get(id);
        if (current === undefined || client === undefined) return null;
        const pending = pendingKeyChanges(current);
        if ("problem" in pending) {
          patch(id, { queryError: problemError(pending.problem) });
          return null;
        }
        const options = applyOptions(current);
        try {
          return await client.call("keyspace.preview", { key: current.key, changes: pending.changes, options });
        } catch (cause) {
          patch(id, { error: toError(cause) });
          return null;
        }
      },

      async submit(id, guard = true) {
        get().commitEdit(id);
        get().applyPanel(id);
        const current = get().tabs[id];
        const client = clients.get(id);
        if (
          current === undefined ||
          client === undefined ||
          current.status !== "ready" ||
          dependencies.readOnly?.(current.datasourceId) === true ||
          current.readOnly !== null
        )
          return false;
        if (current.merge != null && !current.merge.visible) {
          patch(id, { merge: { ...current.merge, visible: true } });
          return false;
        }
        const pending = pendingKeyChanges(current);
        if ("problem" in pending) {
          patch(id, { queryError: problemError(pending.problem) });
          return false;
        }
        if (pending.changes.length === 0 && (current.leaseDraft == null || current.leaseDraft.kind === "preserve"))
          return false;
        const lifetime = lifetimes.get(id);
        const live = () => lifetimes.get(id) === lifetime && get().tabs[id]?.sessionId === current.sessionId;
        clearNoticeTimer(id);
        patch(id, { status: "submitting", error: null, queryError: null, conflict: null, notice: null });
        const begun = clock();
        const executionId = executions.start(id, { label: SUBMIT_LABEL, sql: current.key.text, startedAt: begun });
        const finish = (outcome: "success" | "error", message: string | null) =>
          executions.finish(id, executionId, { outcome, rowCount: null, message, durationMs: clock() - begun });
        try {
          await client.call("keyspace.apply", {
            database: current.database,
            key: current.key,
            changes: pending.changes,
            options: applyOptions(current, guard),
          });
          finish("success", null);
          if (!live()) return false;
          patch(id, { status: settled(id), ...NO_EDITS, lostType: null });
          await read(id, current.applied);
          if (live()) savedNotice(id, current);
          return true;
        } catch (cause) {
          const error = toError(cause);
          finish("error", error.message);
          if (!live()) return false;
          const edited =
            current.merge == null
              ? (current.stringValue ??
                (current.recreating && current.lostType === "string" ? bytesOfValue(current.value) : null))
              : { text: current.merge.text, hex: null };
          const snapshot = error.keyConflict;
          if (
            error.code === "conflict" &&
            snapshot !== undefined &&
            pending.changes.length === 0 &&
            snapshot.database === current.database &&
            snapshot.key.text === current.key.text &&
            snapshot.key.hex === current.key.hex &&
            snapshot.value !== null &&
            current.details !== null
          ) {
            patch(id, {
              value:
                snapshot.value.hex === null
                  ? snapshot.value.text
                  : { kind: "bytes", preview: snapshot.value.hex, length: snapshot.value.hex.length / 2 },
              details: { ...current.details, ...(snapshot.revision === null ? {} : { revision: snapshot.revision }) },
              editorGeneration: (current.editorGeneration ?? 0) + 1,
              stringValue: null,
              conflict: error,
              notice: "The key changed. Review its current value and preview the pending lease change again.",
            });
            return false;
          }
          if (
            error.code === "conflict" &&
            snapshot !== undefined &&
            current.revisionGuardAvailable === true &&
            edited !== null &&
            snapshot.database === current.database &&
            snapshot.key.text === current.key.text &&
            snapshot.key.hex === current.key.hex
          ) {
            patch(id, {
              conflict: error,
              merge: beginKeyMerge(
                snapshot,
                current.recreating || current.value === null ? null : bytesOfValue(current.value),
                edited,
                current.merge,
              ),
            });
          } else patch(id, error.code === "conflict" ? { conflict: error } : { error });
          return false;
        } finally {
          if (live()) patch(id, { status: settled(id) });
        }
      },

      dismissConflict(id) {
        if (get().tabs[id]?.conflict != null) patch(id, { conflict: null });
      },
    };
  });
}

export type KeyTabsStore = ReturnType<typeof createKeyTabsStore>;

export const useKeyTabs = createKeyTabsStore({
  connect: (datasourceId) => useDatasources.getState().connect(datasourceId),
  exports: useExports.getState(),
  statementTimeout: (datasourceId) => statementTimeoutOf(datasourceById(useDatasources.getState(), datasourceId)),
  readOnly: (datasourceId) => datasourceById(useDatasources.getState(), datasourceId)?.readOnly === true,
  executions: {
    start: (tabId, start) => useExecutions.getState().start(tabId, start),
    finish: (tabId, executionId, end) => useExecutions.getState().finish(tabId, executionId, end),
    recount: (tabId, executionId, rowCount) => useExecutions.getState().recount(tabId, executionId, rowCount),
  },
});

/** The key tabs open on a datasource, by tab id. */
export function keyTabsOf(tabs: KeyTabsState["tabs"], datasourceId: string): readonly string[] {
  return Object.entries(tabs)
    .filter(([, tab]) => tab.datasourceId === datasourceId)
    .map(([id]) => id);
}
