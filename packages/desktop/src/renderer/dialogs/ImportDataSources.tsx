import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import type {
  BridgeFailure,
  ImportPreview,
  ImportPreviewRequest,
  ImportProgress,
  ImportRow,
  ImportSource,
  ImportSummary,
  InvokeResult,
} from "@table-craft/desktop/preload/bridge.js";
import { bridge } from "@table-craft/desktop/renderer/bridge.js";
import { Button, Check, CONTENT_CLASS, OVERLAY_CLASS, TextInput } from "@table-craft/desktop/renderer/dialogs/parts.js";
import {
  PASSWORD_LABELS,
  STATUS_LABELS,
  allSelected,
  asksKeychain,
  initialSelection,
  selectedKeys,
  sourceDetail,
  summaryNotes,
  summaryText,
  toggled,
} from "@table-craft/desktop/renderer/model/importDataSources.js";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useImportDataSourcesDialog } from "@table-craft/desktop/renderer/state/importDataSourcesDialog.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";

type ReadyPreview = Extract<ImportPreview, { status: "ready" }>;

type Step =
  | { readonly kind: "source" }
  | { readonly kind: "choose"; readonly preview: ReadyPreview }
  | { readonly kind: "import"; readonly preview: ReadyPreview }
  | { readonly kind: "done"; readonly summary: ImportSummary };

const BROWSE_TITLE = "Import Data Sources from a File";
const FILE_FIELD_ID = "import-datasources-file";
const PASSPHRASE_FIELD_ID = "import-datasources-passphrase";
const KEYCHAIN_NOTE = "The system may ask once for each password; on macOS click Allow, not Always Allow.";

function SourceCard({
  source,
  busy,
  onPick,
}: {
  readonly source: ImportSource;
  readonly busy: boolean;
  readonly onPick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={`import-source-${source.app}`}
      disabled={!source.found || busy}
      className="flex min-w-0 flex-col items-start gap-1 rounded border border-line bg-canvas p-gap text-left hover:bg-raised disabled:opacity-50 disabled:hover:bg-canvas"
      onClick={onPick}
    >
      <span className="font-semibold">{source.label}</span>
      <span>{sourceDetail(source)}</span>
      {source.locations.map((location) => (
        <span key={location} className="w-full truncate text-ink-muted" title={location}>
          {source.found ? location : `Looked in ${location}`}
        </span>
      ))}
      {source.found ? <span className="text-ink-muted">Passwords: {source.passwords}</span> : null}
    </button>
  );
}

function RowsTable({
  rows,
  selection,
  onToggle,
}: {
  readonly rows: readonly ImportRow[];
  readonly selection: ReadonlySet<string>;
  readonly onToggle: (key: string, on: boolean) => void;
}) {
  return (
    <div data-testid="import-rows" className="min-h-0 flex-1 overflow-auto rounded border border-line bg-canvas">
      <table className="w-full border-collapse">
        <thead className="sticky top-0 bg-panel text-left">
          <tr>
            <th className="w-8 border-b border-line px-cell" />
            <th className="border-b border-line px-cell font-semibold">Name</th>
            <th className="border-b border-line px-cell font-semibold">Type</th>
            <th className="border-b border-line px-cell font-semibold">Target</th>
            <th className="border-b border-line px-cell font-semibold">User</th>
            <th className="border-b border-line px-cell font-semibold">Folder</th>
            <th className="border-b border-line px-cell font-semibold">Password</th>
            <th className="border-b border-line px-cell font-semibold">Notes</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const status = STATUS_LABELS[row.status];
            const notes = [...(status === null ? [] : [status]), ...row.warnings];
            return (
              <tr
                key={row.key}
                data-testid="import-row"
                data-status={row.status}
                className={cn("align-top", row.status === "unsupported" && "text-ink-muted")}
              >
                <td className="px-cell">
                  <input
                    type="checkbox"
                    aria-label={`Import ${row.name}`}
                    disabled={row.status === "unsupported"}
                    checked={selection.has(row.key)}
                    onChange={(event) => onToggle(row.key, event.target.checked)}
                  />
                </td>
                <td className="max-w-48 truncate px-cell" title={row.name}>
                  {row.name}
                </td>
                <td className="px-cell whitespace-nowrap">
                  <span className="rounded bg-raised px-1">{row.pluginName}</span>
                </td>
                <td className="max-w-56 truncate px-cell font-editor" title={row.target}>
                  {row.target}
                </td>
                <td className="max-w-32 truncate px-cell">{row.user ?? ""}</td>
                <td className="max-w-32 truncate px-cell" title={row.folder ?? ""}>
                  {row.folder ?? ""}
                </td>
                <td className="px-cell whitespace-nowrap" data-testid="import-password">
                  {PASSWORD_LABELS[row.password]}
                </td>
                <td className="max-w-72 px-cell">
                  {notes.map((note) => (
                    <span
                      key={note}
                      className={cn("block", row.status === "ready" ? "text-ink-muted" : "text-warning")}
                    >
                      {note}
                    </span>
                  ))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Failure({ failure }: { readonly failure: BridgeFailure | null }) {
  if (failure === null) return null;
  return (
    <p role="alert" className="text-danger">
      {failure.message} <span className="text-ink-muted">{failure.hint}</span>
    </p>
  );
}

/**
 * Import Data Sources (plan 035): pick DataGrip, TablePro or a file, tick the connections, then
 * import them. Main reads the other apps' files and secrets; this view only sees rows.
 */
function Wizard() {
  const hide = useImportDataSourcesDialog((state) => state.hide);
  const [step, setStep] = useState<Step>({ kind: "source" });
  const [sources, setSources] = useState<readonly ImportSource[] | null>(null);
  const [failure, setFailure] = useState<BridgeFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState("");
  const [passphrase, setPassphrase] = useState<{ readonly needed: boolean; readonly error: string | null }>({
    needed: false,
    error: null,
  });
  const [passphraseText, setPassphraseText] = useState("");
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [importPasswords, setImportPasswords] = useState(true);
  const [topFolder, setTopFolder] = useState(true);
  const [progress, setProgress] = useState<ImportProgress | null>(null);

  useEffect(() => {
    let current = true;
    void bridge()
      .importScan()
      .then((answer) => {
        if (!current) return;
        if (answer.ok) setSources(answer.value);
        else setFailure(answer.error);
      });
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => bridge().onImportProgress(setProgress), []);

  async function preview(request: ImportPreviewRequest): Promise<void> {
    setBusy(true);
    setFailure(null);
    let answer: InvokeResult<ImportPreview>;
    try {
      answer = await bridge().importPreview(request);
    } finally {
      setBusy(false);
    }
    if (!answer.ok) {
      setFailure(answer.error);
      return;
    }
    const value = answer.value;
    if (value.status === "ready") {
      setPassphraseText("");
      setPassphrase({ needed: false, error: null });
      setSelection(initialSelection(value.rows));
      setStep({ kind: "choose", preview: value });
      return;
    }
    setPassphrase({ needed: true, error: value.status === "wrongPassphrase" ? value.message : null });
  }

  async function browse(): Promise<void> {
    const picked = await bridge().chooseFile(BROWSE_TITLE);
    if (picked.ok && picked.value !== null) {
      setFile(picked.value);
      setPassphrase({ needed: false, error: null });
      await preview({ source: "file", path: picked.value });
    }
  }

  function readFile(): void {
    const path = file.trim();
    if (path === "") return;
    void preview(passphrase.needed ? { source: "file", path, passphrase: passphraseText } : { source: "file", path });
  }

  async function run(chosen: ReadyPreview): Promise<void> {
    setProgress(null);
    setFailure(null);
    setStep({ kind: "import", preview: chosen });
    const answer = await bridge().importRun({
      previewId: chosen.previewId,
      keys: selectedKeys(chosen.rows, selection),
      importPasswords,
      topFolder,
    });
    if (answer.ok) setStep({ kind: "done", summary: answer.value });
    else {
      setFailure(answer.error);
      setStep({ kind: "choose", preview: chosen });
    }
  }

  function finish(summary: ImportSummary): void {
    const first = summary.ids[0];
    if (first !== undefined) useDatasources.getState().select({ kind: "datasource", id: first });
    hide();
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Dialog.Title className="shrink-0 border-b border-line px-gap py-cell font-semibold">
        Import Data Sources
      </Dialog.Title>
      <div className="flex min-h-0 flex-1 flex-col gap-gap p-gap">
        {step.kind === "source" ? (
          <>
            <p className="text-ink-muted">Copy connections from another app. Nothing in it is changed.</p>
            <div className="grid grid-cols-2 gap-gap" data-testid="import-sources">
              {sources === null ? (
                <span className="text-ink-muted">Looking for other apps…</span>
              ) : (
                sources.map((source) => (
                  <SourceCard
                    key={source.app}
                    source={source}
                    busy={busy}
                    onPick={() => void preview({ source: source.app })}
                  />
                ))
              )}
            </div>
            <form
              className="flex flex-col gap-cell"
              onSubmit={(event) => {
                event.preventDefault();
                readFile();
              }}
            >
              <label htmlFor={FILE_FIELD_ID} className="text-ink-muted">
                From a file: a TablePro export (.tablepro) or a DataGrip dataSources.xml
              </label>
              <div className="flex items-center gap-cell">
                <TextInput
                  id={FILE_FIELD_ID}
                  data-testid="import-datasources-file"
                  className="flex-1"
                  value={file}
                  onChange={(event) => {
                    setFile(event.target.value);
                    setPassphrase({ needed: false, error: null });
                  }}
                />
                <Button disabled={busy} onClick={() => void browse()}>
                  From a file…
                </Button>
                <Button type="submit" disabled={busy || file.trim() === ""}>
                  Read
                </Button>
              </div>
              {passphrase.needed ? (
                <div className="flex items-center gap-cell">
                  <label htmlFor={PASSPHRASE_FIELD_ID} className="text-ink-muted">
                    Passphrase
                  </label>
                  <TextInput
                    id={PASSPHRASE_FIELD_ID}
                    data-testid="import-passphrase"
                    type="password"
                    autoFocus
                    className="flex-1"
                    aria-invalid={passphrase.error !== null}
                    value={passphraseText}
                    onChange={(event) => setPassphraseText(event.target.value)}
                  />
                  <Button type="submit" variant="primary" disabled={busy || passphraseText === ""}>
                    Unlock
                  </Button>
                </div>
              ) : null}
              {passphrase.needed ? (
                <p
                  data-testid="import-passphrase-note"
                  className={passphrase.error === null ? "text-ink-muted" : "text-danger"}
                >
                  {passphrase.error ?? "This file is encrypted; enter the passphrase it was exported with."}
                </p>
              ) : null}
            </form>
            {busy ? <p className="text-ink-muted">Reading…</p> : null}
          </>
        ) : step.kind === "choose" ? (
          <>
            <div className="flex items-center gap-cell">
              <span className="text-ink-muted">
                {String(selectedKeys(step.preview.rows, selection).length)} of {String(step.preview.rows.length)}{" "}
                selected
              </span>
              <Button onClick={() => setSelection(allSelected(step.preview.rows))}>Select All</Button>
              <Button onClick={() => setSelection(new Set())}>Select None</Button>
            </div>
            <RowsTable
              rows={step.preview.rows}
              selection={selection}
              onToggle={(key, on) => setSelection((current) => toggled(current, key, on))}
            />
            <div className="flex flex-wrap items-center gap-x-gap">
              <Check label="Import passwords" checked={importPasswords} onChange={setImportPasswords} />
              <Check
                label={`Put them in a “${step.preview.topFolder}” folder`}
                checked={topFolder}
                onChange={setTopFolder}
              />
            </div>
            {asksKeychain(step.preview.rows, selection, importPasswords) ? (
              <p className="text-ink-muted">{KEYCHAIN_NOTE}</p>
            ) : null}
          </>
        ) : step.kind === "import" ? (
          <div className="flex flex-col gap-cell" data-testid="import-progress">
            <span>{progress?.message ?? "Importing…"}</span>
            <progress
              className="w-full"
              max={progress?.total ?? 1}
              value={progress?.done ?? 0}
              aria-label="Import progress"
            />
          </div>
        ) : (
          <div className="flex flex-col gap-cell" data-testid="import-summary">
            <span>{summaryText(step.summary)}</span>
            {summaryNotes(step.summary).map((note) => (
              <span key={note} className="text-ink-muted">
                {note}
              </span>
            ))}
          </div>
        )}
        <Failure failure={failure} />
      </div>
      <div className="flex shrink-0 items-center justify-end gap-gap border-t border-line p-gap">
        {step.kind === "choose" ? (
          <>
            <Button onClick={() => setStep({ kind: "source" })}>Back</Button>
            <span className="flex-1" />
            <Button onClick={hide}>Cancel</Button>
            <Button
              variant="primary"
              disabled={selectedKeys(step.preview.rows, selection).length === 0}
              onClick={() => void run(step.preview)}
            >
              Import
            </Button>
          </>
        ) : step.kind === "import" ? (
          <Button onClick={() => void bridge().importCancel()}>Cancel</Button>
        ) : step.kind === "done" ? (
          <Button variant="primary" autoFocus onClick={() => finish(step.summary)}>
            Done
          </Button>
        ) : (
          <Button onClick={hide}>Cancel</Button>
        )}
      </div>
    </div>
  );
}

export function ImportDataSourcesDialog() {
  const session = useImportDataSourcesDialog((state) => state.session);
  return (
    <Dialog.Root
      open={session !== null}
      onOpenChange={(open) => {
        if (!open) useImportDataSourcesDialog.getState().hide();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={OVERLAY_CLASS} />
        <Dialog.Content
          aria-describedby={undefined}
          className={cn(
            CONTENT_CLASS,
            "flex h-dialog-height max-h-[95vh] w-dialog max-w-[95vw] flex-col overflow-hidden",
          )}
          onInteractOutside={(event) => event.preventDefault()}
        >
          {session === null ? null : <Wizard key={session} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
