import * as Dialog from "@radix-ui/react-dialog";
import { SEGMENT, SEGMENT_GROUP } from "@table-craft/desktop/renderer/ui/Segmented.js";
import { useState } from "react";
import { Button, FieldRow, TextInput } from "@table-craft/desktop/renderer/dialogs/parts.js";
import {
  exportAnswer,
  steppedStatement,
  useModal,
  type ModalRequest,
} from "@table-craft/desktop/renderer/state/modal.js";

type ExportRequest = Extract<ModalRequest, { kind: "export" }>;

const FILE_FIELD_ID = "export-file";

/**
 * Export Data (decision 040): the format as a segmented choice, a checkbox per column and the
 * file. Export starts a background task; the dialog closes at once.
 */
export function ExportData({ request }: { readonly request: ExportRequest }) {
  const answer = useModal((state) => state.answer);
  const [format, setFormat] = useState(request.initialFormat);
  const [chosen, setChosen] = useState<ReadonlySet<number>>(() => new Set(request.chosen));
  const [path, setPath] = useState("");
  const [shownOnly, setShownOnly] = useState(request.rows !== undefined);

  const toggle = (index: number) => {
    const next = new Set(chosen);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    setChosen(next);
  };
  const choose = (next: string) => {
    setFormat(next);
    setPath((current) => (current.trim() === "" ? current : request.retarget(current, next)));
  };
  const browse = async () => {
    const picked = await request.browse(format, path);
    if (picked !== null) setPath(picked);
  };
  const columns = request.columns.map((_, index) => index).filter((index) => chosen.has(index));
  const ready = columns.length > 0 && path.trim() !== "";

  return (
    <form
      className="flex flex-col gap-gap p-gap"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) {
          answer(
            exportAnswer({ format, columns, path: path.trim(), ...(request.rows === undefined ? {} : { shownOnly }) }),
          );
        }
      }}
    >
      <Dialog.Title className="font-semibold">{request.title}</Dialog.Title>
      <p className="text-ink-muted" data-testid="export-note">
        {request.rows !== undefined && shownOnly ? request.rows.shownNote : request.note}
      </p>
      <div className="grid grid-cols-[max-content_1fr] gap-x-gap gap-y-cell">
        <FieldRow label="Format">
          <div
            role="radiogroup"
            aria-label="Format"
            className={SEGMENT_GROUP}
            onKeyDown={(event) => {
              const ids = request.formats.map((choice) => choice.id);
              const next = steppedStatement(ids, format, event.key);
              if (next === null) return;
              event.preventDefault();
              choose(next);
              event.currentTarget.querySelector<HTMLElement>(`[data-format="${next}"]`)?.focus();
            }}
          >
            {request.formats.map((choice) => (
              <button
                key={choice.id}
                type="button"
                role="radio"
                data-format={choice.id}
                aria-checked={choice.id === format}
                tabIndex={choice.id === format ? 0 : -1}
                className={SEGMENT}
                onClick={() => choose(choice.id)}
              >
                {choice.label}
              </button>
            ))}
          </div>
        </FieldRow>
        {request.rows === undefined ? null : (
          <FieldRow label="Rows">
            <div role="radiogroup" aria-label="Rows" className="flex flex-wrap gap-gap">
              {[
                { shown: true, label: request.rows.shownLabel },
                { shown: false, label: request.rows.wholeLabel },
              ].map((choice) => (
                <label key={choice.label} className="flex h-row items-center gap-cell">
                  <input
                    type="radio"
                    name="export-rows"
                    checked={shownOnly === choice.shown}
                    onChange={() => setShownOnly(choice.shown)}
                  />
                  {choice.label}
                </label>
              ))}
            </div>
          </FieldRow>
        )}
        <FieldRow label="Columns">
          <span className="text-ink-muted">
            {columns.length} of {request.columns.length}
          </span>
          <button type="button" className="text-accent" onClick={() => setChosen(new Set(request.columns.keys()))}>
            All
          </button>
          <button type="button" className="text-accent" onClick={() => setChosen(new Set())}>
            None
          </button>
        </FieldRow>
        <div />
        <ul
          aria-label="Columns"
          data-testid="export-columns"
          className="max-h-picker-list overflow-auto rounded border border-line bg-canvas p-cell"
        >
          {request.columns.map((name, index) => (
            <li key={`${String(index)}:${name}`}>
              <label className="flex h-row items-center gap-cell">
                <input type="checkbox" checked={chosen.has(index)} onChange={() => toggle(index)} />
                <span className="truncate">{name}</span>
              </label>
            </li>
          ))}
        </ul>
        <FieldRow label="File" htmlFor={FILE_FIELD_ID}>
          <TextInput
            id={FILE_FIELD_ID}
            data-testid="export-file"
            className="flex-1"
            value={path}
            placeholder="Choose a file"
            onChange={(event) => setPath(event.target.value)}
          />
          <Button onClick={() => void browse()}>Browse…</Button>
        </FieldRow>
      </div>
      <div className="flex justify-end gap-gap">
        <Button onClick={() => answer(null)}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={!ready}>
          Export
        </Button>
      </div>
    </form>
  );
}
