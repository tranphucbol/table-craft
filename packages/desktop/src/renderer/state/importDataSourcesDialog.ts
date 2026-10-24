import { create } from "zustand";

export interface ImportDataSourcesDialogState {
  /** Bumped on each open, so the dialog starts fresh; null while closed. */
  readonly session: number | null;
  readonly show: () => void;
  readonly hide: () => void;
}

export const useImportDataSourcesDialog = create<ImportDataSourcesDialogState>()((set) => ({
  session: null,
  show: () => set((state) => ({ session: (state.session ?? 0) + 1 })),
  hide: () => set({ session: null }),
}));
