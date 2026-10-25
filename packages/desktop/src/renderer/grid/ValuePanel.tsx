import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Column, WireValue } from "@table-craft/desktop/engine/protocol.js";
import { REGION_ATTRIBUTE } from "@table-craft/desktop/renderer/actions/context.js";
import { EDITOR_THEME } from "@table-craft/desktop/renderer/console/editorTheme.js";
import { NULL_TEXT, panelValue } from "@table-craft/desktop/renderer/grid/format.js";
import { Select } from "@table-craft/desktop/renderer/dialogs/parts.js";
import { prettyJson } from "@table-craft/desktop/renderer/model/prettyJson.js";
import {
  decodeValue,
  FORMAT_LABELS,
  VALUE_FORMATS,
  valueBytes,
  type DecodedValue,
  type ValueFormat,
} from "@table-craft/desktop/renderer/model/valueFormats.js";

const FORMAT_LABEL = "Format";
const FORMAT_OPTIONS = VALUE_FORMATS.map((format) => ({ value: format, label: FORMAT_LABELS[format] }));

/** How a key tab's value panel reads bytes (plan 058 decision 15); the console's and table's panels have none. */
export interface ValueFormatChoice {
  readonly format: ValueFormat;
  readonly onChange: (format: ValueFormat) => void;
}

function FormatPicker({ choice }: { readonly choice: ValueFormatChoice }) {
  return (
    <span className="ml-auto shrink-0">
      <Select
        label={FORMAT_LABEL}
        testId="value-format"
        value={choice.format}
        options={FORMAT_OPTIONS}
        onChange={(format) => {
          const picked = VALUE_FORMATS.find((candidate) => candidate === format);
          if (picked !== undefined) choice.onChange(picked);
        }}
      />
    </span>
  );
}

/** `bytes` decoded as `format`; gzip inflates asynchronously, so the first draw may be the previous text. */
function useDecoded(bytes: Uint8Array, format: ValueFormat): DecodedValue | null {
  const [decoded, setDecoded] = useState<DecodedValue | null>(null);
  useEffect(() => {
    let current = true;
    void decodeValue(bytes, format).then((next) => {
      if (current) setDecoded(next);
    });
    return () => {
      current = false;
    };
  }, [bytes, format]);
  return decoded;
}

function FormattedValue({ bytes, format }: { readonly bytes: Uint8Array; readonly format: ValueFormat }) {
  const decoded = useDecoded(bytes, format);
  if (decoded === null) return <p className="p-cell text-ink-muted">Decoding…</p>;
  const shownAs = decoded.inner === null ? FORMAT_LABELS[decoded.format] : `gzip → ${FORMAT_LABELS[decoded.inner]}`;
  const json =
    decoded.error === null && (decoded.format === "json" || decoded.inner === "json" || decoded.format === "msgpack");
  return (
    <div data-testid="value-formatted" data-format={decoded.format} className="flex min-h-0 flex-1 flex-col">
      <p className="shrink-0 px-cell pt-cell text-ink-muted">
        {format === "auto" ? `Auto: ${shownAs}` : shownAs}
        {decoded.error === null ? "" : ` · ${decoded.error}`}
      </p>
      {json ? (
        <JsonView text={decoded.text} />
      ) : (
        <pre
          data-testid="value-text"
          className="min-h-0 flex-1 overflow-auto p-cell break-words whitespace-pre-wrap text-ink select-text"
        >
          {decoded.text}
        </pre>
      )}
    </div>
  );
}

function JsonView({ text }: { readonly text: string }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  useEffect(() => {
    if (host.current === null) return;
    const created = new EditorView({
      parent: host.current,
      state: EditorState.create({
        extensions: [
          EDITOR_THEME,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.lineWrapping,
        ],
      }),
    });
    view.current = created;
    return () => {
      created.destroy();
      view.current = null;
    };
  }, []);
  useEffect(() => {
    const current = view.current;
    if (current === null) return;
    const doc = prettyJson(text);
    if (current.state.doc.toString() !== doc) {
      current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: doc } });
    }
  }, [text]);
  return <div ref={host} data-testid="value-json" className="min-h-0 flex-1 overflow-hidden" />;
}

function PanelHeader({ column, children }: { readonly column: Column | null; readonly children?: ReactNode }) {
  return (
    <div className="flex h-row shrink-0 items-center gap-gap border-b border-line px-cell text-ui">
      <span className="truncate text-ink">{column?.name ?? "Value"}</span>
      {column?.type == null ? null : <span className="truncate text-ink-muted">{column.type}</span>}
      {children}
    </div>
  );
}

const PANEL_CLASS = "flex w-value-panel min-w-0 shrink-0 flex-col border-l border-line bg-panel font-grid text-grid";

/**
 * The focused cell's value as an editor, in the table editor (plan 008 decision 10): text as typed,
 * JSON pretty-printed. Mount it per cell; `onChange` gets each edit, and ⌘↵ (`table.applyValue`)
 * writes it to the pending changes.
 */
export function ValueEditor({
  column,
  text,
  json,
  applyHint,
  onChange,
}: {
  readonly column: Column | null;
  readonly text: string;
  readonly json: boolean;
  /** The Apply shortcut, shown in the header. */
  readonly applyHint: string;
  readonly onChange: (text: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const changed = useRef(onChange);
  useEffect(() => {
    changed.current = onChange;
  });
  const initial = useRef(json ? prettyJson(text) : text);
  useEffect(() => {
    if (host.current === null) return;
    const created = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: initial.current,
        extensions: [
          EDITOR_THEME,
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ "aria-label": `Value of ${column?.name ?? "the cell"}` }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) changed.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    return () => created.destroy();
  }, [column?.name]);
  return (
    <aside aria-label="Value" {...{ [REGION_ATTRIBUTE]: "valuePanel" }} className={PANEL_CLASS}>
      <PanelHeader column={column}>
        <span className="ml-auto shrink-0 text-ink-muted">{applyHint} applies</span>
      </PanelHeader>
      <div ref={host} data-testid="value-editor" className="min-h-0 flex-1 overflow-hidden" />
    </aside>
  );
}

/**
 * The focused cell's whole value beside the rows (plan 007 decision 15). It sits outside the grid's
 * focus region, so ⌘C and ⌘A here copy and select its text, not cells.
 */
export function ValuePanel({
  column,
  value,
  format,
}: {
  readonly column: Column | null;
  /** `undefined` while the cell's window is loading, or with no cell focused. */
  readonly value: WireValue | undefined;
  readonly format?: ValueFormatChoice;
}) {
  const shown = value === undefined ? null : panelValue(value);
  const formatted = format !== undefined;
  // A fresh array per draw would re-run the decoding effect after each decode it causes.
  const bytes = useMemo(() => (formatted ? valueBytes(value) : null), [formatted, value]);
  return (
    <aside aria-label="Value" {...{ [REGION_ATTRIBUTE]: "valuePanel" }} className={PANEL_CLASS}>
      <PanelHeader column={column}>{format === undefined ? null : <FormatPicker choice={format} />}</PanelHeader>
      {bytes !== null && format !== undefined ? (
        <FormattedValue bytes={bytes} format={format.format} />
      ) : shown === null ? (
        <p className="p-cell text-ink-muted">{column === null ? "Select a cell to see its value." : "Loading…"}</p>
      ) : shown.kind === "null" ? (
        <p className="p-cell text-grid-null italic">{NULL_TEXT}</p>
      ) : shown.kind === "json" ? (
        <JsonView text={shown.text} />
      ) : shown.kind === "bytes" ? (
        <div className="min-h-0 flex-1 overflow-auto p-cell">
          <pre data-testid="value-bytes" className="whitespace-pre text-ink">
            {shown.hex}
          </pre>
          <p className="pt-gap text-ink-muted">{shown.note}</p>
        </div>
      ) : (
        <pre
          data-testid="value-text"
          className="min-h-0 flex-1 overflow-auto p-cell break-words whitespace-pre-wrap text-ink select-text"
        >
          {shown.text}
        </pre>
      )}
    </aside>
  );
}
