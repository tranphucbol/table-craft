import { useEffect, type KeyboardEvent } from "react";
import type { ListedSession } from "@table-craft/desktop/engine/protocol.js";
import { READ_ONLY_REASON, SESSIONS_ACTION_IDS } from "@table-craft/desktop/renderer/actions/sessionsActions.js";
import { useConsoleDatasource } from "@table-craft/desktop/renderer/console/useConsoleDatasource.js";
import { Check, TextInput } from "@table-craft/desktop/renderer/dialogs/parts.js";
import {
  blockedByText,
  sessionDuration,
  sessionKey,
  sessionText,
  sessionTone,
  stateLabel,
  visibleSessions,
  type SessionTone,
} from "@table-craft/desktop/renderer/model/sessionsView.js";
import { pluginOf, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { selectedSession, useSessions } from "@table-craft/desktop/renderer/state/sessions.js";
import { useSettings } from "@table-craft/desktop/renderer/state/settings.js";
import { ActionButton } from "@table-craft/desktop/renderer/ui/ActionButton.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { SqlView } from "@table-craft/desktop/renderer/ui/SqlView.js";
import { tintFrame } from "@table-craft/desktop/renderer/ui/tint.js";

const QUERY_LABEL = "Session query";
const MS_PER_SECOND = 1_000;

const TONE_CLASS: Readonly<Record<SessionTone, string>> = {
  warning: "text-warning",
  danger: "text-danger",
};

interface Column {
  readonly title: string;
  readonly text: (session: ListedSession) => string;
  readonly numeric?: boolean;
}

/** The grid's columns (plan 045 decision 5). */
const COLUMNS: readonly Column[] = [
  { title: "PID", text: (session) => session.id, numeric: true },
  { title: "State", text: stateLabel },
  { title: "User", text: (session) => sessionText(session.user) },
  { title: "Database", text: (session) => sessionText(session.database) },
  { title: "Client", text: (session) => sessionText(session.client) },
  { title: "Application", text: (session) => sessionText(session.application) },
  { title: "Query time", text: (session) => sessionDuration(session.queryMs), numeric: true },
  { title: "Tx age", text: (session) => sessionDuration(session.transactionMs), numeric: true },
  { title: "Wait", text: (session) => sessionText(session.waitEvent) },
  { title: "Blocked by", text: blockedByText },
];

const STEP: Readonly<Record<string, number>> = { ArrowDown: 1, ArrowUp: -1 };

/** A data source's server sessions (plan 045): the filtered grid above the selected row's query and details. */
export function SessionsView({ sessionsId }: { readonly sessionsId: string }) {
  const tab = useSessions((state) => state.tabs[sessionsId]);
  const datasource = useConsoleDatasource(sessionsId);
  const plugin = useDatasources((state) => pluginOf(state.plugins, datasource?.pluginId ?? ""));
  const refreshSeconds = useSettings((state) => state.settings.console.sessionsRefreshSeconds);
  const autoRefresh = tab?.autoRefresh ?? false;

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => void useSessions.getState().refresh(sessionsId), refreshSeconds * MS_PER_SECOND);
    return () => clearInterval(timer);
  }, [autoRefresh, refreshSeconds, sessionsId]);

  if (tab === undefined) return null;
  const { setFilters, select } = useSessions.getState();
  const color = datasource?.color ?? null;
  const all = tab.listing?.sessions ?? [];
  const shown = visibleSessions(all, tab.filters);
  const selected = selectedSession(tab);
  const stopReason = datasource?.readOnly === true ? READ_ONLY_REASON : null;

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const step = STEP[event.key];
    if (step === undefined || shown.length === 0) return;
    event.preventDefault();
    const at = shown.findIndex((session) => sessionKey(session) === tab?.selected);
    const next = shown[Math.min(shown.length - 1, Math.max(0, at === -1 ? 0 : at + step))];
    if (next !== undefined) select(sessionsId, sessionKey(next));
  }

  return (
    <div
      data-testid="sessions-view"
      data-color={color ?? undefined}
      className={cn("flex min-h-0 flex-1 flex-col", tintFrame(color))}
    >
      <div className="flex h-tab shrink-0 items-center gap-gap border-b border-line bg-panel px-gap text-ink-muted">
        <ActionButton actionId={SESSIONS_ACTION_IDS.refresh} compact />
        <ActionButton actionId={SESSIONS_ACTION_IDS.autoRefresh} compact pressed={tab.autoRefresh} />
        <span className="mx-1 h-4 w-px shrink-0 bg-line" />
        <Check
          label="Hide idle"
          checked={tab.filters.hideIdle}
          onChange={(hideIdle) => setFilters(sessionsId, { hideIdle })}
        />
        <Check
          label="Hide system"
          checked={tab.filters.hideSystem}
          onChange={(hideSystem) => setFilters(sessionsId, { hideSystem })}
        />
        <Check
          label="Blocked only"
          checked={tab.filters.blockedOnly}
          onChange={(blockedOnly) => setFilters(sessionsId, { blockedOnly })}
        />
        <TextInput
          aria-label="Search sessions"
          placeholder="Search"
          className="max-w-column-max min-w-0 flex-1"
          value={tab.filters.search}
          onChange={(event) => setFilters(sessionsId, { search: event.target.value })}
        />
        <span data-testid="sessions-count" className="truncate">
          {tab.loading && tab.listing === null
            ? "Listing sessions…"
            : `${String(shown.length)} of ${String(all.length)} sessions`}
        </span>
        {datasource === undefined ? null : (
          <span className="ml-auto shrink-0">
            {datasource.name}
            {plugin === undefined ? "" : ` · ${plugin.name}`}
          </span>
        )}
      </div>
      {tab.error === null ? null : (
        <div
          role="alert"
          data-testid="sessions-error"
          className="shrink-0 border-b border-line bg-panel px-gap py-1 break-words text-danger"
        >
          {tab.error.message} <span className="text-ink-muted">{tab.error.hint}</span>
        </div>
      )}
      {(tab.listing?.notes ?? []).map((note) => (
        <div
          key={note}
          data-testid="sessions-note"
          className="shrink-0 border-b border-line bg-panel px-gap py-1 break-words text-warning"
        >
          {note}
        </div>
      ))}
      <div
        role="grid"
        aria-label="Sessions"
        tabIndex={0}
        data-testid="sessions-grid"
        className="min-h-0 flex-1 overflow-auto bg-canvas outline-none"
        onKeyDown={onKeyDown}
      >
        <table className="w-full border-collapse font-grid text-grid">
          <thead className="sticky top-0 bg-panel text-ink-muted">
            <tr className="h-row">
              {COLUMNS.map((column) => (
                <th key={column.title} className="px-cell text-left font-normal whitespace-nowrap">
                  {column.title}
                </th>
              ))}
              <th className="w-full px-cell text-left font-normal">Query</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((session) => {
              const key = sessionKey(session);
              const isSelected = key === tab.selected;
              const tone = sessionTone(session);
              return (
                <tr
                  key={key}
                  aria-selected={isSelected}
                  data-session={key}
                  data-tone={tone ?? undefined}
                  className={cn(
                    "h-row cursor-default hover:bg-raised",
                    tone !== null && TONE_CLASS[tone],
                    isSelected && "bg-grid-selection hover:bg-grid-selection",
                  )}
                  onMouseDown={() => select(sessionsId, key)}
                >
                  {COLUMNS.map((column) => (
                    <td
                      key={column.title}
                      className={cn("px-cell whitespace-nowrap", column.numeric === true && "text-right")}
                    >
                      {column.text(session)}
                      {column.title === "PID" && session.own ? <span className="ml-1 text-accent">you</span> : null}
                    </td>
                  ))}
                  <td className="max-w-0 truncate px-cell">{sessionText(session.query)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {tab.listing !== null && shown.length === 0 ? (
          <p className="p-gap text-ink-muted">No sessions match the filters.</p>
        ) : null}
      </div>
      <div className="flex h-2/5 min-h-0 shrink-0 flex-col border-t border-line">
        <div className="flex h-tab shrink-0 items-center gap-gap border-b border-line bg-panel px-gap text-ink-muted">
          <ActionButton actionId={SESSIONS_ACTION_IDS.openInConsole} compact />
          <ActionButton actionId={SESSIONS_ACTION_IDS.explain} compact />
          <ActionButton actionId={SESSIONS_ACTION_IDS.copySql} compact />
          <span className="mx-1 h-4 w-px shrink-0 bg-line" />
          <ActionButton actionId={SESSIONS_ACTION_IDS.cancel} reason={stopReason} />
          <ActionButton actionId={SESSIONS_ACTION_IDS.terminate} reason={stopReason} />
          <span data-testid="sessions-status" className="ml-auto truncate">
            {tab.status}
          </span>
        </div>
        <div className="flex min-h-0 flex-1">
          <SqlView
            text={selected?.query ?? ""}
            highlight={plugin?.highlight}
            label={QUERY_LABEL}
            testId="sessions-query"
            className="min-w-0 flex-1 bg-canvas"
          />
          <SessionDetails session={selected} />
        </div>
      </div>
    </div>
  );
}

function SessionDetails({ session }: { readonly session: ListedSession | null }) {
  if (session === null) {
    return (
      <p className="w-plan-details shrink-0 border-l border-line bg-panel p-gap text-ink-muted">Select a session.</p>
    );
  }
  const rows: readonly (readonly [string, string])[] = [
    ["PID", session.id],
    ...(session.instance === null ? [] : [["Instance", session.instance] as const]),
    ["State", sessionText(session.rawState)],
    ["User", sessionText(session.user)],
    ["Database", sessionText(session.database)],
    ["Client", sessionText(session.client)],
    ["Application", sessionText(session.application)],
    ["Query time", sessionDuration(session.queryMs)],
    ["Transaction age", sessionDuration(session.transactionMs)],
    ["Wait", sessionText(session.waitEvent)],
    ["Blocked by", blockedByText(session)],
  ];
  return (
    <div
      data-testid="sessions-details"
      className="w-plan-details shrink-0 overflow-auto border-l border-line bg-panel p-gap"
    >
      {session.own ? <p className="pb-1 text-accent">One of TableCraft's own sessions.</p> : null}
      <dl className="grid grid-cols-[auto_1fr] gap-x-gap">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-ink-muted">{label}</dt>
            <dd className="truncate" title={value}>
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
