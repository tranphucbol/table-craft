import { create } from "zustand";
import type { ImportPreview, ImportPreviewRequest, ScannedApp } from "@table-craft/desktop/preload/bridge.js";

export type ReadyImportPreview = Extract<ImportPreview, { status: "ready" }>;

/**
 * Open straight on one app's preview, as the bell's import notice does (plan 145), or on the rows a
 * paste already read (plan 040), with the request that read them so a plugin install can read again.
 */
export type ImportDataSourcesRequest =
  { readonly app: ScannedApp } | { readonly preview: ReadyImportPreview; readonly request: ImportPreviewRequest };

export interface ImportDataSourcesDialogState {
  /** Bumped on each open, so the dialog starts fresh; null while closed. */
  readonly session: number | null;
  /** Where to start; null opens on the source picker. */
  readonly start: ImportDataSourcesRequest | null;
  readonly show: (request?: ImportDataSourcesRequest) => void;
  readonly hide: () => void;
}

export const useImportDataSourcesDialog = create<ImportDataSourcesDialogState>()((set) => ({
  session: null,
  start: null,
  show: (request) => set((state) => ({ session: (state.session ?? 0) + 1, start: request ?? null })),
  hide: () => set({ session: null, start: null }),
}));
