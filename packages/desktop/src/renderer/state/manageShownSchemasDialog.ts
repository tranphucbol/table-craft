import { create } from "zustand";

export interface ManageShownSchemasDialogState {
  /** The datasource whose shown schemas the dialog edits; null while closed. */
  readonly datasourceId: string | null;
  /** Bumped on each open, so the dialog starts fresh. */
  readonly session: number;
  readonly show: (datasourceId: string) => void;
  readonly hide: () => void;
}

export const useManageShownSchemasDialog = create<ManageShownSchemasDialogState>()((set) => ({
  datasourceId: null,
  session: 0,
  show: (datasourceId) => set((state) => ({ datasourceId, session: state.session + 1 })),
  hide: () => set({ datasourceId: null }),
}));
