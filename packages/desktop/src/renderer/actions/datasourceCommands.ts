import {
  arrange,
  folderName,
  parentFolder,
  topmostItems,
  type MoveRequest,
  type TreeItemRef,
} from "@table-craft/desktop/datasourceTree/arrange.js";
import type { DatasourceView, InvokeResult } from "@table-craft/desktop/preload/bridge.js";
import { bridge } from "@table-craft/desktop/renderer/bridge.js";
import { arrangeTreeOf, commonParent } from "@table-craft/desktop/renderer/model/treeDrop.js";
import { useCatalog } from "@table-craft/desktop/renderer/state/catalog.js";
import { useConsoles } from "@table-craft/desktop/renderer/state/consoles.js";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useModal } from "@table-craft/desktop/renderer/state/modal.js";
import { settleAdminRenewals } from "@table-craft/desktop/renderer/keyAdmin/actions.js";
import { useKeyAdmin } from "@table-craft/desktop/renderer/keyAdmin/store.js";

const HISTORY_DELETED = " Its query history is deleted too.";
const HISTORIES_DELETED = " Their query history is deleted too.";

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}

/** Main's answer, or a notice saying what went wrong and null. */
async function settle<T>(title: string, pending: Promise<InvokeResult<T>>): Promise<T | null> {
  const answer = await pending;
  if (answer.ok) return answer.value;
  await useModal.getState().ask({ kind: "notice", title, ...answer.error });
  return null;
}

/** "Delete 3 data sources and 1 folder?", or the one thing by name. */
function deleteQuestion(views: readonly DatasourceView[], folders: readonly string[]): string {
  const [view] = views;
  if (folders.length === 0 && views.length === 1 && view !== undefined) return `Delete "${view.name}"?`;
  const [folder] = folders;
  if (views.length === 0 && folders.length === 1 && folder !== undefined) return `Delete folder "${folder}"?`;
  const parts = [
    ...(views.length === 0 ? [] : [plural(views.length, "data source")]),
    ...(folders.length === 0 ? [] : [plural(folders.length, "folder")]),
  ];
  return `Delete ${parts.join(" and ")}?`;
}

/**
 * Deletes the datasources and folders in one confirmation and one write (plan 136). Folders go only
 * when nothing outside the selection stays in them; the action is disabled otherwise.
 */
export async function deleteItems(items: readonly TreeItemRef[]): Promise<void> {
  const { datasources } = useDatasources.getState();
  const ids = items.flatMap((item) => (item.kind === "datasource" ? [item.id] : []));
  const folders = items.flatMap((item) => (item.kind === "folder" ? [item.path] : []));
  const views = datasources.filter((datasource) => ids.includes(datasource.id));
  if (views.length === 0 && folders.length === 0) return;
  const one = views.length === 1;
  const consoles = Object.values(useConsoles.getState().consoles).filter((session) =>
    ids.includes(session.datasourceId),
  ).length;
  const closing = consoles === 0 ? "" : ` ${one ? "Its" : "Their"} ${plural(consoles, "open console")} will close.`;
  const listed = await Promise.all(views.map((view) => bridge().listConsoles(view.id)));
  const saved = listed.reduce((total, answer) => total + (answer.ok ? answer.value.length : 0), 0);
  const files = saved === 0 ? "" : ` ${one ? "Its" : "Their"} ${plural(saved, "saved console file")} will be deleted.`;
  const secrets = views.some((view) => view.storedSecrets.length > 0)
    ? ` ${one ? "Its saved password is" : "Their saved passwords are"} removed too.`
    : "";
  const history = views.length === 0 ? "" : one ? HISTORY_DELETED : HISTORIES_DELETED;
  const confirmed = await useModal.getState().ask({
    kind: "confirm",
    title: views.length === 0 ? "Delete Folder" : "Delete Data Source",
    message: `${deleteQuestion(views, folders)}${secrets}${closing}${files}${history}`,
    confirm: "Delete",
    destructive: true,
  });
  if (confirmed === null) return;
  const adminIds = Object.entries(useKeyAdmin.getState().tabs)
    .filter(([, tab]) => ids.includes(tab.datasourceId))
    .map(([id]) => id);
  if (!(await settleAdminRenewals(adminIds, one ? "delete this data source" : "delete these data sources"))) return;
  // Main broadcasts the new list; `wireStores` closes the consoles when it arrives.
  await settle(
    views.length + folders.length === 1 ? "Could not delete the data source" : "Could not delete the selection",
    bridge().deleteDatasources({ ids, folders }),
  );
}

export async function deleteDatasource(view: DatasourceView): Promise<void> {
  await deleteItems([{ kind: "datasource", id: view.id }]);
}

function renameEverywhere(renamed: ReadonlyMap<string, string>): void {
  useDatasources.getState().renameFolders(renamed);
  useCatalog.getState().renameFolders(renamed);
}

/**
 * Asks main to apply one move (plan 136). The renderer renames its folder state first, from the
 * same `arrange` main runs: main's new list arrives before its answer, and would otherwise find the
 * selected and collapsed folders gone.
 */
export async function moveItems(request: MoveRequest): Promise<boolean> {
  const { datasources, folders } = useDatasources.getState();
  let renamed: ReadonlyMap<string, string> = new Map();
  try {
    renamed = arrange(arrangeTreeOf(datasources, folders), request).renamed;
  } catch {
    // Main refuses it too, and says why.
  }
  renameEverywhere(renamed);
  const moved = await settle("Could not move", bridge().moveDatasources(request));
  if (moved === null) renameEverywhere(new Map([...renamed].map(([from, to]) => [to, from])));
  return moved !== null;
}

/** The folder the items share, as Move to Folder… starts from; empty when they share none. */
function sharedFolder(items: readonly TreeItemRef[]): string {
  const { datasources, folders } = useDatasources.getState();
  return commonParent(arrangeTreeOf(datasources, folders), items) ?? "";
}

export async function askMoveToFolder(selected: readonly TreeItemRef[]): Promise<void> {
  const { datasources, folders } = useDatasources.getState();
  const items = topmostItems(selected, arrangeTreeOf(datasources, folders).datasources);
  if (items.length === 0) return;
  const [only] = items;
  const folder = await useModal.getState().ask({
    kind: "text",
    title: "Move to Folder",
    label: items.length === 1 && only?.kind === "folder" ? `Move "${folderName(only.path)}" into` : "Folder",
    initial: sharedFolder(items),
    confirm: "Move",
    placeholder: "Empty for the top level; / nests, as in Docker/Main",
  });
  if (folder === null) return;
  const trimmed = folder.trim().replace(/^\/+|\/+$/g, "");
  let destination: string | null = null;
  if (trimmed !== "") {
    destination = await settle("Could not create the folder", bridge().createDatasourceFolder(trimmed));
    if (destination === null) return;
  }
  await moveItems({ items, folder: destination, before: null });
}

export async function askNewFolder(parent: string | null): Promise<void> {
  const name = await useModal.getState().ask({
    kind: "text",
    title: "New Folder",
    label: parent === null ? "Folder" : `Folder in ${parent}`,
    initial: "",
    confirm: "Create",
  });
  const trimmed = name?.trim().replace(/^\/+|\/+$/g, "") ?? "";
  if (trimmed === "") return;
  const created = await settle(
    "Could not create the folder",
    bridge().createDatasourceFolder(parent === null ? trimmed : `${parent}/${trimmed}`),
  );
  if (created === null) return;
  const opened = parentFolder(created);
  if (opened !== null) useCatalog.getState().expandFolder(opened);
  useDatasources.getState().select({ kind: "folder", path: created });
}

/**
 * Saves which top-level namespaces the Database pane shows (decision 117); undefined shows them
 * all. Its secrets stay as they are. Whether it saved, so a dialog stays open on a failure.
 */
export async function setShownNamespaces(
  view: DatasourceView,
  shownNamespaces: readonly string[] | undefined,
): Promise<boolean> {
  const { storedSecrets: _stored, ephemeral: _ephemeral, shownNamespaces: _previous, ...datasource } = view;
  const saved = await settle(
    "Could not save the shown schemas",
    bridge().saveDatasource({
      datasource: { ...datasource, ...(shownNamespaces === undefined ? {} : { shownNamespaces }) },
      secrets: {},
    }),
  );
  return saved !== null;
}
