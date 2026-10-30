import type { DatasourceView, InvokeResult } from "@table-craft/desktop/preload/bridge.js";
import { bridge } from "@table-craft/desktop/renderer/bridge.js";
import { useConsoles } from "@table-craft/desktop/renderer/state/consoles.js";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useModal } from "@table-craft/desktop/renderer/state/modal.js";
import { settleAdminRenewals } from "@table-craft/desktop/renderer/keyAdmin/actions.js";
import { useKeyAdmin } from "@table-craft/desktop/renderer/keyAdmin/store.js";

const HISTORY_DELETED = " Its query history is deleted too.";

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

export async function deleteDatasource(view: DatasourceView): Promise<void> {
  const consoles = Object.values(useConsoles.getState().consoles).filter(
    (session) => session.datasourceId === view.id,
  ).length;
  const closing = consoles === 0 ? "" : ` Its ${plural(consoles, "open console")} will close.`;
  const listed = await bridge().listConsoles(view.id);
  const saved = listed.ok ? listed.value.length : 0;
  const files = saved === 0 ? "" : ` Its ${plural(saved, "saved console file")} will be deleted.`;
  const confirmed = await useModal.getState().ask({
    kind: "confirm",
    title: "Delete Data Source",
    message: `Delete "${view.name}"?${view.storedSecrets.length === 0 ? "" : " Its saved password is removed too."}${closing}${files}${HISTORY_DELETED}`,
    confirm: "Delete",
    destructive: true,
  });
  if (confirmed === null) return;
  const adminIds = Object.entries(useKeyAdmin.getState().tabs)
    .filter(([, tab]) => tab.datasourceId === view.id)
    .map(([id]) => id);
  if (!(await settleAdminRenewals(adminIds, "delete this data source"))) return;
  // Main broadcasts the new list; `wireStores` closes the consoles when it arrives.
  await settle("Could not delete the data source", bridge().deleteDatasource(view.id));
}

/** Saves the datasource with a new folder; its secrets stay as they are. */
export async function moveToFolder(view: DatasourceView, folder: string | null): Promise<void> {
  const { storedSecrets: _stored, ephemeral: _ephemeral, ...datasource } = view;
  await settle(
    "Could not move the data source",
    bridge().saveDatasource({ datasource: { ...datasource, folder }, secrets: {} }),
  );
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

export async function askMoveToFolder(view: DatasourceView): Promise<void> {
  const folder = await useModal.getState().ask({
    kind: "text",
    title: "Move to Folder",
    label: "Folder",
    initial: view.folder ?? "",
    confirm: "Move",
    placeholder: "Empty for the top level; / nests, as in Docker/Main",
  });
  if (folder === null) return;
  const trimmed = folder.trim();
  await moveToFolder(view, trimmed === "" ? null : trimmed);
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
  const path = parent === null ? trimmed : `${parent}/${trimmed}`;
  useDatasources.getState().addFolder(path);
  useDatasources.getState().select({ kind: "folder", path });
}
