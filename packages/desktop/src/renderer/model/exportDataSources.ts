import { isWithin, type TreeItemRef } from "@table-craft/desktop/datasourceTree/arrange.js";
import {
  MIN_PASSPHRASE_LENGTH,
  type DatasourceSelection,
  type DatasourceView,
} from "@table-craft/desktop/preload/bridge.js";

/** The saved data sources and folders among the tree's items; the one from the environment never leaves (decision 018). */
export function selectionOf(
  items: readonly TreeItemRef[],
  datasources: readonly DatasourceView[],
): DatasourceSelection {
  const saved = new Set(datasources.filter((view) => !view.ephemeral).map((view) => view.id));
  return {
    ids: items.flatMap((item) => (item.kind === "datasource" && saved.has(item.id) ? [item.id] : [])),
    folders: items.flatMap((item) => (item.kind === "folder" ? [item.path] : [])),
  };
}

export function everything(datasources: readonly DatasourceView[], folders: readonly string[]): DatasourceSelection {
  return { ids: datasources.filter((view) => !view.ephemeral).map((view) => view.id), folders };
}

/** How many saved data sources a selection brings, each once: those picked and those below a picked folder. */
export function countIn(selection: DatasourceSelection, datasources: readonly DatasourceView[]): number {
  const ids = new Set(selection.ids);
  return datasources.filter(
    (view) =>
      !view.ephemeral && (ids.has(view.id) || selection.folders.some((folder) => isWithin(view.folder, folder))),
  ).length;
}

export function isEmptySelection(selection: DatasourceSelection): boolean {
  return selection.ids.length === 0 && selection.folders.length === 0;
}

/** Why the passphrase cannot seal the file yet; null when it can. */
export function passphraseProblem(passphrase: string, confirmation: string): string | null {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    return `Use a passphrase of at least ${String(MIN_PASSPHRASE_LENGTH)} characters.`;
  }
  if (passphrase !== confirmation) return "The passphrases do not match.";
  return null;
}

export function dataSourceCount(count: number): string {
  return count === 1 ? "1 data source" : `${String(count)} data sources`;
}
