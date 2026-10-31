import { app, BrowserWindow, Notification } from "electron";
import { CHANNELS } from "@table-craft/desktop/preload/bridge.js";
import type { Logger } from "@table-craft/desktop/log/record.js";
import { createMcpNotices, type McpNotices } from "@table-craft/desktop/main/mcpNotices.js";
import { MCP_NOTICE_ACTIONS, type McpNotice } from "@table-craft/desktop/settings/mcpNotice.js";

const MAC_PLATFORM = "darwin";
const WINDOWS_PLATFORM = "win32";
/** The `appId` of `electron-builder.yml`; Windows shows no toast from an app without one. */
const APP_USER_MODEL_ID = "dev.table-craft.desktop";

function revealWindow(opens: McpNotice["opens"]): void {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (window === undefined || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  if (process.platform === MAC_PLATFORM) app.focus({ steal: true });
  window.webContents.send(CHANNELS.invokeAction, MCP_NOTICE_ACTIONS[opens]);
}

/** Notifications and the dock badge for waiting agent requests (decision 143), wired to Electron. */
export function createElectronMcpNotices(enabled: () => boolean, log: Logger): McpNotices {
  if (process.platform === WINDOWS_PLATFORM) app.setAppUserModelId(APP_USER_MODEL_ID);
  const notices = createMcpNotices({
    enabled,
    focused: () => BrowserWindow.getFocusedWindow() !== null,
    supported: () => Notification.isSupported(),
    show(notice, onClick) {
      const notification = new Notification({ title: notice.title, body: notice.body });
      notification.on("click", onClick);
      notification.show();
      return notification;
    },
    setBadge: (count) => app.setBadgeCount(count),
    reveal: revealWindow,
    log,
  });
  app.on("browser-window-focus", () => notices.windowFocused());
  return notices;
}
