import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { NOTICE_ACTION_IDS } from "@table-craft/desktop/renderer/actions/noticeActions.js";
import type { Notice } from "@table-craft/desktop/renderer/model/notices.js";
import { useNotices } from "@table-craft/desktop/renderer/state/notices.js";
import { LINK_BUTTON, MUTED_LINK_BUTTON } from "@table-craft/desktop/renderer/ui/linkClasses.js";
import { Popover, type PopoverAnchor } from "@table-craft/desktop/renderer/ui/Popover.js";
import {
  POPOVER_BODY,
  POPOVER_FOOTER,
  POPOVER_HEADER,
  POPOVER_PANEL,
} from "@table-craft/desktop/renderer/ui/popoverParts.js";

/** "Dismiss all" earns its footer only once there is more than one to dismiss (plan 145 ruling 6). */
const DISMISS_ALL_FROM = 2;

function close(): void {
  useNotices.getState().setOpen(false);
}

function NoticeBlock({ notice }: { readonly notice: Notice }) {
  const { action } = notice;
  return (
    <div data-testid={`notice-${notice.id}`} data-kind={notice.kind} className="flex min-w-0 flex-col gap-1">
      <span className="font-semibold whitespace-normal text-ink">{notice.title}</span>
      <span className="whitespace-normal text-ink-muted">{notice.body}</span>
      <div className="-ml-1 flex items-center gap-1">
        {action === null ? null : (
          <button
            type="button"
            data-testid="notice-action"
            className={LINK_BUTTON}
            onClick={() => {
              close();
              invoke(action.actionId, action.args);
              useNotices.getState().ran(notice.id);
            }}
          >
            {action.label}
          </button>
        )}
        <button
          type="button"
          data-testid="notice-dismiss"
          aria-label={`Dismiss ${notice.title}`}
          className={MUTED_LINK_BUTTON}
          onClick={() => useNotices.getState().dismiss(notice.id)}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

/** The bell's list (plan 145 rulings 5-7): at the Popover elevation `ui/Popover` already draws. */
export function NoticesPopover({ anchor }: { readonly anchor: PopoverAnchor }) {
  const notices = useNotices((state) => state.notices);
  return (
    <Popover anchor={anchor} label="Notifications" testId="notices-popover" side="left" focusSelf onClose={close}>
      <div className={POPOVER_PANEL}>
        <div className={POPOVER_HEADER}>Notifications</div>
        <div className={POPOVER_BODY}>
          {notices.length === 0 ? (
            <div data-testid="notices-empty" className="flex flex-col gap-1">
              <span className="text-ink">No notifications</span>
              <span className="whitespace-normal text-ink-muted">
                Updates, connections found in other apps and new features show up here.
              </span>
            </div>
          ) : (
            notices.map((notice) => <NoticeBlock key={notice.id} notice={notice} />)
          )}
        </div>
        {notices.length < DISMISS_ALL_FROM ? null : (
          <div className={POPOVER_FOOTER}>
            <span className="flex-1" />
            <button
              type="button"
              data-testid="notices-dismiss-all"
              className={MUTED_LINK_BUTTON}
              onClick={() => invoke(NOTICE_ACTION_IDS.dismissAll)}
            >
              Dismiss all
            </button>
          </div>
        )}
      </div>
    </Popover>
  );
}
