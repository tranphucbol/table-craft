import { create } from "zustand";

/** The Services tree's folded nodes, for this run only: Services starts expanded on every launch. */
export interface ServicesTreeState {
  readonly collapsed: ReadonlySet<string>;
  /** Every expandable node's key in the full tree, published by the pane as the tree changes. */
  readonly expandableKeys: readonly string[];
  readonly setCollapsed: (collapsed: ReadonlySet<string>) => void;
  readonly setExpandableKeys: (keys: readonly string[]) => void;
  /** Folds every expandable node, those under an already folded parent too. */
  readonly collapseAll: () => void;
  readonly expandAll: () => void;
}

const NONE: ReadonlySet<string> = new Set();

export const useServicesTree = create<ServicesTreeState>()((set, get) => ({
  collapsed: NONE,
  expandableKeys: [],
  setCollapsed: (collapsed) => set({ collapsed }),
  setExpandableKeys: (expandableKeys) => set({ expandableKeys }),
  collapseAll: () => set({ collapsed: new Set(get().expandableKeys) }),
  expandAll: () => set({ collapsed: NONE }),
}));
