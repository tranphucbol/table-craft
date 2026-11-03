import { create } from "zustand";
import type { DatasourceSelection } from "@table-craft/desktop/preload/bridge.js";

export interface ExportDataSourcesDialogState {
  /** Bumped on each open, so the dialog starts fresh; null while closed. */
  readonly session: number | null;
  /** What was selected in the Database pane when it opened; empty offers only everything. */
  readonly selection: DatasourceSelection;
  readonly show: (selection: DatasourceSelection) => void;
  readonly hide: () => void;
}

const NOTHING: DatasourceSelection = { ids: [], folders: [] };

export const useExportDataSourcesDialog = create<ExportDataSourcesDialogState>()((set) => ({
  session: null,
  selection: NOTHING,
  show: (selection) => set((state) => ({ session: (state.session ?? 0) + 1, selection })),
  hide: () => set({ session: null, selection: NOTHING }),
}));
