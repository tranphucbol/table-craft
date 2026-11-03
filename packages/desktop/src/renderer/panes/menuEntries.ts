import { ACTION_IDS } from "@table-craft/desktop/renderer/actions/appActions.js";
import { DDL_SCRIPT_ACTION_IDS } from "@table-craft/desktop/renderer/actions/ddlScriptActions.js";
import { IMPORT_ACTION_IDS } from "@table-craft/desktop/renderer/actions/importActions.js";
import { OBJECT_ACTION_IDS } from "@table-craft/desktop/renderer/actions/objectActions.js";
import { SCRIPT_ACTION_IDS } from "@table-craft/desktop/renderer/actions/scriptActions.js";
import { TABLE_ACTION_IDS } from "@table-craft/desktop/renderer/actions/tableActions.js";

/** A nested menu of actions, as DataGrip nests SQL Scripts. */
export interface Submenu {
  readonly label: string;
  readonly items: readonly string[];
}

/** An action id, a separator (null), or a submenu. */
export type MenuEntry = string | null | Submenu;

export const SQL_SCRIPTS_MENU: Submenu = {
  label: "SQL Scripts",
  items: [DDL_SCRIPT_ACTION_IDS.toConsole, DDL_SCRIPT_ACTION_IDS.toClipboard, DDL_SCRIPT_ACTION_IDS.toFile],
};

/** Shown only for a schema, or its Tables, Views and Materialized Views, of a plugin that declares `ddl`. */
export const DDL_SCRIPT_HIDDEN_WHEN_DISABLED: readonly string[] = SQL_SCRIPTS_MENU.items;

export const NAMESPACE_MENU: readonly MenuEntry[] = [
  TABLE_ACTION_IDS.openData,
  ACTION_IDS.newConsole,
  IMPORT_ACTION_IDS.importNewTable,
  SCRIPT_ACTION_IDS.run,
  SQL_SCRIPTS_MENU,
  null,
  OBJECT_ACTION_IDS.newTable,
  OBJECT_ACTION_IDS.newSchema,
  OBJECT_ACTION_IDS.newDatabase,
  null,
  ACTION_IDS.synchronize,
  ACTION_IDS.copyName,
  null,
  ACTION_IDS.toggleSystemSchemas,
  ACTION_IDS.manageShownSchemas,
];

/**
 * The entries to show: items in `hidden` that are disabled left out, a submenu left out when none
 * of its items is left, and no separator doubled or at an end.
 */
export function shownEntries(
  entries: readonly MenuEntry[],
  hidden: ReadonlySet<string>,
  isEnabled: (actionId: string) => boolean,
): readonly MenuEntry[] {
  const kept = (actionId: string) => !hidden.has(actionId) || isEnabled(actionId);
  const shown: MenuEntry[] = [];
  for (const entry of entries) {
    if (entry === null) {
      if (shown.length > 0 && shown[shown.length - 1] !== null) shown.push(null);
      continue;
    }
    if (typeof entry === "string") {
      if (kept(entry)) shown.push(entry);
      continue;
    }
    const items = entry.items.filter(kept);
    if (items.length > 0) shown.push({ label: entry.label, items });
  }
  if (shown[shown.length - 1] === null) shown.pop();
  return shown;
}

/** A string that changes exactly when the shown entries do, for `useSyncExternalStore`. */
export function entriesKey(entries: readonly MenuEntry[]): string {
  return entries
    .map((entry) =>
      entry === null || typeof entry === "string" ? String(entry) : `${entry.label}(${entry.items.join(",")})`,
    )
    .join("\n");
}
