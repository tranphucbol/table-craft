import { useEffect } from "react";
import { create } from "zustand";
import {
  jsonColumnKey,
  jsonViewOf,
  type JsonViewInput,
  type JsonViewState,
} from "@table-craft/desktop/renderer/model/jsonView.js";
import { useSettings } from "@table-craft/desktop/renderer/state/settings.js";

/** A mounted value panel's JSON view, for `grid.toggleJsonView`. */
export interface ShownJsonView {
  readonly key: string;
  readonly on: boolean;
}

export interface JsonViewStore {
  /** The `{}` choices made this session, per result column (plan 126 decision 5); never saved. */
  readonly overrides: Readonly<Record<string, boolean>>;
  /** The JSON-capable value each result's mounted panel shows, keyed by `jsonOwnerKey`. */
  readonly panels: Readonly<Record<string, ShownJsonView>>;
  readonly set: (key: string, on: boolean) => void;
  readonly publish: (owner: string, panel: ShownJsonView | null) => void;
}

export const useJsonView = create<JsonViewStore>()((set) => ({
  overrides: {},
  panels: {},
  set: (key, on) => set((state) => ({ overrides: { ...state.overrides, [key]: on } })),
  publish: (owner, panel) =>
    set((state) => {
      if (panel === null) {
        if (!(owner in state.panels)) return state;
        const { [owner]: _gone, ...panels } = state.panels;
        return { panels };
      }
      const current = state.panels[owner];
      return current?.key === panel.key && current.on === panel.on
        ? state
        : { panels: { ...state.panels, [owner]: panel } };
    }),
}));

/** Where a value panel keeps its JSON choice: the result's owner key and the column's name. */
export interface JsonViewTarget {
  readonly owner: string;
  readonly column: string;
}

/** A value panel's JSON view, published while mounted so the action can flip it. */
export function useJsonViewState(
  target: JsonViewTarget | undefined,
  value: Pick<JsonViewInput, "text" | "json">,
): JsonViewState {
  const detect = useSettings((state) => state.settings.data.detectJson);
  const key = target === undefined ? null : jsonColumnKey(target.owner, target.column);
  const override = useJsonView((state) => (key === null ? undefined : state.overrides[key]));
  const view = jsonViewOf({ ...value, detect, override });
  const owner = target?.owner;
  const shown = key !== null && view.available;
  const on = view.on;
  useEffect(() => {
    if (owner === undefined || key === null) return;
    const { publish } = useJsonView.getState();
    publish(owner, shown ? { key, on } : null);
    return () => publish(owner, null);
  }, [owner, key, shown, on]);
  return view;
}
