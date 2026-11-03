import { create } from "zustand";
import type { ImportApp } from "@table-craft/desktop/preload/bridge.js";

/** Open straight on one app's preview, as the bell's import notice does (plan 145). */
export interface ImportDataSourcesRequest {
  readonly app: ImportApp;
}

export interface ImportDataSourcesDialogState {
  /** Bumped on each open, so the dialog starts fresh; null while closed. */
  readonly session: number | null;
  /** The app to preview at once; null opens on the source picker. */
  readonly app: ImportApp | null;
  readonly show: (request?: ImportDataSourcesRequest) => void;
  readonly hide: () => void;
}

export const useImportDataSourcesDialog = create<ImportDataSourcesDialogState>()((set) => ({
  session: null,
  app: null,
  show: (request) => set((state) => ({ session: (state.session ?? 0) + 1, app: request?.app ?? null })),
  hide: () => set({ session: null, app: null }),
}));
