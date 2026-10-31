import type { Logger } from "@table-craft/desktop/log/record.js";
import type { McpStatus } from "@table-craft/desktop/settings/mcp.js";
import {
  newlyWaiting,
  noticeFor,
  waitingCount,
  waitingKeys,
  type McpNotice,
} from "@table-craft/desktop/settings/mcpNotice.js";

export interface NoticeHandle {
  close(): void;
}

/** Electron is reached only through these, so the behaviour is testable without it. */
export interface McpNoticesOptions {
  /** `settings.mcp.notifications`. */
  readonly enabled: () => boolean;
  /** Whether a TableCraft window has focus; it shows the amber chip, so no notice is posted. */
  readonly focused: () => boolean;
  readonly supported: () => boolean;
  readonly show: (notice: McpNotice, onClick: () => void) => NoticeHandle;
  readonly setBadge: (count: number) => void;
  /** Brings a window forward and opens what the notice announced. */
  readonly reveal: (opens: McpNotice["opens"]) => void;
  readonly now?: () => number;
  readonly log: Logger;
}

export interface McpNotices {
  statusChanged(status: McpStatus): void;
  windowFocused(): void;
  settingsChanged(): void;
}

interface LiveNotice {
  readonly handle: NoticeHandle;
  readonly keys: readonly string[];
}

/**
 * One system notification at a time while an agent waits and TableCraft is in the background
 * (decision 143). It is posted only when something new starts waiting, so an unchanged set never
 * notifies twice, and closed once nothing it announced still waits.
 */
export function createMcpNotices(options: McpNoticesOptions): McpNotices {
  const now = options.now ?? Date.now;
  let latest: McpStatus | null = null;
  let live: LiveNotice | null = null;
  let unsupportedLogged = false;

  function close(): void {
    live?.handle.close();
    live = null;
  }

  function updateBadge(): void {
    options.setBadge(latest !== null && options.enabled() ? waitingCount(latest) : 0);
  }

  function post(status: McpStatus): void {
    if (!options.supported()) {
      if (!unsupportedLogged)
        options.log.info("notifications unsupported; the dock badge alone shows waiting requests");
      unsupportedLogged = true;
      return;
    }
    const notice = noticeFor(status, now());
    if (notice === null) return;
    close();
    const handle = options.show(notice, () => {
      options.reveal(notice.opens);
      if (live?.handle === handle) close();
    });
    live = { handle, keys: notice.keys };
  }

  return {
    statusChanged(status) {
      const arrived = latest === null ? waitingKeys(status) : newlyWaiting(latest, status);
      latest = status;
      updateBadge();
      if (!options.enabled()) return close();
      const waiting = new Set(waitingKeys(status));
      if (live !== null && !live.keys.some((key) => waiting.has(key))) close();
      if (arrived.length > 0 && !options.focused()) post(status);
    },
    windowFocused() {
      close();
    },
    settingsChanged() {
      updateBadge();
      if (!options.enabled()) close();
    },
  };
}
