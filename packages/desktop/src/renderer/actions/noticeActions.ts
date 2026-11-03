import type { ReleaseNotesRequest } from "@table-craft/desktop/preload/bridge.js";
import { defineAction, type AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import { bridge } from "@table-craft/desktop/renderer/bridge.js";
import { RELEASE_NOTES_ACTION_ID } from "@table-craft/desktop/renderer/model/notices.js";
import { useModal } from "@table-craft/desktop/renderer/state/modal.js";
import { useNotices } from "@table-craft/desktop/renderer/state/notices.js";

export const NOTICE_ACTION_IDS = {
  show: "notifications.show",
  dismissAll: "notifications.dismissAll",
  releaseNotes: RELEASE_NOTES_ACTION_ID,
} as const;

async function openReleaseNotes(request: ReleaseNotesRequest): Promise<void> {
  const answer = await bridge().updateOpenNotes({ version: request.version });
  if (!answer.ok)
    await useModal.getState().ask({ kind: "notice", title: "Could not open the release notes", ...answer.error });
}

/** The bell on the right stripe (plan 145, decision 151): it opens only when asked. */
export const NOTICE_ACTIONS: readonly AnyAction[] = [
  defineAction({
    id: NOTICE_ACTION_IDS.show,
    title: "Notifications",
    category: "App",
    icon: "bell",
    run: () => useNotices.getState().setOpen(!useNotices.getState().open),
  }),
  defineAction({
    id: NOTICE_ACTION_IDS.dismissAll,
    title: "Dismiss All Notifications",
    category: "App",
    when: () => useNotices.getState().notices.length > 0,
    run: () => useNotices.getState().dismissAll(),
  }),
  // Update › Release Notes is there only while an update is offered; this one names the version just installed.
  defineAction<ReleaseNotesRequest>({
    id: NOTICE_ACTION_IDS.releaseNotes,
    title: "Release Notes for This Version",
    category: "App",
    icon: "goTo",
    inPalette: false,
    run: (_context, request) => openReleaseNotes(request),
  }),
];
