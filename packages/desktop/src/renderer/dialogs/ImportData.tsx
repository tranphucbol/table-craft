import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import {
  IMPORT_ENCODINGS,
  type ImportFormat,
  type ImportPreview,
  type NewImportColumn,
} from "@table-craft/desktop/engine/protocol.js";
import { Button, Check, FieldRow, Section, Select, TextInput } from "@table-craft/desktop/renderer/dialogs/parts.js";
import {
  CSV_PRESET,
  DEFAULT_COMMIT_ROWS,
  DEFAULT_REJECT_LIMIT,
  DELIMITERS,
  QUOTES,
  TSV_PRESET,
  defaultMapping,
  errorPolicyOf,
  mappingOf,
  newColumnDrafts,
  newColumnsOf,
  newColumnsProblem,
  positiveCount,
  presetFor,
  tableNameOf,
  transactionOf,
  type NewColumnDraft,
} from "@table-craft/desktop/renderer/model/importForm.js";
import { formatBytes } from "@table-craft/desktop/renderer/model/format.js";
import { importAnswer, useModal, type ModalRequest } from "@table-craft/desktop/renderer/state/modal.js";
import { toError } from "@table-craft/desktop/renderer/state/resultWindows.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { SqlView } from "@table-craft/desktop/renderer/ui/SqlView.js";

type ImportRequest = Extract<ModalRequest, { kind: "import" }>;

const FILE_FIELD_ID = "import-file";
const TABLE_FIELD_ID = "import-table";
const NULL_FIELD_ID = "import-null";
/** Typing a path previews once it pauses, not on every keystroke. */
const PREVIEW_DELAY_MS = 250;
const SKIP_FIELD = "";
const ENCODING_LABELS: Readonly<Record<(typeof IMPORT_ENCODINGS)[number], string>> = {
  auto: "Detect (UTF-8, or UTF-16 by its BOM)",
  "utf-8": "UTF-8",
  "utf-16le": "UTF-16 LE",
  "utf-16be": "UTF-16 BE",
  "windows-1252": "Windows-1252",
};

interface Loaded<T> {
  readonly key: string;
  readonly value: T | null;
  readonly error: string | null;
}

/** Answers `load(key)` for the latest `key` after a pause; stale answers are dropped. */
function useLoaded<T>(key: string | null, load: () => Promise<T>): Loaded<T> | null {
  const [loaded, setLoaded] = useState<Loaded<T> | null>(null);
  useEffect(() => {
    if (key === null) return;
    let current = true;
    const timer = setTimeout(() => {
      load().then(
        (value) => {
          if (current) setLoaded({ key, value, error: null });
        },
        (cause: unknown) => {
          if (current) setLoaded({ key, value: null, error: toError(cause).message });
        },
      );
    }, PREVIEW_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
    // `load` closes over what `key` encodes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return key !== null && loaded?.key === key ? loaded : null;
}

function PreviewTable({ preview }: { readonly preview: ImportPreview }) {
  return (
    <div data-testid="import-preview" className="max-h-picker-list overflow-auto rounded border border-line bg-canvas">
      <table className="border-collapse font-editor text-editor">
        <thead className="sticky top-0 bg-panel">
          <tr>
            {preview.names.map((name, index) => (
              <th key={index} className="border-b border-line px-cell text-left font-semibold whitespace-nowrap">
                {name}
                <span className="ml-cell font-normal text-ink-muted">{preview.kinds[index]}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {preview.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, index) => (
                <td key={index} className="max-w-60 truncate px-cell whitespace-nowrap">
                  {cell === null ? <span className="text-ink-muted">NULL</span> : cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Import Data (plan 021): the file and its format, a preview the engine reads from the file's
 * head, where each column goes (or the new table's columns with its DDL), and the transaction and
 * bad-row policies. Import starts a background task; the dialog closes at once.
 */
export function ImportData({ request }: { readonly request: ImportRequest }) {
  const answer = useModal((state) => state.answer);
  const [file, setFile] = useState("");
  const [format, setFormat] = useState<ImportFormat>(CSV_PRESET);
  /** A new table's name follows the file's until it is typed. */
  const [typedRelation, setTypedRelation] = useState<string | null>(null);
  const [mapping, setMapping] = useState<{ readonly key: string; readonly fields: readonly (number | null)[] }>();
  const [drafts, setDrafts] = useState<{ readonly key: string; readonly drafts: readonly NewColumnDraft[] }>();
  const [every, setEvery] = useState(false);
  const [everyText, setEveryText] = useState(String(DEFAULT_COMMIT_ROWS));
  const [skip, setSkip] = useState(false);
  const [limitText, setLimitText] = useState(String(DEFAULT_REJECT_LIMIT));

  const path = file.trim();
  const relation = typedRelation ?? (request.columns !== null || path === "" ? request.relation : tableNameOf(path));
  const previewKey = path === "" ? null : JSON.stringify([path, format]);
  const preview = useLoaded(previewKey, () => request.preview(path, format));
  const shown = preview?.value ?? null;
  const namesKey = shown === null ? "" : JSON.stringify([previewKey, shown.names]);

  const fields =
    request.columns === null || shown === null
      ? []
      : mapping?.key === namesKey
        ? mapping.fields
        : defaultMapping(request.columns, shown, format.header);
  const columnDrafts = shown === null ? [] : drafts?.key === namesKey ? drafts.drafts : newColumnDrafts(shown);
  const newColumns: readonly NewImportColumn[] = newColumnsOf(columnDrafts);
  const draftProblem = request.columns === null ? newColumnsProblem(newColumns) : null;
  const tableName = relation.trim();
  const ddlKey =
    request.columns !== null || shown === null || draftProblem !== null || tableName === ""
      ? null
      : JSON.stringify([tableName, newColumns]);
  const ddl = useLoaded(ddlKey, () => request.ddl(tableName, newColumns));

  const commitRows = positiveCount(everyText);
  const rejectLimit = positiveCount(limitText);
  const mapped = request.columns === null ? [] : mappingOf(request.columns, fields);
  const ready =
    shown !== null &&
    (request.columns === null ? ddl?.value != null : mapped.length > 0) &&
    (!every || commitRows !== null) &&
    (!skip || rejectLimit !== null);

  const setFormatField = <K extends keyof ImportFormat>(key: K, value: ImportFormat[K]) =>
    setFormat((current) => ({ ...current, [key]: value }));
  const choose = (picked: string) => {
    setFile(picked);
    setFormat((current) => ({ ...presetFor(picked), encoding: current.encoding }));
  };
  const browse = async () => {
    const picked = await request.browse();
    if (picked !== null) choose(picked);
  };
  const setDraft = (index: number, change: Partial<NewColumnDraft>) =>
    setDrafts({
      key: namesKey,
      drafts: columnDrafts.map((draft, at) => (at === index ? { ...draft, ...change } : draft)),
    });

  const fieldOptions = [
    { label: "(skip)", value: SKIP_FIELD },
    ...(shown?.names ?? []).map((name, index) => ({ label: `${String(index + 1)}. ${name}`, value: String(index) })),
  ];

  return (
    <form
      className="flex max-h-[95vh] flex-col gap-gap overflow-auto p-gap"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready || (every && commitRows === null) || (skip && rejectLimit === null)) return;
        answer(
          importAnswer({
            file: path,
            format,
            relation: request.columns === null ? tableName : request.relation,
            mapping: request.columns === null ? null : mapped,
            columns: request.columns === null ? newColumns : null,
            transaction: transactionOf(every, commitRows ?? DEFAULT_COMMIT_ROWS),
            errors: errorPolicyOf(skip, rejectLimit ?? DEFAULT_REJECT_LIMIT),
          }),
        );
      }}
    >
      <Dialog.Title className="font-semibold">{request.title}</Dialog.Title>
      <p className="text-ink-muted">{request.note}</p>
      <div className="grid grid-cols-[max-content_1fr] gap-x-gap gap-y-cell">
        <FieldRow label="File" htmlFor={FILE_FIELD_ID}>
          <TextInput
            id={FILE_FIELD_ID}
            data-testid="import-file"
            className="flex-1"
            value={file}
            placeholder="Choose a CSV or TSV file"
            onChange={(event) => setFile(event.target.value)}
          />
          <Button onClick={() => void browse()}>Browse…</Button>
        </FieldRow>
        <FieldRow label="Format">
          <Button onClick={() => setFormat({ ...CSV_PRESET, encoding: format.encoding })}>CSV</Button>
          <Button onClick={() => setFormat({ ...TSV_PRESET, encoding: format.encoding })}>TSV</Button>
          <Select
            label="Delimiter"
            testId="import-delimiter"
            value={format.delimiter}
            options={DELIMITERS}
            onChange={(value) => setFormatField("delimiter", value)}
          />
          <Select
            label="Quote"
            value={format.quote ?? SKIP_FIELD}
            options={QUOTES.map((quote) => ({ label: quote.label, value: quote.value ?? SKIP_FIELD }))}
            onChange={(value) => setFormatField("quote", value === SKIP_FIELD ? null : value)}
          />
          <Select
            label="Escape"
            value={format.escape}
            options={[
              { label: "Doubled quote", value: "double" },
              { label: "Backslash", value: "backslash" },
            ]}
            onChange={(value) => setFormatField("escape", value === "backslash" ? "backslash" : "double")}
          />
        </FieldRow>
        <FieldRow label="Encoding">
          <Select
            label="Encoding"
            testId="import-encoding"
            value={format.encoding}
            options={IMPORT_ENCODINGS.map((encoding) => ({ label: ENCODING_LABELS[encoding], value: encoding }))}
            onChange={(value) =>
              setFormatField("encoding", IMPORT_ENCODINGS.find((encoding) => encoding === value) ?? "auto")
            }
          />
          <Check
            label="First row is the header"
            checked={format.header}
            onChange={(checked) => setFormatField("header", checked)}
          />
          <Check label="Trim spaces" checked={format.trim} onChange={(checked) => setFormatField("trim", checked)} />
        </FieldRow>
        <FieldRow label="NULL text" htmlFor={NULL_FIELD_ID}>
          <TextInput
            id={NULL_FIELD_ID}
            className="w-24"
            value={format.nullToken}
            placeholder="(empty)"
            onChange={(event) => setFormatField("nullToken", event.target.value)}
          />
          <span className="text-ink-muted">An unquoted field equal to this is NULL.</span>
        </FieldRow>
      </div>
      {preview?.error != null ? (
        <p role="alert" data-testid="import-error" className="break-words text-danger">
          {preview.error}
        </p>
      ) : null}
      {shown === null ? null : (
        <Section title="Preview">
          <PreviewTable preview={shown} />
          <p className="text-ink-muted" data-testid="import-summary">
            {ENCODING_LABELS[shown.encoding]} · {formatBytes(shown.size)} · first {shown.rows.length} rows
            {shown.ragged > 0 ? (
              <span className="text-danger">
                {" "}
                · {shown.ragged} sampled rows have a different number of fields and will be bad rows
              </span>
            ) : null}
          </p>
        </Section>
      )}
      {shown === null ? null : request.columns !== null ? (
        <Section title={`Columns of ${request.relation}`}>
          <div
            data-testid="import-mapping"
            className="grid max-h-picker-list grid-cols-[max-content_1fr] items-center gap-x-gap gap-y-cell overflow-auto"
          >
            {request.columns.map((column, index) => (
              <FieldRow key={column} label={column}>
                <Select
                  label={`Field for ${column}`}
                  value={fields[index] == null ? SKIP_FIELD : String(fields[index])}
                  options={fieldOptions}
                  onChange={(value) =>
                    setMapping({
                      key: namesKey,
                      fields: fields.map((field, at) =>
                        at === index ? (value === SKIP_FIELD ? null : Number(value)) : field,
                      ),
                    })
                  }
                />
              </FieldRow>
            ))}
          </div>
          {mapped.length === 0 ? <p className="text-danger">Map at least one column to a field.</p> : null}
        </Section>
      ) : (
        <Section title="New table">
          <div className="grid grid-cols-[max-content_1fr] gap-x-gap gap-y-cell">
            <FieldRow label="Name" htmlFor={TABLE_FIELD_ID}>
              <TextInput
                id={TABLE_FIELD_ID}
                data-testid="import-table"
                className="flex-1"
                value={relation}
                onChange={(event) => setTypedRelation(event.target.value)}
              />
            </FieldRow>
          </div>
          <div
            data-testid="import-columns"
            className="grid max-h-picker-list grid-cols-[max-content_1fr_1fr_max-content] items-center gap-x-gap gap-y-cell overflow-auto"
          >
            {columnDrafts.map((draft, index) => (
              <div key={index} className="contents">
                <input
                  type="checkbox"
                  aria-label={`Include field ${String(index + 1)}`}
                  checked={draft.include}
                  onChange={(event) => setDraft(index, { include: event.target.checked })}
                />
                <TextInput
                  aria-label={`Name of field ${String(index + 1)}`}
                  value={draft.name}
                  onChange={(event) => setDraft(index, { name: event.target.value })}
                />
                <TextInput
                  aria-label={`Type of field ${String(index + 1)}`}
                  value={draft.type}
                  onChange={(event) => setDraft(index, { type: event.target.value })}
                />
                <span className="text-ink-muted">{shown.kinds[index]}</span>
              </div>
            ))}
          </div>
          {draftProblem === null ? null : <p className="text-danger">{draftProblem}</p>}
          {ddl?.error != null ? <p className="break-words text-danger">{ddl.error}</p> : null}
          <SqlView
            text={ddl?.value ?? ""}
            highlight={request.highlight}
            label="CREATE TABLE"
            testId="import-ddl"
            className="h-32 rounded border border-line bg-canvas"
          />
        </Section>
      )}
      <div className="grid grid-cols-2 gap-gap">
        <Section title="Transaction">
          <label className="flex h-row items-center gap-cell">
            <input type="radio" name="import-transaction" checked={!every} onChange={() => setEvery(false)} />
            All or nothing
          </label>
          <label className="flex h-row items-center gap-cell">
            <input type="radio" name="import-transaction" checked={every} onChange={() => setEvery(true)} />
            Commit every
            <TextInput
              aria-label="Rows per commit"
              aria-invalid={every && commitRows === null}
              className="w-24"
              value={everyText}
              onChange={(event) => setEveryText(event.target.value)}
            />
            rows
          </label>
        </Section>
        <Section title="Bad rows">
          <label className="flex h-row items-center gap-cell">
            <input type="radio" name="import-errors" checked={!skip} onChange={() => setSkip(false)} />
            Stop at the first
          </label>
          <label className="flex h-row items-center gap-cell">
            <input type="radio" name="import-errors" checked={skip} onChange={() => setSkip(true)} />
            Skip up to
            <TextInput
              aria-label="Rows to reject"
              aria-invalid={skip && rejectLimit === null}
              className="w-24"
              value={limitText}
              onChange={(event) => setLimitText(event.target.value)}
            />
            into <code className={cn("truncate", path === "" && "text-ink-muted")}>…rejected.csv</code>
          </label>
        </Section>
      </div>
      <div className="flex justify-end gap-gap">
        <Button onClick={() => answer(null)}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={!ready}>
          Import
        </Button>
      </div>
    </form>
  );
}
