import { create } from "zustand";
import { enabled, LOG_READ_LIMIT, type LogLevel, type LogRecord } from "@table-craft/desktop/log/record.js";
import { bridge } from "@table-craft/desktop/renderer/bridge.js";
import { useLayout } from "@table-craft/desktop/renderer/state/layout.js";
import { AGENT_LOG_SCOPE } from "@table-craft/desktop/settings/mcp.js";

/** What the Log tool window shows (plan 017 decision 11); empty text and scope match everything. */
export interface LogFilter {
  /** The least severe level shown. */
  readonly level: LogLevel;
  readonly scope: string;
  readonly text: string;
  /** Set by Show in Log; only records about that engine request. */
  readonly requestId: number | null;
}

export const ALL_RECORDS: LogFilter = { level: "debug", scope: "", text: "", requestId: null };

/** Show Agent Log: what agents did, from connect to leave (plan 146). */
export const AGENT_RECORDS: LogFilter = { ...ALL_RECORDS, level: "info", scope: AGENT_LOG_SCOPE };

/** Where Show in Log points: the failed request when known, else the error's message. */
export interface LogTarget {
  readonly requestId: number | null;
  readonly message: string;
}

export function isAllRecords(filter: LogFilter): boolean {
  return (
    filter.level === ALL_RECORDS.level &&
    filter.scope === ALL_RECORDS.scope &&
    filter.text === ALL_RECORDS.text &&
    filter.requestId === ALL_RECORDS.requestId
  );
}

export function filterFor(target: LogTarget): LogFilter {
  return target.requestId === null
    ? { ...ALL_RECORDS, text: target.message }
    : { ...ALL_RECORDS, requestId: target.requestId };
}

export function matches(record: LogRecord, filter: LogFilter): boolean {
  if (!enabled(record.level, filter.level)) return false;
  if (filter.requestId !== null && record["requestId"] !== filter.requestId) return false;
  if (filter.scope !== "" && record.scope !== filter.scope) return false;
  const text = filter.text.trim().toLowerCase();
  return text === "" || searchText(record).toLowerCase().includes(text);
}

/** Every value as written, not JSON-escaped, so a quoted database message still matches itself. */
function searchText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value !== "object" || value === null) return "";
  return Object.values(value).map(searchText).join("\n");
}

/** Newest first, capped like the read, so a long session's tail stays bounded. */
export function prepended(records: readonly LogRecord[], appended: readonly LogRecord[]): readonly LogRecord[] {
  return [...[...appended].reverse(), ...records].slice(0, LOG_READ_LIMIT);
}

export function scopesOf(records: readonly LogRecord[]): readonly string[] {
  return [...new Set(records.map((record) => record.scope))].sort();
}

export interface LogViewState {
  /** Newest first. */
  readonly records: readonly LogRecord[];
  readonly filter: LogFilter;
  /** The record the details pane shows and Copy copies. */
  readonly selected: LogRecord | null;
  readonly loaded: boolean;
  readonly error: string | null;
  readonly load: () => Promise<void>;
  readonly append: (records: readonly LogRecord[]) => void;
  readonly setFilter: (change: Partial<LogFilter>) => void;
  readonly select: (record: LogRecord | null) => void;
  /** Opens the Log tool window on what is about `target`. */
  readonly showFor: (target: LogTarget) => Promise<void>;
  /** Opens the Log tool window on the agent records. */
  readonly showAgents: () => Promise<void>;
}

export const useLogView = create<LogViewState>()((set, get) => ({
  records: [],
  filter: ALL_RECORDS,
  selected: null,
  loaded: false,
  error: null,
  load: async () => {
    const answer = await bridge().logRead();
    if (answer.ok) set({ records: answer.value, loaded: true, error: null });
    else set({ loaded: true, error: answer.error.message });
  },
  append: (records) => {
    if (get().loaded) set({ records: prepended(get().records, records) });
  },
  setFilter: (change) => set({ filter: { ...get().filter, ...change } }),
  select: (record) => set({ selected: record }),
  showFor: async (target) => {
    set({ filter: filterFor(target) });
    useLayout.getState().show("log");
    await get().load();
  },
  showAgents: async () => {
    set({ filter: AGENT_RECORDS });
    useLayout.getState().show("log");
    await get().load();
  },
}));

/** Keeps the open view live; records arrive in batches from main. */
export function installLogSync(): () => void {
  return bridge().onLogAppended((records) => useLogView.getState().append(records));
}
