import { APP_ACTIONS } from "@table-craft/desktop/renderer/actions/appActions.js";
import { ADMIN_ACTIONS } from "@table-craft/desktop/renderer/keyAdmin/actions.js";
import { WATCH_ACTIONS } from "@table-craft/desktop/renderer/watch/actions.js";
import { CONSOLE_INTENT_ACTIONS } from "@table-craft/desktop/renderer/keyAdmin/consoleIntents.js";
import { COMMAND_TXN_ACTIONS } from "@table-craft/desktop/renderer/actions/commandTxnActions.js";
import { DDL_ACTIONS } from "@table-craft/desktop/renderer/actions/ddlActions.js";
import { EDITOR_FIND_ACTIONS } from "@table-craft/desktop/renderer/actions/editorFindActions.js";
import { ERROR_ACTIONS } from "@table-craft/desktop/renderer/actions/errorActions.js";
import { HISTORY_ACTIONS } from "@table-craft/desktop/renderer/actions/historyActions.js";
import { EXPORT_ACTIONS } from "@table-craft/desktop/renderer/actions/exportActions.js";
import { FILE_ACTIONS } from "@table-craft/desktop/renderer/actions/fileActions.js";
import { IMPORT_ACTIONS } from "@table-craft/desktop/renderer/actions/importActions.js";
import { SCRIPT_ACTIONS } from "@table-craft/desktop/renderer/actions/scriptActions.js";
import { GRID_ACTIONS } from "@table-craft/desktop/renderer/actions/gridActions.js";
import { GRID_HELPER_ACTIONS } from "@table-craft/desktop/renderer/actions/gridHelperActions.js";
import { EXPLAIN_ACTIONS } from "@table-craft/desktop/renderer/actions/explainActions.js";
import { EXPLORER_ACTIONS } from "@table-craft/desktop/renderer/actions/explorerActions.js";
import { OBJECT_ACTIONS } from "@table-craft/desktop/renderer/actions/objectActions.js";
import { NAMESPACE_ACTIONS } from "@table-craft/desktop/renderer/actions/namespaceActions.js";
import { NODE_ACTIONS } from "@table-craft/desktop/renderer/actions/nodeActions.js";
import { SERVER_ACTIONS } from "@table-craft/desktop/renderer/actions/serverActions.js";
import { KEY_ACTIONS } from "@table-craft/desktop/renderer/actions/keyActions.js";
import { KEY_EDIT_ACTIONS } from "@table-craft/desktop/renderer/actions/keyEditActions.js";
import { KEY_LEASE_EDITOR_ACTIONS } from "@table-craft/desktop/renderer/actions/keyLeaseEditorActions.js";
import { NAVIGATION_ACTIONS } from "@table-craft/desktop/renderer/actions/navigationActions.js";
import { PLUGIN_ACTIONS } from "@table-craft/desktop/renderer/actions/pluginActions.js";
import type { AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import { MCP_ACTIONS } from "@table-craft/desktop/renderer/actions/mcpActions.js";
import { LOG_ACTIONS } from "@table-craft/desktop/renderer/actions/logActions.js";
import { ROUTINE_ACTIONS } from "@table-craft/desktop/renderer/actions/routineActions.js";
import { SERVICES_ACTIONS } from "@table-craft/desktop/renderer/actions/servicesActions.js";
import { SESSIONS_ACTIONS } from "@table-craft/desktop/renderer/actions/sessionsActions.js";
import { SETTINGS_ACTIONS } from "@table-craft/desktop/renderer/actions/settingsActions.js";
import { SNIPPET_ACTIONS } from "@table-craft/desktop/renderer/actions/snippetActions.js";
import { WINDOW_ACTIONS } from "@table-craft/desktop/renderer/actions/windowActions.js";
import { TABLE_ACTIONS } from "@table-craft/desktop/renderer/actions/tableActions.js";
import { UPDATE_ACTIONS } from "@table-craft/desktop/renderer/actions/updateActions.js";

/** Every action the app registers; the keymap and menu tests check this list. */
export const ALL_ACTIONS: readonly AnyAction[] = [
  ...APP_ACTIONS,
  ...ADMIN_ACTIONS,
  ...WATCH_ACTIONS,
  ...CONSOLE_INTENT_ACTIONS,
  ...COMMAND_TXN_ACTIONS,
  ...ERROR_ACTIONS,
  ...EDITOR_FIND_ACTIONS,
  ...FILE_ACTIONS,
  ...GRID_ACTIONS,
  ...GRID_HELPER_ACTIONS,
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
  ...SERVICES_ACTIONS,
  ...ROUTINE_ACTIONS,
  ...NAMESPACE_ACTIONS,
  ...NODE_ACTIONS,
  ...SERVER_ACTIONS,
  ...KEY_ACTIONS,
  ...KEY_EDIT_ACTIONS,
  ...KEY_LEASE_EDITOR_ACTIONS,
  ...SETTINGS_ACTIONS,
  ...SNIPPET_ACTIONS,
  ...LOG_ACTIONS,
  ...UPDATE_ACTIONS,
  ...PLUGIN_ACTIONS,
  ...MCP_ACTIONS,
  ...WINDOW_ACTIONS,
];
