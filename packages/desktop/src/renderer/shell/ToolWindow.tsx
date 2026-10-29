import type { ReactNode } from "react";
import { REGION_ATTRIBUTE } from "@table-craft/desktop/renderer/actions/context.js";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import type { ToolWindowId } from "@table-craft/desktop/renderer/state/layout.js";
import { ActionButton } from "@table-craft/desktop/renderer/ui/ActionButton.js";
import { HideIcon } from "@table-craft/desktop/renderer/ui/icons.js";

export interface ToolWindowProps {
  readonly id: ToolWindowId;
  readonly title: string;
  /** The action that hides it again, run by the header's hide button. */
  readonly toggleActionId: string;
  /** Actions drawn as icon buttons before Hide, as Services' Expand All and Collapse All. */
  readonly actions?: readonly string[];
  readonly children: ReactNode;
}

/** A titled pane docked at an edge; focus inside it makes `Escape` return to the editor. */
export function ToolWindow({ id, title, toggleActionId, actions = [], children }: ToolWindowProps) {
  return (
    <section
      aria-label={title}
      {...{ [REGION_ATTRIBUTE]: id }}
      tabIndex={-1}
      className="flex h-full min-h-0 flex-col bg-panel outline-none"
    >
      <header className="flex h-row shrink-0 items-center justify-between px-gap">
        <h2 className="text-ui font-semibold">{title}</h2>
        <div className="flex items-center">
          {actions.length === 0 ? null : (
            <div role="toolbar" aria-label={`${title} toolbar`} className="flex items-center">
              {actions.map((actionId) => (
                <ActionButton key={actionId} actionId={actionId} compact />
              ))}
            </div>
          )}
          <button
            type="button"
            aria-label={`Hide ${title}`}
            className="flex size-row items-center justify-center rounded text-ink-muted hover:bg-raised hover:text-ink"
            onClick={() => invoke(toggleActionId)}
          >
            <HideIcon aria-hidden className="size-icon" />
          </button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </section>
  );
}
