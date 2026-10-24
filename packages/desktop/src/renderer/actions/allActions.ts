import { APP_ACTIONS } from "@table-craft/desktop/renderer/actions/appActions.js";
import { DDL_ACTIONS } from "@table-craft/desktop/renderer/actions/ddlActions.js";
import { HISTORY_ACTIONS } from "@table-craft/desktop/renderer/actions/historyActions.js";
import { EXPORT_ACTIONS } from "@table-craft/desktop/renderer/actions/exportActions.js";
import { FILE_ACTIONS } from "@table-craft/desktop/renderer/actions/fileActions.js";
import { IMPORT_ACTIONS } from "@table-craft/desktop/renderer/actions/importActions.js";
import { SCRIPT_ACTIONS } from "@table-craft/desktop/renderer/actions/scriptActions.js";
import { GRID_ACTIONS } from "@table-craft/desktop/renderer/actions/gridActions.js";
import { EXPLAIN_ACTIONS } from "@table-craft/desktop/renderer/actions/explainActions.js";
import { EXPLORER_ACTIONS } from "@table-craft/desktop/renderer/actions/explorerActions.js";
import { OBJECT_ACTIONS } from "@table-craft/desktop/renderer/actions/objectActions.js";
import { NAMESPACE_ACTIONS } from "@table-craft/desktop/renderer/actions/namespaceActions.js";
import { NAVIGATION_ACTIONS } from "@table-craft/desktop/renderer/actions/navigationActions.js";
import type { AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import { LOG_ACTIONS } from "@table-craft/desktop/renderer/actions/logActions.js";
import { SESSIONS_ACTIONS } from "@table-craft/desktop/renderer/actions/sessionsActions.js";
import { SETTINGS_ACTIONS } from "@table-craft/desktop/renderer/actions/settingsActions.js";
import { WINDOW_ACTIONS } from "@table-craft/desktop/renderer/actions/windowActions.js";
import { TABLE_ACTIONS } from "@table-craft/desktop/renderer/actions/tableActions.js";
import { UPDATE_ACTIONS } from "@table-craft/desktop/renderer/actions/updateActions.js";

/** Every action the app registers; the keymap and menu tests check this list. */
export const ALL_ACTIONS: readonly AnyAction[] = [
  ...APP_ACTIONS,
  ...FILE_ACTIONS,
  ...GRID_ACTIONS,
  ...EXPORT_ACTIONS,
  ...IMPORT_ACTIONS,
  ...SCRIPT_ACTIONS,
  ...EXPLORER_ACTIONS,
  ...OBJECT_ACTIONS,
  ...TABLE_ACTIONS,
  ...NAVIGATION_ACTIONS,
  ...DDL_ACTIONS,
  ...HISTORY_ACTIONS,
  ...EXPLAIN_ACTIONS,
  ...SESSIONS_ACTIONS,
  ...NAMESPACE_ACTIONS,
  ...SETTINGS_ACTIONS,
  ...LOG_ACTIONS,
  ...UPDATE_ACTIONS,
  ...WINDOW_ACTIONS,
];
