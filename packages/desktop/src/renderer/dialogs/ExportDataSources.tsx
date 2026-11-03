import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import type { BridgeFailure, DatasourceSelection } from "@table-craft/desktop/preload/bridge.js";
import { bridge } from "@table-craft/desktop/renderer/bridge.js";
import {
  Button,
  Check,
  CONTENT_CLASS,
  DialogFooter,
  OVERLAY_CLASS,
  TextInput,
} from "@table-craft/desktop/renderer/dialogs/parts.js";
import {
  countIn,
  dataSourceCount,
  everything,
  isEmptySelection,
  passphraseProblem,
} from "@table-craft/desktop/renderer/model/exportDataSources.js";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useExportDataSourcesDialog } from "@table-craft/desktop/renderer/state/exportDataSourcesDialog.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";

type Scope = "selected" | "all";

const PASSPHRASE_FIELD_ID = "export-datasources-passphrase";
const CONFIRM_FIELD_ID = "export-datasources-confirm";
const PASSWORDS_NOTE =
  "The passwords are encrypted with the passphrase; the importer types it once. Keep it apart from the file.";
const NO_PASSWORDS_NOTE = "The file holds no passwords; TableCraft asks for them on the first connect after import.";

function Body({ selected }: { readonly selected: DatasourceSelection }) {
  const hide = useExportDataSourcesDialog((state) => state.hide);
  const datasources = useDatasources((state) => state.datasources);
  const folders = useDatasources((state) => state.folders);
  const [scope, setScope] = useState<Scope>(isEmptySelection(selected) ? "all" : "selected");
  const [includePasswords, setIncludePasswords] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<BridgeFailure | null>(null);
  const [saved, setSaved] = useState<{ readonly path: string; readonly count: number } | null>(null);

  const all = everything(datasources, folders);
  const selection = scope === "selected" ? selected : all;
  const count = countIn(selection, datasources);
  const problem = includePasswords ? passphraseProblem(passphrase, confirmation) : null;
  const touched = passphrase !== "" || confirmation !== "";

  async function exportFile(): Promise<void> {
    if (problem !== null || count === 0) return;
    setBusy(true);
    setFailure(null);
    try {
      const answer = await bridge().exportDatasources(includePasswords ? { ...selection, passphrase } : selection);
      if (!answer.ok) setFailure(answer.error);
      else if (answer.value.status === "saved") setSaved({ path: answer.value.path, count: answer.value.count });
    } finally {
      setBusy(false);
    }
  }

  if (saved !== null) {
    return (
      <div className="flex flex-col gap-gap p-gap" data-testid="export-datasources-done">
        <Dialog.Title className="font-semibold">Export Data Sources</Dialog.Title>
        <p>
          Exported {dataSourceCount(saved.count)} to <span className="font-editor break-all">{saved.path}</span>.
        </p>
        <DialogFooter start={<Button onClick={() => void bridge().revealFile(saved.path)}>Reveal</Button>}>
          <Button variant="primary" autoFocus onClick={hide}>
            Done
          </Button>
        </DialogFooter>
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-gap p-gap"
      data-testid="export-datasources"
      onSubmit={(event) => {
        event.preventDefault();
        void exportFile();
      }}
    >
      <Dialog.Title className="font-semibold">Export Data Sources</Dialog.Title>
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-ink-muted">Export</legend>
        <label className="flex h-row items-center gap-cell">
          <input
            type="radio"
            name="export-scope"
            data-testid="export-scope-selected"
            disabled={isEmptySelection(selected)}
            checked={scope === "selected"}
            onChange={() => setScope("selected")}
          />
          The selection: {dataSourceCount(countIn(selected, datasources))}
        </label>
        <label className="flex h-row items-center gap-cell">
          <input
            type="radio"
            name="export-scope"
            data-testid="export-scope-all"
            checked={scope === "all"}
            onChange={() => setScope("all")}
          />
          All saved: {dataSourceCount(countIn(all, datasources))}
        </label>
      </fieldset>
      <Check label="Include passwords" checked={includePasswords} onChange={setIncludePasswords} />
      {includePasswords ? (
        <div className="grid grid-cols-[max-content_1fr] items-center gap-x-gap gap-y-1">
          <label htmlFor={PASSPHRASE_FIELD_ID} className="text-ink-muted">
            Passphrase
          </label>
          <TextInput
            id={PASSPHRASE_FIELD_ID}
            data-testid="export-passphrase"
            type="password"
            autoFocus
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
          />
          <label htmlFor={CONFIRM_FIELD_ID} className="text-ink-muted">
            Again
          </label>
          <TextInput
            id={CONFIRM_FIELD_ID}
            data-testid="export-passphrase-confirm"
            type="password"
            aria-invalid={touched && problem !== null}
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
          />
        </div>
      ) : null}
      <p data-testid="export-note" className={cn(touched && problem !== null ? "text-danger" : "text-ink-muted")}>
        {includePasswords ? (touched && problem !== null ? problem : PASSWORDS_NOTE) : NO_PASSWORDS_NOTE}
      </p>
      {failure === null ? null : (
        <p role="alert" className="text-danger">
          {failure.message} <span className="text-ink-muted">{failure.hint}</span>
        </p>
      )}
      <DialogFooter>
        <Button onClick={hide}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={busy || count === 0 || problem !== null}>
          Export…
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * Export Data Sources (plan 040): the selection or everything, to a JSON file another TableCraft
 * imports. Main reads the passwords and seals them with the passphrase; this view never sees one.
 */
export function ExportDataSourcesDialog() {
  const session = useExportDataSourcesDialog((state) => state.session);
  const selection = useExportDataSourcesDialog((state) => state.selection);
  return (
    <Dialog.Root
      open={session !== null}
      onOpenChange={(open) => {
        if (!open) useExportDataSourcesDialog.getState().hide();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={OVERLAY_CLASS} />
        <Dialog.Content aria-describedby={undefined} className={cn(CONTENT_CLASS, "w-96 max-w-[95vw]")}>
          {session === null ? null : <Body key={session} selected={selection} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
