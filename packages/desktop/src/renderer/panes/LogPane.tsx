import { useEffect, useMemo } from "react";
import { LOG_LEVELS, type LogLevel, type LogRecord } from "@table-craft/desktop/log/record.js";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { LOG_ACTION_IDS } from "@table-craft/desktop/renderer/actions/logActions.js";
import { INPUT_CLASS } from "@table-craft/desktop/renderer/dialogs/parts.js";
import { installLogSync, matches, scopesOf, useLogView } from "@table-craft/desktop/renderer/state/logView.js";
import { ActionButton } from "@table-craft/desktop/renderer/ui/ActionButton.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { Dropdown } from "@table-craft/desktop/renderer/ui/Dropdown.js";

const LEVEL_CLASS: Readonly<Record<LogLevel, string>> = {
  error: "text-danger",
  warn: "text-warning",
  info: "text-ink",
  debug: "text-ink-muted",
};

/** The level filter shows that level and everything more severe. */
const LEVEL_LABELS: Readonly<Record<LogLevel, string>> = {
  error: "Errors",
  warn: "Warnings and up",
  info: "Info and up",
  debug: "Everything",
};
const LEVEL_OPTIONS = LOG_LEVELS.map((level) => ({ value: level, label: LEVEL_LABELS[level] }));

const ALL_SCOPES = "";
const ENVELOPE_KEYS: ReadonlySet<string> = new Set(["ts", "level", "process", "scope", "msg"]);

const TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
  hour12: false,
});

function timeOf(record: LogRecord): string {
  const at = new Date(record.ts);
  return Number.isNaN(at.getTime()) ? record.ts : TIME_FORMAT.format(at);
}

/** The fields after the message, as `key=value`, the error reduced to its message. */
function fieldsText(record: LogRecord): string {
  return Object.entries(record)
    .filter(([key]) => !ENVELOPE_KEYS.has(key))
    .map(([key, value]) =>
      key === "err" && typeof value === "object" && value !== null && "message" in value
        ? `err=${String(value.message)}`
        : `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`,
    )
    .join(" ");
}

function Toolbar({ scopes }: { readonly scopes: readonly string[] }) {
  const filter = useLogView((state) => state.filter);
  const setFilter = useLogView((state) => state.setFilter);
  return (
    <div className="flex shrink-0 flex-col gap-1 border-b border-line px-pane-inset py-1">
      <input
        type="search"
        aria-label="Search log"
        placeholder="Search messages, errors and fields"
        className={cn(INPUT_CLASS, "w-full")}
        value={filter.text}
        onChange={(event) => setFilter({ text: event.target.value })}
      />
      <div className="flex min-w-0 items-center gap-1">
        <Dropdown
          label="Level"
          variant="field"
          className="flex-1"
          value={filter.level}
          options={LEVEL_OPTIONS}
          onChange={(chosen) => {
            const level = LOG_LEVELS.find((candidate) => candidate === chosen);
            if (level !== undefined) setFilter({ level });
          }}
        />
        <Dropdown
          label="Scope"
          variant="field"
          className="flex-1"
          value={filter.scope}
          options={[
            { value: ALL_SCOPES, label: "All scopes" },
            ...scopes.map((scope) => ({ value: scope, label: scope })),
          ]}
          onChange={(scope) => setFilter({ scope })}
        />
        {filter.requestId === null ? null : <span className="shrink-0 text-ink-muted">request {filter.requestId}</span>}
        <ActionButton actionId={LOG_ACTION_IDS.clearFilter} compact />
        <ActionButton actionId={LOG_ACTION_IDS.copyRecord} compact />
        <ActionButton actionId={LOG_ACTION_IDS.reveal} compact />
      </div>
    </div>
  );
}

/**
 * The Log tool window (plan 017 decision 11): the newest records first, read-only. A click
 * selects a record and shows it whole below the list.
 */
export function LogPane() {
  const records = useLogView((state) => state.records);
  const filter = useLogView((state) => state.filter);
  const selected = useLogView((state) => state.selected);
  const loaded = useLogView((state) => state.loaded);
  const error = useLogView((state) => state.error);
  const select = useLogView((state) => state.select);

  useEffect(() => {
    const stop = installLogSync();
    void useLogView.getState().load();
    return stop;
  }, []);

  const shown = useMemo(() => records.filter((record) => matches(record, filter)), [records, filter]);
  const scopes = useMemo(() => scopesOf(records), [records]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar scopes={scopes} />
      {error !== null ? (
        <div className="px-pane-inset py-gap text-danger">{error}</div>
      ) : !loaded ? (
        <div className="px-pane-inset py-gap text-ink-muted">Reading the log…</div>
      ) : shown.length === 0 ? (
        <div className="px-pane-inset py-gap text-ink-muted">No log records match.</div>
      ) : (
        <div
          role="log"
          aria-label="Log records"
          className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto font-editor text-editor"
        >
          {shown.map((record, index) => (
            <button
              type="button"
              key={`${record.ts}:${index}`}
              data-level={record.level}
              aria-pressed={record === selected}
              onClick={() => select(record === selected ? null : record)}
              onDoubleClick={() => void invoke(LOG_ACTION_IDS.copyRecord, { record })}
              title={`${record.process}/${record.scope} ${record.msg} ${fieldsText(record)}`}
              className="flex w-full min-w-0 items-baseline gap-gap px-pane-inset text-left leading-(--spacing-row) hover:bg-raised aria-pressed:bg-selection"
            >
              <span className="shrink-0 text-ink-muted">{timeOf(record)}</span>
              <span className={cn("w-10 shrink-0 uppercase", LEVEL_CLASS[record.level])}>{record.level}</span>
              <span className="min-w-0 flex-1 truncate">
                <span className={LEVEL_CLASS[record.level]}>{record.msg}</span>
                <span className="text-ink-muted">
                  {" "}
                  {record.process}/{record.scope} {fieldsText(record)}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
      {selected === null ? null : (
        <pre
          aria-label="Log record"
          className="max-h-1/2 shrink-0 overflow-auto border-t border-line px-pane-inset py-gap font-editor text-editor break-all whitespace-pre-wrap"
        >
          {JSON.stringify(selected, null, 2)}
        </pre>
      )}
    </div>
  );
}
