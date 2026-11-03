import type {
  ImportPasswordState,
  ImportPreviewRequest,
  ImportRow,
  ImportSource,
  ImportSummary,
} from "@table-craft/desktop/preload/bridge.js";

/** How a file is read: as it is, with the passphrase typed, or without its encrypted passwords. */
export type FileUnlock =
  | { readonly kind: "plain" }
  | { readonly kind: "passphrase"; readonly passphrase: string }
  | { readonly kind: "skipSecrets" };

export function filePreviewRequest(path: string, unlock: FileUnlock): ImportPreviewRequest {
  if (unlock.kind === "passphrase") return { source: "file", path, passphrase: unlock.passphrase };
  if (unlock.kind === "skipSecrets") return { source: "file", path, skipSecrets: true };
  return { source: "file", path };
}

export const PASSWORD_LABELS: Readonly<Record<ImportPasswordState, string>> = {
  keychain: "Keychain — will ask",
  found: "Found",
  inFile: "In file",
  notSaved: "Not saved",
  locked: "Locked",
  askOnConnect: "Ask on connect",
  notNeeded: "—",
};

export const STATUS_LABELS: Readonly<Record<ImportRow["status"], string | null>> = {
  ready: null,
  duplicate: "Already in TableCraft",
  sshTunnel: "SSH tunnel not imported",
  unsupported: "Not supported",
};

/** The keys a preview ticks on its own: rows ready to import. */
export function initialSelection(rows: readonly ImportRow[]): ReadonlySet<string> {
  return new Set(rows.filter((row) => row.selected).map((row) => row.key));
}

/** Rows a tick can apply to; an unsupported one never can. */
export function selectable(rows: readonly ImportRow[]): readonly ImportRow[] {
  return rows.filter((row) => row.status !== "unsupported");
}

export function toggled(selection: ReadonlySet<string>, key: string, on: boolean): ReadonlySet<string> {
  const next = new Set(selection);
  if (on) next.add(key);
  else next.delete(key);
  return next;
}

export function allSelected(rows: readonly ImportRow[]): ReadonlySet<string> {
  return new Set(selectable(rows).map((row) => row.key));
}

/** The ticked keys in the preview's order, never an unsupported row. */
export function selectedKeys(rows: readonly ImportRow[], selection: ReadonlySet<string>): readonly string[] {
  return selectable(rows)
    .filter((row) => selection.has(row.key))
    .map((row) => row.key);
}

/** The line under a source card. */
export function sourceDetail(source: ImportSource): string {
  if (!source.found) return "Not found";
  return source.count === 1 ? "1 connection" : `${String(source.count)} connections`;
}

/** Whether running the import may show the system's keychain prompt. */
export function asksKeychain(
  rows: readonly ImportRow[],
  selection: ReadonlySet<string>,
  importPasswords: boolean,
): boolean {
  return importPasswords && rows.some((row) => selection.has(row.key) && row.password === "keychain");
}

export function summaryText(summary: ImportSummary): string {
  const parts = [
    `Imported ${String(summary.imported)}`,
    `with passwords ${String(summary.withPasswords)}`,
    `skipped ${String(summary.skipped)}`,
  ];
  return `${parts.join(", ")}.`;
}

export function summaryNotes(summary: ImportSummary): readonly string[] {
  const notes: string[] = [];
  if (summary.cancelled) notes.push("Cancelled; the connections before it were imported.");
  if (summary.keychainDenied) {
    notes.push("The keychain was denied, so the rest were imported without passwords; TableCraft asks on connect.");
  }
  return notes;
}
