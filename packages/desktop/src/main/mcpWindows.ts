import { app, BrowserWindow, webContents } from "electron";
import { CHANNELS } from "@table-craft/desktop/preload/bridge.js";
import type { McpUiDelivery, McpUiRequest, McpUiTarget } from "@table-craft/desktop/settings/mcp.js";

const MAC_PLATFORM = "darwin";

/** Restores, shows and focuses the window, taking focus from other apps on macOS. */
export function raiseWindow(window: BrowserWindow): void {
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  if (process.platform === MAC_PLATFORM) app.focus({ steal: true });
}

function windowOf(target: McpUiTarget): BrowserWindow | null {
  if (target === "focused") return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
  const contents = webContents.fromId(target.window);
  return contents === undefined ? null : BrowserWindow.fromWebContents(contents);
}

function wantsFocus(request: McpUiRequest): boolean {
  return "focus" in request && request.focus;
}

/**
 * Hands an agent's UI request to its window (plan 156), raising the window first when the request
 * carries `focus`; false when that window is gone. The host already cleared `focus` when the user
 * does not let agents bring TableCraft forward.
 */
export function askMcpWindow(target: McpUiTarget, delivery: McpUiDelivery): boolean {
  const window = windowOf(target);
  if (window === null || window.isDestroyed()) return false;
  if (wantsFocus(delivery.request)) raiseWindow(window);
  window.webContents.send(CHANNELS.mcpUiRequest, delivery);
  return true;
}
