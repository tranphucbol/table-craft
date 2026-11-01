import type { TreeItemRef } from "@table-craft/desktop/datasourceTree/arrange.js";
import { objectNameOf, type ExplorerRow } from "@table-craft/desktop/renderer/model/explorerTree.js";
import type { TreeSelection } from "@table-craft/desktop/renderer/state/datasources.js";

/** The Database pane's selection (plan 136): the lead row actions and the keyboard follow, and the rows selected with it. */
export interface TreeSelectionState {
  readonly lead: TreeSelection | null;
  /** Every selected datasource and folder while more than one is; empty for a single selection. */
  readonly multi: readonly TreeItemRef[];
  /** Where a Shift range starts; null starts it at the lead. */
  readonly anchor: TreeItemRef | null;
}

/**
 * `click` selects one row; `toggle` (Mod+click) adds or removes one; `range` (Shift) selects from
 * the anchor; `pressKeep` is a press on a selected row, which keeps the set so it can be dragged.
 */
export type SelectGesture = "click" | "toggle" | "range" | "pressKeep";

export const NO_SELECTION: TreeSelectionState = { lead: null, multi: [], anchor: null };

/** What selecting the row makes the lead; null for rows that cannot be selected. */
export function rowSelection(row: ExplorerRow): TreeSelection | null {
  const { node } = row;
  switch (node.kind) {
    case "folder":
      return { kind: "folder", path: node.path };
    case "datasource":
      return { kind: "datasource", id: node.datasource.id };
    case "loading":
    case "error":
      return null;
    default:
      return { kind: "catalog", id: node.datasourceId, key: row.key, path: node.path, name: objectNameOf(node) };
  }
}

/** The row as an item that moves and deletes; null below a datasource. */
export function rowItem(row: ExplorerRow): TreeItemRef | null {
  const { node } = row;
  if (node.kind === "folder") return { kind: "folder", path: node.path };
  if (node.kind === "datasource") return { kind: "datasource", id: node.datasource.id };
  return null;
}

export function itemOf(selection: TreeSelection | null): TreeItemRef | null {
  if (selection?.kind === "folder") return { kind: "folder", path: selection.path };
  if (selection?.kind === "datasource") return { kind: "datasource", id: selection.id };
  return null;
}

function toSelection(item: TreeItemRef): TreeSelection {
  return item.kind === "folder" ? { kind: "folder", path: item.path } : { kind: "datasource", id: item.id };
}

export function sameItem(a: TreeItemRef | null, b: TreeItemRef | null): boolean {
  if (a === null || b === null) return a === b;
  return a.kind === "folder" ? b.kind === "folder" && a.path === b.path : b.kind === "datasource" && a.id === b.id;
}

/** The selected datasources and folders, in selection order; the lead alone when only it is. */
export function selectedItems(state: TreeSelectionState): readonly TreeItemRef[] {
  if (state.multi.length > 0) return state.multi;
  const lead = itemOf(state.lead);
  return lead === null ? [] : [lead];
}

export function isRowSelected(state: TreeSelectionState, row: ExplorerRow): boolean {
  const item = rowItem(row);
  if (item !== null) return selectedItems(state).some((selected) => sameItem(selected, item));
  return state.lead?.kind === "catalog" && state.lead.key === row.key;
}

function single(lead: TreeSelection | null): TreeSelectionState {
  return { lead, multi: [], anchor: itemOf(lead) };
}

function ofItems(items: readonly TreeItemRef[], lead: TreeItemRef, anchor: TreeItemRef | null): TreeSelectionState {
  return items.length > 1
    ? { lead: toSelection(lead), multi: items, anchor }
    : { ...single(toSelection(lead)), anchor };
}

/** The selection after a gesture on `rows[index]`; unchanged when that row cannot be selected. */
export function nextSelection(
  state: TreeSelectionState,
  rows: readonly ExplorerRow[],
  index: number,
  gesture: SelectGesture,
): TreeSelectionState {
  const row = rows[index];
  const lead = row === undefined ? null : rowSelection(row);
  if (row === undefined || lead === null) return state;
  const item = rowItem(row);
  if (gesture === "click" || item === null) return single(lead);
  const current = selectedItems(state);
  const member = current.some((selected) => sameItem(selected, item));
  if (gesture === "pressKeep") return member && state.multi.length > 0 ? { ...state, lead } : single(lead);
  if (gesture === "toggle") {
    if (!member) return ofItems([...current, item], item, item);
    const rest = current.filter((selected) => !sameItem(selected, item));
    const last = rest[rest.length - 1];
    return last === undefined ? NO_SELECTION : ofItems(rest, last, last);
  }
  const anchor = state.anchor ?? itemOf(state.lead);
  const from = anchor === null ? -1 : rows.findIndex((candidate) => sameItem(rowItem(candidate), anchor));
  if (from < 0) return single(lead);
  const [start, end] = from <= index ? [from, index] : [index, from];
  const items = rows.slice(start, end + 1).flatMap((candidate) => {
    const ref = rowItem(candidate);
    return ref === null ? [] : [ref];
  });
  return ofItems(items, item, anchor);
}

function renameItem(item: TreeItemRef, renamed: ReadonlyMap<string, string>): TreeItemRef {
  if (item.kind !== "folder") return item;
  const path = renamed.get(item.path);
  return path === undefined ? item : { kind: "folder", path };
}

/**
 * The selection after main renamed folders or dropped what it named: renamed folders follow their
 * new paths, gone rows leave it, and a lead that went hands over to the last item still selected.
 */
export function remapSelection(
  state: TreeSelectionState,
  renamed: ReadonlyMap<string, string>,
  exists: (item: TreeItemRef) => boolean,
): TreeSelectionState {
  const keep = (item: TreeItemRef | null) => {
    if (item === null) return null;
    const next = renameItem(item, renamed);
    return exists(next) ? next : null;
  };
  const multi = state.multi.flatMap((item) => {
    const next = keep(item);
    return next === null ? [] : [next];
  });
  const leadItem = itemOf(state.lead);
  let lead: TreeSelection | null = null;
  if (leadItem !== null) {
    const kept = keep(leadItem) ?? multi[multi.length - 1] ?? null;
    lead = kept === null ? null : toSelection(kept);
  } else if (state.lead?.kind === "catalog" && exists({ kind: "datasource", id: state.lead.id })) {
    lead = state.lead;
  }
  const anchor = keep(state.anchor);
  return multi.length > 1 ? { lead, multi, anchor } : { lead, multi: [], anchor: anchor ?? itemOf(lead) };
}
