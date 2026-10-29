import { createContext, useContext, useSyncExternalStore } from "react";
import { ALL_ACTIONS } from "@table-craft/desktop/renderer/actions/allActions.js";
import { currentContext } from "@table-craft/desktop/renderer/actions/context.js";
import {
  createActionRegistry,
  firstEnabledAction,
  type InvokeOutcome,
} from "@table-craft/desktop/renderer/actions/registry.js";
import { EngineRequestError } from "@table-craft/desktop/renderer/engine/client.js";
import { rendererLog } from "@table-craft/desktop/renderer/log/log.js";
import { useCatalog } from "@table-craft/desktop/renderer/state/catalog.js";
import { useConsoles } from "@table-craft/desktop/renderer/state/consoles.js";
import { useDataSourcesDialog } from "@table-craft/desktop/renderer/state/dataSourcesDialog.js";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useDdl } from "@table-craft/desktop/renderer/state/ddl.js";
import { useLayout } from "@table-craft/desktop/renderer/state/layout.js";
import { useModal } from "@table-craft/desktop/renderer/state/modal.js";
import { useObjects } from "@table-craft/desktop/renderer/state/objects.js";
import { usePalette } from "@table-craft/desktop/renderer/state/palette.js";
import { useHostKeyPrompt } from "@table-craft/desktop/renderer/state/hostKeyPrompt.js";
import { useSecretPrompt } from "@table-craft/desktop/renderer/state/secretPrompt.js";
import { useServicesTree } from "@table-craft/desktop/renderer/state/servicesTree.js";
import { useJsonView } from "@table-craft/desktop/renderer/state/jsonView.js";
import { useSessions } from "@table-craft/desktop/renderer/state/sessions.js";
import { useTabs } from "@table-craft/desktop/renderer/state/tabs.js";
import { useWindowState } from "@table-craft/desktop/renderer/state/windowState.js";
import { useSnippets } from "@table-craft/desktop/renderer/state/snippets.js";
import { useSnippetsDialog } from "@table-craft/desktop/renderer/state/snippetsDialog.js";

/** A visible editor's controls describe its own tab, even while another group has focus. */
export const ActionTabContext = createContext<string | undefined>(undefined);

/** The app's one registry. Everything that runs a command goes through `invoke` (decision 015). */
export const registry = createActionRegistry(currentContext, (id, cause) => {
  const requestId = cause instanceof EngineRequestError ? cause.requestId : null;
  rendererLog("action").error("action failed", { actionId: id, requestId, err: cause });
});
registry.register(ALL_ACTIONS);

export function invoke(id: string, args?: unknown): InvokeOutcome {
  return registry.invoke(id, args);
}

const STORES = [
  useTabs,
  useConsoles,
  useDatasources,
  useCatalog,
  useDdl,
  useLayout,
  usePalette,
  useDataSourcesDialog,
  useSecretPrompt,
  useHostKeyPrompt,
  useModal,
  useObjects,
  useSessions,
  useWindowState,
  useSnippets,
  useSnippetsDialog,
  useServicesTree,
  useJsonView,
] as const;

/** Calls `listener` whenever a store an action's `when` might read changes. */
export function subscribeToActions(listener: () => void): () => void {
  const unsubscribes = STORES.map((store) => store.subscribe(listener));
  return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
}

/** Whether `id` can run now, re-read whenever a store it might depend on changes. */
export function useActionEnabled(id: string): boolean {
  const tabId = useContext(ActionTabContext);
  return useSyncExternalStore(subscribeToActions, () => registry.isEnabled(id, currentContext(tabId)));
}

/** `firstEnabledAction` over `ids`, re-read like `useActionEnabled`. */
export function useFirstEnabledAction(ids: readonly [string, ...string[]]): string {
  const tabId = useContext(ActionTabContext);
  return useSyncExternalStore(subscribeToActions, () => {
    const context = currentContext(tabId);
    return firstEnabledAction(ids, (id) => registry.isEnabled(id, context));
  });
}

/** Whether `id` exists for the active tab at all (its `available`), re-read like `useActionEnabled`. */
export function useActionAvailable(id: string): boolean {
  const tabId = useContext(ActionTabContext);
  return useSyncExternalStore(subscribeToActions, () => registry.isAvailable(id, currentContext(tabId)));
}

/** Whether `id`'s work is under way now (its `busy`), re-read like `useActionEnabled`. */
export function useActionBusy(id: string): boolean {
  const tabId = useContext(ActionTabContext);
  return useSyncExternalStore(subscribeToActions, () => registry.isBusy(id, currentContext(tabId)));
}
