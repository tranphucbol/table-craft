import { useRef, useState } from "react";
import type { KeyBytes, KeyRange, KeyTask, KeyWatchWindow } from "@table-craft/desktop/engine/protocol.js";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { KEY_ACTION_IDS } from "@table-craft/desktop/renderer/actions/keyActions.js";
import { bytesLabel } from "@table-craft/desktop/renderer/keyAdmin/store.js";
import { permissionRange, rangeLabel } from "@table-craft/desktop/renderer/keyAdmin/AccessView.js";
import { BUTTON, INPUT } from "@table-craft/desktop/renderer/keyAdmin/controls.js";
import { Dropdown, type DropdownOption } from "@table-craft/desktop/renderer/ui/Dropdown.js";
import { WATCH_ACTION_IDS } from "./actions.js";
import { exportRunning, useWatch, type WatchEntry } from "./store.js";

const CELL = "h-row border-b border-line px-gap text-left whitespace-nowrap";
const WATCH_KIND_OPTIONS: readonly DropdownOption[] = [
  { value: "prefix", label: "Prefix" },
  { value: "key", label: "Key" },
  { value: "range", label: "Range" },
  { value: "all", label: "All keys" },
];

function WatchButton({
  id,
  kind,
  children,
  reason = null,
}: {
  readonly id: string;
  readonly reason?: string | null;
  readonly kind: "pause" | "clear" | "stop" | "close" | "export" | "exportCancel";
  readonly children: string;
}) {
  return (
    <button
      type="button"
      className={BUTTON}
      disabled={reason != null}
      title={reason ?? undefined}
      aria-pressed={kind === "pause" ? useWatch.getState().entries[id]?.paused : undefined}
      onClick={() => invoke(WATCH_ACTION_IDS.command, { id, kind })}
    >
      {children}
    </button>
  );
}
function WatchForm() {
  const [kind, setKind] = useState<KeyRange["kind"]>("prefix");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [revision, setRevision] = useState("");
  const [hex, setHex] = useState(false);
  let range: KeyRange = { kind: "all" };
  let error: string | null = null;
  try {
    range = permissionRange(kind, from, to, hex);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  if (revision !== "" && !/^[1-9]\d{0,19}$/.test(revision))
    error = "Enter a positive revision, or leave it empty for Now.";
  return (
    <form
      className="flex flex-wrap items-end gap-cell border-b border-line bg-panel p-cell"
      onSubmit={(event) => {
        event.preventDefault();
        if (error === null)
          invoke(WATCH_ACTION_IDS.start, {
            range,
            from: revision === "" ? { kind: "now" } : { kind: "revision", revision },
          });
      }}
    >
      <label className="flex flex-col gap-cell">
        Watch
        <Dropdown
          variant="field"
          label="Watch"
          value={kind}
          options={WATCH_KIND_OPTIONS}
          onChange={(value) => setKind(value as KeyRange["kind"])}
        />
      </label>
      {kind === "all" ? null : (
        <label className="flex min-w-0 flex-col gap-cell">
          {kind === "range" ? "From (inclusive)" : "Key or prefix"}
          <input className={INPUT} value={from} onChange={(event) => setFrom(event.target.value)} />
        </label>
      )}
      {kind === "range" ? (
        <label className="flex min-w-0 flex-col gap-cell">
          To (exclusive)
          <input className={INPUT} value={to} onChange={(event) => setTo(event.target.value)} />
        </label>
      ) : null}
      <label className="flex h-row items-center gap-cell">
        <input type="checkbox" checked={hex} onChange={(event) => setHex(event.target.checked)} />
        Hex
      </label>
      <label className="flex min-w-0 flex-col gap-cell">
        From revision (empty = Now)
        <input
          className={INPUT}
          inputMode="numeric"
          value={revision}
          onChange={(event) => setRevision(event.target.value)}
        />
      </label>
      <button type="submit" className={BUTTON} disabled={error !== null} title={error ?? undefined}>
        Start Watch
      </button>
      {error === null ? null : <span className="text-danger">{error}</span>}
    </form>
  );
}
/** The frozen export contract's own words (plan 110 watch export): what the file holds, and what it does not. */
export const WATCH_EXPORT_HINT =
  "Exports only the events this watch still retains, not its whole history or the current keys. Evicted events and gaps are recorded in the file's header; live watching continues.";
export function exportStatusText(task: KeyTask): string {
  if (task.state === "running") return `Exporting retained events · ${task.completed} of ${task.total ?? "unknown"}`;
  if (task.state === "completed") return `Saved ${task.total ?? task.completed} retained events as JSON Lines.`;
  if (task.state === "cancelled") return "Export cancelled. No file was saved.";
  if (task.outcome === "uncertain")
    return task.error ?? "The export's outcome is unknown. Check the destination folder.";
  return `Export failed: ${task.error ?? "unknown error"}. No file was saved.`;
}
function ExportStatus({ task }: { readonly task: KeyTask | undefined }) {
  if (task === undefined)
    return <p className="border-b border-line px-gap py-cell text-ink-muted">{WATCH_EXPORT_HINT}</p>;
  return (
    <p
      role={task.state === "failed" ? "alert" : "status"}
      className={`border-b border-line px-gap py-cell ${
        task.state === "failed" ? "text-danger" : task.state === "completed" ? "text-success" : "text-ink-muted"
      }`}
    >
      {exportStatusText(task)}
    </p>
  );
}
function valueLines(value: KeyBytes | null): readonly string[] {
  return value === null ? [] : bytesLabel(value).split("\n");
}
function Stream({ entry }: { readonly entry: WatchEntry }) {
  const id = entry.summary.watchId;
  const [puts, setPuts] = useState(true);
  const [deletes, setDeletes] = useState(true);
  const [contains, setContains] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<KeyWatchWindow["rows"] | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const rows = (anchor ?? entry.rows)
    .filter((row) => (row.event.kind === "PUT" ? puts : deletes) && bytesLabel(row.event.key).includes(contains))
    .reverse();
  const picked = (anchor ?? entry.rows).find((row) => row.sequence === selected)?.event;
  const newer = anchor === null ? 0n : BigInt(entry.cursor ?? "0") - BigInt(anchor.at(-1)?.sequence ?? "0");
  const exported = useWatch((state) => state.exports[id]);
  const rate = entry.rates.at(-1) ?? 0;
  const maxRate = Math.max(1, ...entry.rates);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        role="toolbar"
        aria-label="Watch controls"
        className="flex flex-wrap items-center gap-cell border-b border-line p-cell"
      >
        <WatchButton id={id} kind="pause">
          {entry.paused ? "Resume" : "Pause"}
        </WatchButton>
        <WatchButton id={id} kind="clear">
          Clear
        </WatchButton>
        <WatchButton id={id} kind="stop">
          Stop
        </WatchButton>
        {exportRunning(exported) ? (
          <WatchButton id={id} kind="exportCancel">
            Cancel Export
          </WatchButton>
        ) : (
          <WatchButton id={id} kind="export">
            Export Retained Events…
          </WatchButton>
        )}
        <label className="flex items-center gap-cell">
          <input type="checkbox" checked={puts} onChange={(event) => setPuts(event.target.checked)} />
          PUT
        </label>
        <label className="flex items-center gap-cell">
          <input type="checkbox" checked={deletes} onChange={(event) => setDeletes(event.target.checked)} />
          DELETE
        </label>
        <input
          className={INPUT}
          aria-label="Key contains (received events only)"
          placeholder="Key contains"
          value={contains}
          onChange={(event) => setContains(event.target.value)}
        />
      </div>
      <div className="flex flex-wrap items-center gap-gap border-b border-line px-gap py-cell text-ink-muted">
        <svg
          aria-label="Events per second over the last 60 samples"
          viewBox="0 0 60 14"
          className="h-icon w-16 fill-plan-bar"
        >
          {entry.rates.map((value, index) => (
            <rect key={index} x={index} y={14 - (value / maxRate) * 14} width={1} height={(value / maxRate) * 14} />
          ))}
        </svg>
        <span className={rate > 1000 ? "text-warning" : ""}>
          {Math.round(rate)}/s {rate > 1000 ? "· Narrow the prefix" : ""}
        </span>
        <span>
          {entry.retained.length} events · {entry.displayEvicted} older display events dropped ·{" "}
          {entry.summary.evictedEvents} engine retention evictions
        </span>
        <span className="ml-auto">
          {entry.paused ? `Paused · ${entry.pending} new (stream still running)` : entry.summary.state} · completed rev{" "}
          {entry.summary.completedRevision ?? "Unknown"}
        </span>
      </div>
      <ExportStatus task={exported} />
      {entry.summary.state === "reconnecting" ? (
        <p role="status" className="p-cell text-warning">
          Reconnecting from the last fully delivered revision. Any missing revisions will be reported, not hidden.
        </p>
      ) : null}
      {entry.summary.gap === null ? null : (
        <p role="alert" className="p-cell text-danger">
          Missing events: {entry.summary.gap.reason} · revisions {entry.summary.gap.fromRevision} to{" "}
          {entry.summary.gap.toRevision ?? "unknown"}. Stop and start a new watch from Now or an available revision.
        </p>
      )}
      {entry.error === null ? null : (
        <p role="alert" className="p-cell text-danger">
          {entry.error}
        </p>
      )}
      <div className="relative flex min-h-0 flex-1 flex-wrap overflow-hidden">
        <div
          ref={scroller}
          tabIndex={0}
          className="min-h-0 min-w-0 flex-1 overflow-auto"
          onScroll={(event) => {
            if (event.currentTarget.scrollTop > 0 && anchor === null) setAnchor(entry.rows);
            else if (event.currentTarget.scrollTop === 0 && anchor !== null) setAnchor(null);
          }}
        >
          <table role="grid" aria-label="Received watch events" className="w-full font-grid">
            <thead className="sticky top-0 bg-panel">
              <tr>
                {["Revision", "Type", "Key", "Version", "Bytes", "Lease"].map((label) => (
                  <th className={CELL} key={label}>
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ sequence, event }) => (
                <tr
                  key={sequence}
                  aria-selected={selected === sequence}
                  className={selected === sequence ? "bg-grid-selection" : "hover:bg-raised"}
                >
                  <td className={CELL}>
                    <button type="button" onClick={() => setSelected(sequence)}>
                      {event.revision.modRevision}
                    </button>
                  </td>
                  <td className={`${CELL} ${event.kind === "PUT" ? "text-success" : "text-danger"}`}>{event.kind}</td>
                  <td className={`${CELL} max-w-96 truncate`} title={bytesLabel(event.key)}>
                    <button type="button" onClick={() => setSelected(sequence)}>
                      {bytesLabel(event.key)}
                    </button>
                  </td>
                  <td className={CELL}>{event.revision.version}</td>
                  <td className={CELL}>
                    {event.value === null
                      ? "—"
                      : event.value.hex === null
                        ? new TextEncoder().encode(event.value.text).length
                        : event.value.hex.length / 2}
                  </td>
                  <td className={CELL}>{event.revision.lease === "0" ? "—" : event.revision.lease}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {newer <= 0n ? null : (
          <button
            type="button"
            className="absolute top-gap left-gap rounded bg-accent px-gap py-cell text-accent-ink"
            onClick={() => {
              setAnchor(null);
              scroller.current?.scrollTo({ top: 0 });
            }}
          >
            ↑ {String(newer)} new
          </button>
        )}
        {picked === undefined ? null : (
          <aside
            aria-label="Previous to new value"
            className="min-w-48 flex-1 overflow-auto border-l border-line bg-panel p-gap"
          >
            <div className="flex items-center justify-between gap-gap">
              <h3 className="font-semibold">
                {picked.kind === "DELETE" ? "Removed value" : picked.previous === null ? "Created" : "Previous → new"}
              </h3>
              <button
                type="button"
                className={BUTTON}
                onClick={() =>
                  invoke(KEY_ACTION_IDS.open, {
                    datasourceId: entry.datasourceId,
                    database: entry.summary.request.database,
                    key: picked.key,
                  })
                }
              >
                Open Key
              </button>
            </div>
            <pre className="mt-gap select-text font-grid whitespace-pre-wrap break-all">
              {valueLines(picked.previous?.value ?? null).map((line, index) => (
                <div key={`old-${index}`} className="bg-edit-deleted">
                  − {line}
                </div>
              ))}
              {valueLines(picked.value).map((line, index) => (
                <div key={`new-${index}`} className="bg-edit-inserted">
                  + {line}
                </div>
              ))}
            </pre>
          </aside>
        )}
      </div>
    </div>
  );
}
export function WatchPane() {
  const entries = useWatch((state) => state.entries);
  const activeId = useWatch((state) => state.activeId);
  const [form, setForm] = useState(false);
  const entry = activeId === null ? undefined : entries[activeId];
  return (
    <section data-region="watch" aria-label="Watch" className="flex h-full min-h-0 flex-col overflow-auto text-ui">
      <div role="tablist" aria-label="Watches" className="flex shrink-0 overflow-x-auto border-b border-line bg-panel">
        {Object.values(entries).map((item) => (
          <div key={item.summary.watchId} className="flex shrink-0 items-center border-r border-line">
            <button
              type="button"
              role="tab"
              aria-selected={item.summary.watchId === activeId}
              className="h-row px-gap aria-selected:bg-selection"
              onClick={() => invoke(WATCH_ACTION_IDS.command, { id: item.summary.watchId, kind: "select" })}
            >
              {rangeLabel(item.summary.request.range)} · {item.summary.state}
            </button>
            <button
              type="button"
              className="px-cell"
              aria-label={`Close watch ${rangeLabel(item.summary.request.range)}`}
              onClick={() => invoke(WATCH_ACTION_IDS.command, { id: item.summary.watchId, kind: "close" })}
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          aria-label="New watch"
          aria-expanded={form}
          className="h-row px-gap"
          onClick={() => setForm(!form)}
        >
          +
        </button>
      </div>
      {form || entry === undefined ? <WatchForm /> : null}
      {entry === undefined ? (
        <p className="p-gap text-ink-muted">
          Watch a key, prefix or byte range. Watching is read-only; hiding this window does not stop a watch.
        </p>
      ) : (
        <Stream key={entry.summary.watchId} entry={entry} />
      )}
    </section>
  );
}
