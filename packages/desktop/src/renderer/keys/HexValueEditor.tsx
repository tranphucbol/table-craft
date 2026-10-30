import { useState } from "react";
import { Select } from "@table-craft/desktop/renderer/dialogs/parts.js";
import {
  encodeValue,
  hexRows,
  FORMAT_LABELS,
  VALUE_FORMATS,
  type ValueFormat,
} from "@table-craft/desktop/renderer/model/valueFormats.js";

const FORMAT_OPTIONS = VALUE_FORMATS.map((format) => ({ value: format, label: FORMAT_LABELS[format] }));

export function HexValueEditor({
  bytes,
  format,
  editable,
  onFormat,
  onChange,
}: {
  readonly bytes: Uint8Array;
  readonly format: ValueFormat;
  readonly editable: boolean;
  readonly onFormat: (format: ValueFormat) => void;
  readonly onChange: (text: string) => void;
}) {
  const [draft, setDraft] = useState(() =>
    hexRows(bytes)
      .map((row) => row.hex)
      .join("\n"),
  );
  const encoded = encodeValue(draft, "hex");
  const rows = hexRows(encoded.ok ? encoded.bytes : bytes);
  return (
    <section
      aria-label="Hex value"
      data-testid="value-formatted"
      data-format="hex"
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-panel font-grid text-grid"
    >
      <div className="flex h-row shrink-0 items-center gap-gap border-b border-line px-cell">
        <span className="text-ink-muted">
          {format === "auto" ? "Auto: Hex" : "Hex"}
          {editable ? " · edit byte pairs" : " · read-only"}
        </span>
        <span className="ml-auto">
          <Select
            label="Format"
            testId="value-format"
            value={format}
            options={FORMAT_OPTIONS}
            onChange={(next) => {
              const selected = VALUE_FORMATS.find((candidate) => candidate === next);
              if (selected !== undefined) onFormat(selected);
            }}
          />
        </span>
      </div>
      {encoded.ok ? null : (
        <p role="alert" data-testid="value-problem" className="shrink-0 px-cell text-danger">
          {encoded.error} Offsets and ASCII show the last valid bytes.
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-cell">
        <div className="grid min-w-max grid-cols-[8ch_47ch_16ch] items-start gap-x-gap font-grid text-grid leading-normal">
          <span className="sticky top-0 bg-panel text-ink-muted">Offset</span>
          <span className="sticky top-0 bg-panel text-ink-muted">Hex · 16 bytes per row</span>
          <span className="sticky top-0 bg-panel text-ink-muted">ASCII</span>
          <pre aria-hidden className="text-ink-muted">
            {rows.map((row) => row.offset).join("\n")}
          </pre>
          <pre className="text-ink select-text">{rows.map((row) => row.hex).join("\n")}</pre>
          <pre aria-label="ASCII preview" className="text-ink-muted">
            {rows.map((row) => row.ascii).join("\n")}
          </pre>
        </div>
        {editable ? (
          <label className="mt-gap flex flex-col gap-1 border-t border-line pt-gap text-ink-muted">
            Edit hex bytes (offsets and ASCII above are read-only)
            <textarea
              aria-label="Hex bytes"
              aria-invalid={!encoded.ok}
              spellCheck={false}
              wrap="off"
              rows={Math.max(1, draft.split("\n").length)}
              value={draft}
              readOnly={!editable}
              className="w-full resize-none overflow-hidden bg-canvas font-grid text-grid leading-normal text-ink outline-none focus:ring-1 focus:ring-accent"
              onChange={(event) => {
                setDraft(event.target.value);
                onChange(event.target.value);
              }}
            />
          </label>
        ) : null}
      </div>
    </section>
  );
}
