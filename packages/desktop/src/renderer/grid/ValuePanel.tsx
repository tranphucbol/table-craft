import { json as jsonLanguage } from "@codemirror/lang-json";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Column, WireValue } from "@table-craft/desktop/engine/protocol.js";
import { REGION_ATTRIBUTE } from "@table-craft/desktop/renderer/actions/context.js";
import { GRID_ACTION_IDS } from "@table-craft/desktop/renderer/actions/gridActions.js";
import { EDITOR_THEME } from "@table-craft/desktop/renderer/console/editorTheme.js";
import { BytesView } from "@table-craft/desktop/renderer/grid/BytesView.js";
import { NULL_TEXT, panelValue } from "@table-craft/desktop/renderer/grid/format.js";
import { Select } from "@table-craft/desktop/renderer/dialogs/parts.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { isBytesWire } from "@table-craft/desktop/renderer/model/binaryCells.js";
import { parsesAsJson, storedJson } from "@table-craft/desktop/renderer/model/jsonText.js";
import { prettyJson } from "@table-craft/desktop/renderer/model/prettyJson.js";
import {
  decodeValue,
  EDITABLE_FORMATS,
  FORMAT_LABELS,
  VALUE_FORMATS,
  valueBytes,
  type ConcreteFormat,
  type DecodedValue,
  type ValueFormat,
} from "@table-craft/desktop/renderer/model/valueFormats.js";
import { useJsonViewState } from "@table-craft/desktop/renderer/state/jsonView.js";
import { ActionButton } from "@table-craft/desktop/renderer/ui/ActionButton.js";

const FORMAT_LABEL = "Format";
const FORMAT_OPTIONS = VALUE_FORMATS.map((format) => ({ value: format, label: FORMAT_LABELS[format] }));
const JSON_HINT = "JSON · shown formatted, stored as is";
const INVALID_JSON_TEXT = "Not valid JSON — saved as typed";

/** How a key-value value panel reads bytes (plan 058 decision 15, decision 119); SQL panels have none. */
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
/** A decode with what it decoded, so a reader can tell a stale one from the current one. */
interface Decoded {
  readonly value: DecodedValue;
  readonly bytes: Uint8Array;
  readonly format: ValueFormat;
}

function useDecoded(bytes: Uint8Array, format: ValueFormat): Decoded | null {
  const [decoded, setDecoded] = useState<Decoded | null>(null);
  useEffect(() => {
    let current = true;
    void decodeValue(bytes, format).then((value) => {
      if (current) setDecoded({ value, bytes, format });
    });
    return () => {
      current = false;
    };
  }, [bytes, format]);
  return decoded;
}

/**
 * A string key's value edited in its format (plan 058 decision 15). The editor keeps its own text
 * once mounted, so the decoded text of each pending edit does not move the caret.
 */
export interface ValueTextEdit {
  /** Changes when the value is read again, remounting the editor on the new text. */
  readonly revision: string;
  readonly problem: string | null;
  readonly onChange: (text: string, format: ConcreteFormat) => void;
}

function FormattedValue({
  bytes,
  format,
  edit,
}: {
  readonly bytes: Uint8Array;
  readonly format: ValueFormat;
  readonly edit?: ValueTextEdit;
}) {
  const latest = useDecoded(bytes, format);
  const editorKey = edit === undefined ? null : `${edit.revision}:${format}`;
  const [mountedKey, setMountedKey] = useState(editorKey);
  const fresh = latest !== null && latest.bytes === bytes && latest.format === format;
  // The editor mounts on the text it is given, so a new read or format waits for its own decode:
  // mounting on the previous one showed the old value after a submit (found live, plan 060).
  if (editorKey !== mountedKey && fresh) setMountedKey(editorKey);
  if (latest === null || editorKey !== mountedKey) return <p className="p-cell text-ink-muted">Decoding…</p>;
  const decoded = latest.value;
  const shownAs = decoded.inner === null ? FORMAT_LABELS[decoded.format] : `gzip → ${FORMAT_LABELS[decoded.inner]}`;
  const json =
    decoded.error === null && (decoded.format === "json" || decoded.inner === "json" || decoded.format === "msgpack");
  const editable = edit !== undefined && decoded.error === null && EDITABLE_FORMATS.has(decoded.format);
  const problem = edit?.problem ?? null;
  return (
    <div data-testid="value-formatted" data-format={decoded.format} className="flex min-h-0 flex-1 flex-col">
      <p className="shrink-0 px-cell pt-cell text-ink-muted">
        {format === "auto" ? `Auto: ${shownAs}` : shownAs}
        {decoded.error === null ? "" : ` · ${decoded.error}`}
        {edit !== undefined && !editable && decoded.error === null ? " · read-only" : ""}
      </p>
      {problem === null ? null : (
        <p role="alert" data-testid="value-problem" className="shrink-0 px-cell text-danger">
          {problem}
        </p>
      )}
      {editable ? (
        <EditableText
          key={mountedKey}
          label="Value"
          text={decoded.text}
          onChange={(text) => edit.onChange(text, decoded.format)}
        />
      ) : json ? (
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
          jsonLanguage(),
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

function PanelHeader({
  column,
  json,
  children,
}: {
  readonly column: Column | null;
  /** Whether the JSON view shows, when `{}` is offered. */
  readonly json?: boolean;
  readonly children?: ReactNode;
}) {
  return (
    <div className="flex h-row shrink-0 items-center gap-gap border-b border-line px-cell text-ui">
      <span className="truncate text-ink">{column?.name ?? "Value"}</span>
      {column?.type == null ? null : <span className="truncate text-ink-muted">{column.type}</span>}
      {json === undefined ? null : (
        <span data-testid="value-json-toggle" data-on={json} className="ml-auto shrink-0">
          <ActionButton actionId={GRID_ACTION_IDS.toggleJsonView} compact pressed={json} />
        </span>
      )}
      {children}
    </div>
  );
}

function JsonHint() {
  return (
    <p data-testid="value-json-hint" className="shrink-0 px-cell pt-cell text-ink-muted">
      {JSON_HINT}
    </p>
  );
}

function RawText({ text }: { readonly text: string }) {
  return (
    <pre
      data-testid="value-text"
      className="min-h-0 flex-1 overflow-auto p-cell break-words whitespace-pre-wrap text-ink select-text"
    >
      {text}
    </pre>
  );
}

const PANEL_CLASS = "flex h-full w-full min-w-0 flex-col bg-panel font-grid text-grid";

/** Where a panel keeps its `{}` choice: the result's `jsonOwnerKey`; the column names the rest. */
function jsonTarget(owner: string | undefined, column: Column | null) {
  return owner === undefined || column === null ? undefined : { owner, column: column.name };
}

/**
 * The focused cell's value as an editor, in the table editor (plan 008 decision 10): text as typed,
 * JSON formatted while its view is on (plan 126 decision 9). Mount it per cell; `onChange` gets
 * each edit, and ⌘↵ (`table.applyValue`) writes it to the pending changes.
 */
export function ValueEditor({
  column,
  text,
  json,
  jsonOwner,
  applyHint,
  onChange,
}: {
  readonly column: Column | null;
  readonly text: string;
  /** The column is a declared JSON type. */
  readonly json: boolean;
  readonly jsonOwner?: string;
  /** The Apply shortcut, shown in the header. */
  readonly applyHint: string;
  readonly onChange: (text: string) => void;
}) {
  // Judged on the text at mount, so an edit that breaks the JSON does not switch the view mid-typing.
  const [initial] = useState(text);
  const target = jsonTarget(jsonOwner, column);
  const view = useJsonViewState(target, { text: initial, json });
  const invalid = view.on && text !== initial && !parsesAsJson(text);
  const toggle = target !== undefined && view.available ? view.on : undefined;
  return (
    <aside aria-label="Value" {...{ [REGION_ATTRIBUTE]: "valuePanel" }} className={PANEL_CLASS}>
      <PanelHeader column={column} json={toggle}>
        <span className={cn("shrink-0 text-ink-muted", toggle === undefined && "ml-auto")}>{applyHint} applies</span>
      </PanelHeader>
      {view.on ? <JsonHint /> : null}
      {invalid ? (
        <p role="alert" data-testid="value-json-invalid" className="shrink-0 px-cell text-warning">
          {INVALID_JSON_TEXT}
        </p>
      ) : null}
      <EditableText
        key={`${column?.name ?? ""}:${String(view.on)}`}
        label={`Value of ${column?.name ?? "the cell"}`}
        text={view.on ? prettyJson(text) : text}
        json={view.on}
        onChange={(edited) => onChange(view.on ? storedJson(edited, initial).text : edited)}
      />
    </aside>
  );
}

/** An editor over `text` as it was at mount; `onChange` gets each edit. */
function EditableText({
  label,
  text,
  json = false,
  onChange,
}: {
  readonly label: string;
  readonly text: string;
  /** Highlights the text as JSON; read at mount. */
  readonly json?: boolean;
  readonly onChange: (text: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const changed = useRef(onChange);
  useEffect(() => {
    changed.current = onChange;
  });
  const initial = useRef(text);
  const ariaLabel = useRef(label);
  const highlighted = useRef(json);
  useEffect(() => {
    if (host.current === null) return;
    const created = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: initial.current,
        extensions: [
          EDITOR_THEME,
          highlighted.current ? jsonLanguage() : [],
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ "aria-label": ariaLabel.current }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) changed.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    return () => created.destroy();
  }, []);
  return <div ref={host} data-testid="value-editor" className="min-h-0 flex-1 overflow-hidden" />;
}

/**
 * The focused cell's whole value beside the rows (plan 007 decision 15). It sits outside the grid's
 * focus region, so ⌘C and ⌘A here copy and select its text, not cells.
 */
export function ValuePanel({
  column,
  value,
  format,
  edit,
  jsonOwner,
}: {
  readonly column: Column | null;
  /** `undefined` while the cell's window is loading, or with no cell focused. */
  readonly value: WireValue | undefined;
  readonly format?: ValueFormatChoice;
  /** Makes the formatted value editable; only with `format`. */
  readonly edit?: ValueTextEdit;
  /** Offers `{}` and keeps its choice for this result (`jsonOwnerKey`); key-value panels have `format` instead. */
  readonly jsonOwner?: string;
}) {
  const shown = value === undefined ? null : panelValue(value);
  const formatted = format !== undefined;
  // A fresh array per draw would re-run the decoding effect after each decode it causes.
  const bytes = useMemo(() => (formatted ? valueBytes(value) : null), [formatted, value]);
  const target = formatted ? undefined : jsonTarget(jsonOwner, column);
  const text = !formatted && (shown?.kind === "json" || shown?.kind === "text") ? shown.text : null;
  const view = useJsonViewState(target, { text, json: shown?.kind === "json" });
  return (
    <aside aria-label="Value" {...{ [REGION_ATTRIBUTE]: "valuePanel" }} className={PANEL_CLASS}>
      <PanelHeader column={column} json={target !== undefined && view.available ? view.on : undefined}>
        {format === undefined ? null : <FormatPicker choice={format} />}
      </PanelHeader>
      {view.on ? <JsonHint /> : null}
      {bytes !== null && format !== undefined ? (
        <FormattedValue bytes={bytes} format={format.format} edit={edit} />
      ) : shown === null ? (
        <p className="p-cell text-ink-muted">{column === null ? "Select a cell to see its value." : "Loading…"}</p>
      ) : shown.kind === "null" ? (
        <p className="p-cell text-grid-null italic">{NULL_TEXT}</p>
      ) : shown.kind === "bytes" ? (
        isBytesWire(value) ? (
          <BytesView value={value} hex={shown.hex} note={shown.note} />
        ) : null
      ) : view.on ? (
        <JsonView text={shown.text} />
      ) : (
        <RawText text={shown.text} />
      )}
    </aside>
  );
}
