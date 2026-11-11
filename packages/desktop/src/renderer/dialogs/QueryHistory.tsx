import { useEffect, useState } from "react";
import { SEGMENT, SEGMENT_GROUP } from "@table-craft/desktop/renderer/ui/Segmented.js";
import type { HistoryStatement } from "@table-craft/desktop/preload/bridge.js";
import { firstLine, formatDuration, historyTime, rowsText } from "@table-craft/desktop/renderer/model/format.js";
import { toError } from "@table-craft/desktop/renderer/state/resultWindows.js";
import {
  HISTORY_CHOICES,
  pickerAnswer,
  useModal,
  type ModalRequest,
} from "@table-craft/desktop/renderer/state/modal.js";
import { ListPicker } from "@table-craft/desktop/renderer/ui/ListPicker.js";
import { OutcomeDot } from "@table-craft/desktop/renderer/ui/Outcome.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { PRESSED_TOGGLE } from "@table-craft/desktop/renderer/ui/pressClasses.js";
import { SqlView } from "@table-craft/desktop/renderer/ui/SqlView.js";
import { Tooltip } from "@table-craft/desktop/renderer/ui/Tooltip.js";

type HistoryRequest = Extract<ModalRequest, { kind: "history" }>;

interface Found {
  readonly query: string;
  readonly statements: readonly HistoryStatement[];
  readonly error: string | null;
}

const NO_STATEMENTS: readonly HistoryStatement[] = [];
const AGENT_LABEL = "Agent";
const AGENT_HINT = "Last run by an AI agent over MCP";

/** Who ran a statement last: the user from a console or table, or an MCP client (plan 117). */
const ORIGINS = ["all", "me", "agents"] as const;
type Origin = (typeof ORIGINS)[number];
const ORIGIN_LABELS: Readonly<Record<Origin, string>> = { all: "All", me: "Me", agents: "Agents" };

function fromOrigin(statement: HistoryStatement, origin: Origin): boolean {
  if (origin === "all") return true;
  return (statement.lastSource === "agent") === (origin === "agents");
}

function OriginFilter({ origin, onOrigin }: { readonly origin: Origin; readonly onOrigin: (next: Origin) => void }) {
  return (
    <div role="group" aria-label="Who ran it" className={SEGMENT_GROUP}>
      {ORIGINS.map((id) => (
        <button
          key={id}
          type="button"
          aria-pressed={id === origin}
          data-testid={`history-origin-${id}`}
          className={SEGMENT}
          onClick={() => onOrigin(id)}
        >
          {ORIGIN_LABELS[id]}
        </button>
      ))}
    </div>
  );
}

const FORMAT_HINT = "Show the statement laid out by the formatter; Copy and Insert keep it as it ran";

/** A view of the preview, not a filter of the list, so it sits on the preview as the value panel's `{}` does. */
function FormatToggle({ on, onToggle }: { readonly on: boolean; readonly onToggle: (next: boolean) => void }) {
  return (
    <Tooltip label={FORMAT_HINT} side="bottom">
      <button
        type="button"
        aria-pressed={on}
        data-testid="history-format"
        className={cn("ml-auto h-segment shrink-0 rounded px-cell text-ink hover:bg-hover", PRESSED_TOGGLE)}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onToggle(!on)}
      >
        Format
      </button>
    </Tooltip>
  );
}

interface Formatted {
  readonly sql: string;
  readonly text: string | null;
  readonly error: string | null;
}

/** The statement through `format` while `on`; null while it is off, absent or still working. */
function useFormatted(sql: string, format: HistoryRequest["format"], on: boolean): Formatted | null {
  const [formatted, setFormatted] = useState<Formatted | null>(null);
  useEffect(() => {
    let current = true;
    if (on && format !== undefined && sql !== "") {
      format(sql).then(
        (text) => {
          if (current) setFormatted({ sql, text, error: null });
        },
        (cause: unknown) => {
          if (current) setFormatted({ sql, text: null, error: toError(cause).message });
        },
      );
    }
    return () => {
      current = false;
    };
  }, [sql, format, on]);
  return on && formatted?.sql === sql ? formatted : null;
}

function Preview({
  statement,
  request,
  formatOn,
  onFormat,
}: {
  readonly statement: HistoryStatement | null;
  readonly request: HistoryRequest;
  readonly formatOn: boolean;
  readonly onFormat: (next: boolean) => void;
}) {
  const sql = statement?.sql ?? "";
  const formatted = useFormatted(sql, request.format, formatOn);
  return (
    <>
      {statement?.lastMessage == null ? null : (
        <p role="alert" data-testid="history-message" className="break-words text-danger">
          {statement.lastMessage}
        </p>
      )}
      {formatted?.error == null ? null : (
        <p role="alert" data-testid="history-format-error" className="break-words text-danger">
          Could not format the statement: {formatted.error}
        </p>
      )}
      <div className="flex h-picker-list flex-col overflow-hidden rounded border border-line bg-canvas">
        <div className="flex h-row-loose shrink-0 items-center gap-gap border-b border-line px-cell">
          <span className="text-ink-muted">Statement</span>
          {request.format === undefined ? null : <FormatToggle on={formatOn} onToggle={onFormat} />}
        </div>
        <SqlView
          text={formatted?.text ?? sql}
          highlight={request.highlight}
          label="Statement"
          testId="history-preview"
          className="flex-1"
        />
      </div>
    </>
  );
}

function Entry({ statement, now }: { readonly statement: HistoryStatement; readonly now: number }) {
  return (
    <>
      <OutcomeDot outcome={statement.lastOutcome} />
      <span className="min-w-0 flex-1 truncate font-editor text-editor">{firstLine(statement.sql)}</span>
      {statement.lastSource === "agent" ? (
        <span
          data-testid="history-agent"
          title={statement.lastClient === null ? AGENT_HINT : `${AGENT_HINT}: ${statement.lastClient}`}
          className="max-w-40 shrink-0 truncate rounded border border-line px-1 text-ink-muted"
        >
          {statement.lastClient ?? AGENT_LABEL}
        </span>
      ) : null}
      {statement.runs > 1 ? <span className="shrink-0 text-ink-muted tabular-nums">×{statement.runs}</span> : null}
      {statement.lastRowCount === null ? null : (
        <span className="shrink-0 text-ink-muted tabular-nums">{rowsText(statement.lastRowCount)}</span>
      )}
      <span className="shrink-0 text-ink-muted tabular-nums">{formatDuration(statement.lastDurationMs)}</span>
      <span className="shrink-0 text-ink-muted tabular-nums">{historyTime(statement.lastStartedAt, now)}</span>
    </>
  );
}

/** The Query History dialog's body (plan 011 decisions 8 and 9): search, the list, the statement whole. */
export function QueryHistory({ request }: { readonly request: HistoryRequest }) {
  const answer = useModal((state) => state.answer);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Found | null>(null);
  const [origin, setOrigin] = useState<Origin>("all");
  const [formatOn, setFormatOn] = useState(false);

  useEffect(() => {
    let current = true;
    request.search(query).then(
      (statements) => {
        if (current) setFound({ query, statements, error: null });
      },
      (cause: unknown) => {
        if (current) setFound({ query, statements: NO_STATEMENTS, error: toError(cause).message });
      },
    );
    return () => {
      current = false;
    };
  }, [request, query]);

  const statements = (found?.statements ?? NO_STATEMENTS).filter((statement) => fromOrigin(statement, origin));
  const choose = (choice: string) => (statement: HistoryStatement | null) => {
    if (statement !== null) answer(pickerAnswer(choice, statement.sql));
  };
  return (
    <>
      <ListPicker
        title={request.title}
        searchLabel="Search history"
        query={query}
        onQuery={setQuery}
        filters={<OriginFilter origin={origin} onOrigin={setOrigin} />}
        items={statements}
        keyOf={(statement) => statement.sql}
        labelOf={(statement) => firstLine(statement.sql)}
        renderItem={(statement) => <Entry statement={statement} now={request.now} />}
        empty={found === null ? "" : query === "" && origin === "all" ? "No statements yet." : "Nothing matches."}
        preview={(statement) => (
          <Preview statement={statement} request={request} formatOn={formatOn} onFormat={setFormatOn} />
        )}
        onChoose={(statement) => answer(pickerAnswer(HISTORY_CHOICES.restore, statement.sql))}
        buttons={[
          {
            label: "Clear History…",
            variant: "danger",
            always: true,
            onClick: () => answer(pickerAnswer(HISTORY_CHOICES.clear, "")),
          },
          { label: "Copy", onClick: choose(HISTORY_CHOICES.copy) },
          { label: request.restore, variant: "primary", onClick: choose(HISTORY_CHOICES.restore) },
        ]}
        onClose={() => answer(null)}
      />
      {found?.error == null ? null : (
        <p role="alert" className="px-gap pb-gap break-words text-danger">
          {found.error}
        </p>
      )}
    </>
  );
}
