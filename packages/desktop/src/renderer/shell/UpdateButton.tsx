import { useLayoutEffect, useRef, useState } from "react";
import { currentPlatform } from "@table-craft/desktop/renderer/actions/chords.js";
import { invoke, useActionAvailable } from "@table-craft/desktop/renderer/actions/index.js";
import { UPDATE_ACTION_IDS } from "@table-craft/desktop/renderer/actions/updateActions.js";
import { updateButton, updatePopover, type UpdateButtonTone } from "@table-craft/desktop/renderer/model/update.js";
import { useUpdate } from "@table-craft/desktop/renderer/state/update.js";
import { ActionButton } from "@table-craft/desktop/renderer/ui/ActionButton.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { ACTION_ICONS } from "@table-craft/desktop/renderer/ui/icons.js";
import { Popover, type PopoverAnchor } from "@table-craft/desktop/renderer/ui/Popover.js";
import { FILLED_PRESS, TEXT_PRESS } from "@table-craft/desktop/renderer/ui/pressClasses.js";
import { Tooltip } from "@table-craft/desktop/renderer/ui/Tooltip.js";

export const TONE_CLASSES: Readonly<Record<UpdateButtonTone, string>> = {
  accent: `${FILLED_PRESS} bg-accent text-accent-ink`,
  neutral: `${TEXT_PRESS} border border-line text-ink hover:bg-raised`,
  danger: `${TEXT_PRESS} border border-danger text-danger hover:bg-raised`,
};

/** The popover's actions, primary first; each shows only while main's state allows it. */
const POPOVER_ACTIONS = [
  UPDATE_ACTION_IDS.download,
  UPDATE_ACTION_IDS.install,
  UPDATE_ACTION_IDS.retry,
  UPDATE_ACTION_IDS.cancel,
  UPDATE_ACTION_IDS.notes,
  UPDATE_ACTION_IDS.skip,
  UPDATE_ACTION_IDS.later,
  UPDATE_ACTION_IDS.dismiss,
] as const;
const PRIMARY_ACTIONS: ReadonlySet<string> = new Set([
  UPDATE_ACTION_IDS.download,
  UPDATE_ACTION_IDS.install,
  UPDATE_ACTION_IDS.retry,
]);

function PopoverAction({ actionId }: { readonly actionId: string }) {
  return useActionAvailable(actionId) ? (
    <ActionButton actionId={actionId} primary={PRIMARY_ACTIONS.has(actionId)} />
  ) : null;
}

function UpdatePopover({ anchor }: { readonly anchor: PopoverAnchor }) {
  const state = useUpdate((store) => store.state);
  const view = updatePopover(state, currentPlatform() === "mac");
  const percent = state.phase === "downloading" ? (updateButton(state)?.percent ?? 0) : null;
  return (
    <Popover anchor={anchor} label="Update" testId="update-popover" onClose={() => useUpdate.getState().setOpen(false)}>
      <div className="flex flex-col gap-gap p-gap">
        <div className="font-semibold">{view.title}</div>
        <div data-testid="update-versions" className="font-mono text-ink-muted">
          {view.versions}
          {view.size === null ? null : <span> · {view.size}</span>}
        </div>
        {percent === null ? null : (
          <div className="h-1 w-full overflow-hidden rounded bg-panel" role="progressbar" aria-valuenow={percent}>
            <div className="h-full bg-accent" style={{ width: `${String(percent)}%` }} />
          </div>
        )}
        {view.message === null ? null : (
          <p data-testid="update-message" className="max-w-popover whitespace-normal wrap-anywhere text-ink-muted">
            {view.message}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-1">
          {POPOVER_ACTIONS.map((id) => (
            <PopoverAction key={id} actionId={id} />
          ))}
        </div>
      </div>
    </Popover>
  );
}

/**
 * The Update button (decision 045): in the main toolbar immediately before Settings, drawn only
 * while main has something to offer, and the one place an update is started from.
 */
export function UpdateButton() {
  const state = useUpdate((store) => store.state);
  const open = useUpdate((store) => store.open);
  const view = updateButton(state);
  const button = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<PopoverAnchor | null>(null);
  const shown = view !== null;

  useLayoutEffect(() => {
    if (!open || button.current === null) {
      setAnchor(null);
      return;
    }
    const { left, top, right, bottom } = button.current.getBoundingClientRect();
    setAnchor({ left, top, right, bottom });
  }, [open, shown]);

  if (view === null) return null;
  const Icon = ACTION_ICONS.update;
  return (
    <>
      <Tooltip label={view.tooltip} side="bottom">
        <button
          ref={button}
          type="button"
          data-testid="update-button"
          data-phase={state.phase}
          aria-haspopup="dialog"
          aria-expanded={open}
          className={cn(
            "app-no-drag flex h-row shrink-0 items-center gap-1 rounded px-gap whitespace-nowrap",
            TONE_CLASSES[view.tone],
          )}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => invoke(UPDATE_ACTION_IDS.show)}
        >
          <Icon aria-hidden weight="fill" className="size-icon" />
          {view.label}
        </button>
      </Tooltip>
      {open && anchor !== null ? <UpdatePopover anchor={anchor} /> : null}
    </>
  );
}
