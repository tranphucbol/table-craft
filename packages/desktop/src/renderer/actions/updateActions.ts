import type { InvokeResult, UpdatePhase } from "@table-craft/desktop/preload/bridge.js";
import { defineAction, type AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import { bridge } from "@table-craft/desktop/renderer/bridge.js";
import { useModal } from "@table-craft/desktop/renderer/state/modal.js";
import { useUpdate } from "@table-craft/desktop/renderer/state/update.js";

export const UPDATE_ACTION_IDS = {
  check: "update.check",
  show: "update.show",
  download: "update.download",
  retry: "update.retry",
  cancel: "update.cancel",
  install: "update.install",
  skip: "update.skip",
  later: "update.later",
  dismiss: "update.dismiss",
  notes: "update.notes",
} as const;

/** The phases the Update button is drawn in (decision 045); idle and checking draw nothing. */
const OFFERING: readonly UpdatePhase[] = ["available", "downloading", "ready", "error", "ineligible"];

function phase(): UpdatePhase {
  return useUpdate.getState().state.phase;
}

function isIn(...phases: readonly UpdatePhase[]): () => boolean {
  return () => phases.includes(phase());
}

async function notice(title: string, message: string, hint: string, tone?: "info"): Promise<void> {
  await useModal.getState().ask({ kind: "notice", title, message, hint, ...(tone === undefined ? {} : { tone }) });
}

async function answered(request: Promise<InvokeResult<unknown>>, failure: string): Promise<void> {
  const answer = await request;
  if (!answer.ok) await notice(failure, answer.error.message, answer.error.hint);
}

/** Help → Check for Updates…: says "up to date" too, and opens the popover for anything else. */
async function checkNow(): Promise<void> {
  useUpdate.getState().setOpen(false);
  const answer = await bridge().updateCheck();
  if (!answer.ok) {
    await notice("Could not check for updates", answer.error.message, answer.error.hint);
    return;
  }
  const state = answer.value;
  if (state.phase === "idle") {
    await notice(
      "You're up to date",
      `TableCraft ${state.current} is the newest version.`,
      "TableCraft also checks every 2 hours while “Check for updates automatically” is on in Settings → Advanced.",
      "info",
    );
    return;
  }
  useUpdate.getState().changed(state);
  if (OFFERING.includes(state.phase)) useUpdate.getState().setOpen(true);
}

function closeAnd(request: () => Promise<InvokeResult<unknown>>, failure: string): () => Promise<void> {
  return async () => {
    useUpdate.getState().setOpen(false);
    await answered(request(), failure);
  };
}

/** The main toolbar's Update button and its popover (plan 020); main decides, these only ask. */
export const UPDATE_ACTIONS: readonly AnyAction[] = [
  defineAction({
    id: UPDATE_ACTION_IDS.check,
    title: "Check for Updates…",
    category: "App",
    icon: "update",
    when: () => phase() !== "checking",
    run: checkNow,
  }),
  defineAction({
    id: UPDATE_ACTION_IDS.show,
    title: "Show Update",
    category: "App",
    icon: "update",
    available: isIn(...OFFERING),
    run: () => useUpdate.getState().setOpen(!useUpdate.getState().open),
  }),
  defineAction({
    id: UPDATE_ACTION_IDS.download,
    title: "Download",
    category: "App",
    icon: "download",
    available: isIn("available"),
    run: closeAnd(() => bridge().updateDownload(), "Could not download the update"),
  }),
  defineAction({
    id: UPDATE_ACTION_IDS.retry,
    title: "Retry",
    category: "App",
    icon: "rerun",
    available: () => {
      const { state } = useUpdate.getState();
      return state.phase === "error" && state.retryable;
    },
    run: closeAnd(() => bridge().updateDownload(), "Could not retry the update"),
  }),
  defineAction({
    id: UPDATE_ACTION_IDS.cancel,
    title: "Cancel Download",
    category: "App",
    icon: "cancel",
    available: isIn("downloading"),
    run: () => answered(bridge().updateCancel(), "Could not cancel the download"),
  }),
  defineAction({
    id: UPDATE_ACTION_IDS.install,
    title: "Restart to Update",
    category: "App",
    icon: "update",
    available: isIn("ready"),
    run: closeAnd(() => bridge().updateInstall(), "Could not install the update"),
  }),
  defineAction({
    id: UPDATE_ACTION_IDS.skip,
    title: "Skip This Version",
    category: "App",
    available: isIn("available", "ready", "ineligible"),
    run: closeAnd(() => bridge().updateSkip(), "Could not skip the version"),
  }),
  defineAction({
    id: UPDATE_ACTION_IDS.later,
    title: "Later",
    category: "App",
    available: isIn("available", "downloading", "ready"),
    run: () => useUpdate.getState().setOpen(false),
  }),
  defineAction({
    id: UPDATE_ACTION_IDS.dismiss,
    title: "Dismiss",
    category: "App",
    available: isIn("error", "ineligible"),
    run: closeAnd(() => bridge().updateDismiss(), "Could not dismiss the update"),
  }),
  defineAction({
    id: UPDATE_ACTION_IDS.notes,
    title: "Release Notes",
    category: "App",
    icon: "goTo",
    available: isIn(...OFFERING),
    run: () => answered(bridge().updateOpenNotes(), "Could not open the release notes"),
  }),
];
