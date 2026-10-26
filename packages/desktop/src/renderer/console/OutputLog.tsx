import { useEffect, useRef } from "react";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { KEY_ACTION_IDS } from "@table-craft/desktop/renderer/actions/keyActions.js";
import type { OutputEntry, OutputTone } from "@table-craft/desktop/renderer/state/consoles.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";

const TONE_CLASS: Readonly<Record<OutputTone, string>> = {
  info: "text-ink",
  success: "text-ink",
  warning: "text-warning",
  error: "text-danger",
};

const TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const LINK_CLASS = "ml-gap text-accent hover:underline";

/** Show as Result and Open Key on a command's line (decision 119). */
function EntryLinks({ entry, datasourceId }: { readonly entry: OutputEntry; readonly datasourceId: string }) {
  const { key } = entry;
  return (
    <>
      {entry.result === undefined ? null : (
        <button
          type="button"
          data-testid="output-show-result"
          className={LINK_CLASS}
          onClick={() => invoke(KEY_ACTION_IDS.showReply, { entryId: entry.id })}
        >
          Show as Result
        </button>
      )}
      {key === undefined ? null : (
        <button
          type="button"
          data-testid="output-open-key"
          className={LINK_CLASS}
          onClick={() => invoke(KEY_ACTION_IDS.openFromResult, { datasourceId, database: key.database, key: key.key })}
        >
          Open Key {key.key.text}
        </button>
      )}
    </>
  );
}

/** The console's Output tab (plan 006 decision 11): one line per statement run, newest at the bottom. */
export function OutputLog({
  entries,
  datasourceId,
}: {
  readonly entries: readonly OutputEntry[];
  readonly datasourceId: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const last = entries[entries.length - 1]?.id;

  useEffect(() => {
    const element = scrollRef.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
  }, [last]);

  if (entries.length === 0) {
    return <div className="flex-1 p-gap text-ink-muted">Run a statement to see its result.</div>;
  }
  return (
    <div
      ref={scrollRef}
      role="log"
      aria-label="Output"
      className="min-h-0 flex-1 overflow-auto px-gap py-1 font-editor text-editor"
    >
      {entries.map((entry) => (
        <div key={entry.id} data-tone={entry.tone} className="flex items-baseline gap-gap leading-(--spacing-row)">
          <span className="shrink-0 text-ink-muted">[{TIME_FORMAT.format(entry.at)}]</span>
          {entry.sql === "" ? null : <span className="max-w-1/2 shrink-0 truncate text-ink-muted">{entry.sql}</span>}
          <span className={cn("min-w-0", TONE_CLASS[entry.tone])}>
            {entry.message}
            {entry.hint === null ? null : <span className="text-ink-muted"> {entry.hint}</span>}
            <EntryLinks entry={entry} datasourceId={datasourceId} />
          </span>
        </div>
      ))}
    </div>
  );
}
