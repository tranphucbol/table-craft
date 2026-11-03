import { useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { NOTICE_ACTION_IDS } from "@table-craft/desktop/renderer/actions/noticeActions.js";
import { NoticesPopover } from "@table-craft/desktop/renderer/shell/NoticesPopover.js";
import { buttonShape, OPEN_ON_FRAME } from "@table-craft/desktop/renderer/shell/Stripe.js";
import { useNotices } from "@table-craft/desktop/renderer/state/notices.js";
import { useIslands } from "@table-craft/desktop/renderer/state/settings.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { ACTION_ICONS } from "@table-craft/desktop/renderer/ui/icons.js";
import type { PopoverAnchor } from "@table-craft/desktop/renderer/ui/Popover.js";
import { Tooltip } from "@table-craft/desktop/renderer/ui/Tooltip.js";

const TITLE = "Notifications";

function label(unread: number): string {
  return unread === 0 ? TITLE : `${TITLE}, ${String(unread)} new`;
}

/**
 * The bell under MCP Server Settings on the right stripe (plan 145, decision 151). A blue dot marks
 * unread notices and plays a short halo when one arrives; the bell never opens by itself.
 */
export function NotificationBell() {
  const islands = useIslands();
  const open = useNotices((state) => state.open);
  const unread = useNotices((state) => state.unread.length);
  const arrival = useNotices((state) => state.arrival);
  const button = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<PopoverAnchor | null>(null);

  useLayoutEffect(() => {
    if (!open || button.current === null) {
      setAnchor(null);
      return;
    }
    const { left, top, right, bottom } = button.current.getBoundingClientRect();
    setAnchor({ left, top, right, bottom });
  }, [open]);

  const Icon = ACTION_ICONS.bell;
  const text = label(unread);
  return (
    <>
      <Tooltip label={text}>
        <button
          ref={button}
          type="button"
          data-testid="notification-bell"
          aria-label={text}
          aria-haspopup="dialog"
          aria-expanded={open}
          className={cn(
            "relative flex size-tab items-center justify-center",
            buttonShape(islands),
            open ? (islands ? OPEN_ON_FRAME : "bg-raised text-ink") : "text-ink-muted hover:bg-hover hover:text-ink",
          )}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => invoke(NOTICE_ACTION_IDS.show)}
        >
          <Icon aria-hidden className="size-icon" />
          {unread === 0 ? null : (
            <span aria-hidden className="pointer-events-none absolute top-1 right-1 flex size-2">
              <span key={arrival} data-testid="notification-dot" className="size-2 rounded-full bg-accent halo-burst" />
            </span>
          )}
        </button>
      </Tooltip>
      {open && anchor !== null ? <NoticesPopover anchor={anchor} /> : null}
    </>
  );
}
