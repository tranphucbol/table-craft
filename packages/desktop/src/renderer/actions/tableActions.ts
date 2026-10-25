import type { ForeignKey } from "@table-craft/desktop/engine/protocol.js";
import type { ActionContext } from "@table-craft/desktop/renderer/actions/context.js";
import { defineAction, type AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import {
  filterTable,
  openTable,
  reloadTable,
  type OpenTableArgs,
} from "@table-craft/desktop/renderer/actions/tableCommands.js";
import { ACTION_IDS } from "@table-craft/desktop/renderer/actions/appActions.js";
import {
  editableSurfaceOf,
  editSurfaceOf,
  focusedColumn,
  hasEditableSelection,
  heldRows,
  selectedCells,
  selectedRows,
} from "@table-craft/desktop/renderer/actions/resultEditing.js";
import { relationKey } from "@table-craft/desktop/renderer/model/explorerTree.js";
import { useModal } from "@table-craft/desktop/renderer/state/modal.js";
import { usePalette } from "@table-craft/desktop/renderer/state/palette.js";
import { canReload, useTables, type TableSession } from "@table-craft/desktop/renderer/state/tables.js";

export const TABLE_ACTION_IDS = {
  openTable: "table.open",
  openData: "explorer.openData",
  reload: "table.reload",
  revertFilter: "table.revertFilter",
  editCell: "table.editCell",
  setNull: "table.setNull",
  setDefault: "table.setDefault",
  addRow: "table.addRow",
  duplicateRow: "table.duplicateRow",
  deleteRows: "table.deleteRows",
  revertSelected: "table.revertSelected",
  revertAll: "table.revertAll",
  preview: "table.preview",
  submit: "table.submit",
  countRows: "table.countRows",
  filterByValue: "table.filterByValue",
  goToReferenced: "table.goToReferenced",
  showReferencing: "table.showReferencing",
  applyValue: "table.applyValue",
} as const;

/** The grid's cell menu in the data editor; null is a separator. */
export const TABLE_CELL_MENU: readonly (string | null)[] = [
  TABLE_ACTION_IDS.editCell,
  TABLE_ACTION_IDS.setNull,
  TABLE_ACTION_IDS.setDefault,
  null,
  TABLE_ACTION_IDS.addRow,
  TABLE_ACTION_IDS.duplicateRow,
  TABLE_ACTION_IDS.deleteRows,
  TABLE_ACTION_IDS.revertSelected,
  null,
  TABLE_ACTION_IDS.filterByValue,
  TABLE_ACTION_IDS.goToReferenced,
  TABLE_ACTION_IDS.showReferencing,
];

const SUBMIT_REGIONS = ["tableEditor", "grid"] as const;

function tableOf(context: ActionContext): { readonly id: string; readonly session: TableSession } | null {
  if (context.activeTab?.kind !== "table" || context.table === null) return null;
  return { id: context.activeTab.id, session: context.table };
}

/** The foreign key the focused column is part of. */
export function foreignKeyAt(session: TableSession): ForeignKey | null {
  const column = focusedColumn(session);
  const name = column === null ? undefined : session.result?.columns[column]?.name;
  if (name === undefined) return null;
  return session.foreignKeys.find((key) => key.columns.includes(name)) ?? null;
}

/** Each of `names` as its result column, written as the matching name of `written`; null when one is missing. */
function conditionColumns(
  session: TableSession,
  names: readonly string[],
  written: readonly string[],
): readonly { readonly column: number; readonly name: string }[] | null {
  const columns = session.result?.columns ?? [];
  const mapped = names.map((name, index) => ({
    column: columns.findIndex((column) => column.name === name),
    name: written[index] ?? name,
  }));
  return mapped.some((entry) => entry.column < 0) ? null : mapped;
}

function isOpenTableArgs(args: unknown): args is OpenTableArgs {
  return typeof args === "object" && args !== null && "datasourceId" in args && "path" in args && "relation" in args;
}

/** The relation the Database pane's selection is, as Open Data's argument. */
export function selectedRelation(context: ActionContext): OpenTableArgs | null {
  const { selection } = context;
  if (selection?.kind !== "catalog" || selection.name === null) return null;
  if (selection.key !== relationKey(selection.id, selection.path, selection.name)) return null;
  return { datasourceId: selection.id, path: selection.path, relation: selection.name };
}

export const TABLE_ACTIONS: readonly AnyAction[] = [
  defineAction<OpenTableArgs | undefined>({
    id: TABLE_ACTION_IDS.openTable,
    title: "Open Table…",
    category: "Table Editor",
    icon: "table",
    run: async (_context, args) => {
      if (isOpenTableArgs(args)) await openTable(args);
      else usePalette.getState().show("searchEverywhere");
    },
  }),
  defineAction<OpenTableArgs | undefined>({
    id: TABLE_ACTION_IDS.openData,
    title: "Open Data",
    category: "Database",
    icon: "table",
    shortcut: "F4",
    shortcutRegion: "database",
    when: (context) => selectedRelation(context) !== null,
    run: async (context, args) => {
      const target = isOpenTableArgs(args) ? args : selectedRelation(context);
      if (target !== null) await openTable(target);
    },
  }),
  defineAction({
    id: TABLE_ACTION_IDS.reload,
    title: "Reload",
    category: "Table Editor",
    icon: "rerun",
    shortcut: "Mod+R",
    shortcutRegion: "tableEditor",
    tabKind: "table",
    when: (context) => {
      const target = tableOf(context);
      return target !== null && canReload(target.session.status);
    },
    run: async (context) => {
      const target = tableOf(context);
      if (target !== null) await reloadTable(target.id);
    },
  }),
  defineAction({
    id: TABLE_ACTION_IDS.revertFilter,
    title: "Revert Filter",
    category: "Table Editor",
    tabKind: "table",
    when: (context) => {
      const session = tableOf(context)?.session;
      return (
        session !== undefined &&
        (session.draft.where !== session.applied.where ||
          session.draft.orderBy !== session.applied.orderBy ||
          session.queryError !== null)
      );
    },
    run: (context) => {
      const target = tableOf(context);
      if (target !== null) useTables.getState().revertDraft(target.id);
    },
  }),
  defineAction({
    id: TABLE_ACTION_IDS.editCell,
    title: "Edit Cell",
    category: "Table Editor",
    shortcut: "Enter",
    shortcutRegion: "grid",
    when: hasEditableSelection,
    run: (context) => {
      const surface = editableSurfaceOf(context);
      const focus = surface?.target.result?.selection?.focus;
      const column = surface === null ? null : focusedColumn(surface.target);
      if (surface === null || focus === undefined || column === null) return;
      surface.beginEdit({ row: focus.row, column });
    },
  }),
  defineAction({
    id: TABLE_ACTION_IDS.setNull,
    title: "Set NULL",
    category: "Table Editor",
    shortcut: "Mod+Alt+N",
    shortcutRegion: "grid",
    when: hasEditableSelection,
    run: (context) => {
      const surface = editableSurfaceOf(context);
      surface?.setCells(selectedCells(surface.target), { kind: "null" });
    },
  }),
  defineAction({
    id: TABLE_ACTION_IDS.setDefault,
    title: "Set DEFAULT",
    category: "Table Editor",
    shortcut: "Mod+Alt+D",
    shortcutRegion: "grid",
    when: hasEditableSelection,
    run: (context) => {
      const surface = editableSurfaceOf(context);
      surface?.setCells(selectedCells(surface.target), { kind: "default" });
    },
  }),
  defineAction({
    id: TABLE_ACTION_IDS.addRow,
    title: "Add Row",
    category: "Table Editor",
    icon: "add",
    shortcut: "Mod+N",
    shortcutRegion: SUBMIT_REGIONS,
    when: (context) => editableSurfaceOf(context) !== null,
    run: (context) => {
      const surface = editableSurfaceOf(context);
      if (surface === null) return;
      surface.addRow();
      surface.selectLastRow();
    },
  }),
  defineAction({
    id: TABLE_ACTION_IDS.duplicateRow,
    title: "Duplicate Row",
    category: "Table Editor",
    icon: "duplicate",
    shortcut: "Mod+D",
    shortcutRegion: "grid",
    when: hasEditableSelection,
    run: (context) => {
      const surface = editableSurfaceOf(context);
      if (surface === null) return;
      surface.duplicateRows(selectedRows(surface.target));
      surface.selectLastRow();
    },
  }),
  defineAction({
    id: TABLE_ACTION_IDS.deleteRows,
    title: "Delete Rows",
    category: "Table Editor",
    icon: "delete",
    shortcut: "Mod+Backspace",
    shortcutRegion: "grid",
    when: hasEditableSelection,
    run: (context) => {
      const surface = editableSurfaceOf(context);
      surface?.deleteRows(selectedRows(surface.target));
    },
  }),
  defineAction({
    id: TABLE_ACTION_IDS.revertSelected,
    title: "Revert Selected",
    category: "Table Editor",
    icon: "revert",
    shortcut: "Mod+Alt+Z",
    shortcutRegion: "grid",
    when: (context) => hasEditableSelection(context) && (editSurfaceOf(context)?.pending ?? 0) > 0,
    run: (context) => {
      const surface = editableSurfaceOf(context);
      surface?.revert(selectedCells(surface.target));
    },
  }),
  defineAction({
    id: TABLE_ACTION_IDS.revertAll,
    title: "Revert All",
    category: "Table Editor",
    when: (context) => (editSurfaceOf(context)?.pending ?? 0) > 0,
    run: (context) => editSurfaceOf(context)?.revertAll(),
  }),
  defineAction({
    id: TABLE_ACTION_IDS.preview,
    title: "Preview Pending Changes",
    category: "Table Editor",
    icon: "preview",
    shortcut: "Mod+Shift+P",
    shortcutRegion: SUBMIT_REGIONS,
    when: (context) => (editableSurfaceOf(context)?.pending ?? 0) > 0,
    run: async (context) => {
      const surface = editableSurfaceOf(context);
      if (surface === null) return;
      surface.commitEdit();
      const statements = await surface.preview();
      if (statements === null) return;
      const answer = await useModal.getState().ask({
        kind: "statements",
        title: "Pending changes",
        message: surface.submitsAs(statements.length),
        statements,
        terminator: surface.terminator,
        confirm: "Submit",
      });
      if (answer !== null) await surface.submit();
    },
  }),
  defineAction({
    id: TABLE_ACTION_IDS.submit,
    title: "Submit",
    category: "Table Editor",
    icon: "submit",
    shortcut: "Mod+Enter",
    shortcutRegion: SUBMIT_REGIONS,
    // In a console grid ⌘↩ submits while edits are pending and runs the console otherwise (decision 057).
    preempts: [ACTION_IDS.run],
    when: (context) => {
      const surface = editableSurfaceOf(context);
      return surface !== null && (surface.pending > 0 || surface.editing !== null);
    },
    run: async (context) => {
      await editableSurfaceOf(context)?.submit();
    },
  }),
  defineAction({
    id: TABLE_ACTION_IDS.countRows,
    title: "Count Rows",
    category: "Table Editor",
    icon: "count",
    tabKind: "table",
    when: (context) => {
      const session = tableOf(context)?.session;
      return session !== undefined && session.status !== "connecting";
    },
    run: async (context) => {
      const target = tableOf(context);
      if (target !== null) await useTables.getState().countRows(target.id);
    },
  }),
  defineAction({
    id: TABLE_ACTION_IDS.filterByValue,
    title: "Filter by This Value",
    category: "Table Editor",
    icon: "filter",
    tabKind: "table",
    when: (context) => {
      const target = tableOf(context);
      return target !== null && target.session.result?.stale === false && heldRows(target.session).length > 0;
    },
    run: async (context) => {
      const target = tableOf(context);
      const column = target === null ? null : focusedColumn(target.session);
      const name = column === null ? undefined : target?.session.result?.columns[column]?.name;
      if (target === null || column === null || name === undefined) return;
      const store = useTables.getState();
      const condition = await store.condition(target.id, heldRows(target.session), [{ column, name }]);
      if (condition === null) return;
      const { where, orderBy } = target.session.applied;
      const combined = where.trim() === "" ? condition : `(${where.trim()}) AND ${condition}`;
      await filterTable(target.id, { where: combined, orderBy });
    },
  }),
  defineAction({
    id: TABLE_ACTION_IDS.goToReferenced,
    title: "Go to Referenced Row",
    category: "Table Editor",
    icon: "goTo",
    shortcut: "Mod+B",
    shortcutRegion: "grid",
    tabKind: "table",
    when: (context) => {
      const session = tableOf(context)?.session;
      return (
        session !== undefined &&
        session.result?.stale === false &&
        foreignKeyAt(session) !== null &&
        heldRows(session).length > 0
      );
    },
    run: async (context) => {
      const target = tableOf(context);
      const key = target === null ? null : foreignKeyAt(target.session);
      if (target === null || key === null) return;
      const columns = conditionColumns(target.session, key.columns, key.target.columns);
      if (columns === null) return;
      const where = await useTables.getState().condition(target.id, heldRows(target.session), columns);
      if (where === null) return;
      await openTable({
        datasourceId: target.session.datasourceId,
        path: key.target.path,
        relation: key.target.relation,
        where,
      });
    },
  }),
  defineAction({
    id: TABLE_ACTION_IDS.showReferencing,
    title: "Show Referencing Rows…",
    category: "Table Editor",
    icon: "referencing",
    tabKind: "table",
    when: (context) => {
      const session = tableOf(context)?.session;
      return (
        session !== undefined &&
        session.result?.stale === false &&
        session.referencing.length > 0 &&
        heldRows(session).length > 0
      );
    },
    run: async (context) => {
      const target = tableOf(context);
      if (target === null) return;
      const { session } = target;
      const choices = session.referencing.map((referencing, index) => ({
        id: String(index),
        label: `${referencing.relation} (${referencing.foreignKey.columns.join(", ")})`,
      }));
      const answer = await useModal.getState().ask({
        kind: "choice",
        title: "Show referencing rows",
        message: `Open the rows that point at the selected ${heldRows(session).length === 1 ? "row" : "rows"} of ${session.relation}.`,
        choices,
      });
      const chosen = answer === null ? undefined : session.referencing[Number(answer)];
      if (chosen === undefined) return;
      const columns = conditionColumns(session, chosen.foreignKey.target.columns, chosen.foreignKey.columns);
      if (columns === null) return;
      const where = await useTables.getState().condition(target.id, heldRows(session), columns);
      if (where === null) return;
      await openTable({ datasourceId: session.datasourceId, path: chosen.path, relation: chosen.relation, where });
    },
  }),
  defineAction({
    id: TABLE_ACTION_IDS.applyValue,
    title: "Apply Value",
    category: "Table Editor",
    shortcut: "Mod+Enter",
    shortcutRegion: "valuePanel",
    preempts: [ACTION_IDS.run],
    when: (context) => editableSurfaceOf(context)?.panel != null,
    run: (context) => editableSurfaceOf(context)?.applyPanel(),
  }),
];
