import { datasourceById, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useLayout } from "@table-craft/desktop/renderer/state/layout.js";
import { useModal } from "@table-craft/desktop/renderer/state/modal.js";
import { activeTab, groupOf, useTabs, type Tab } from "@table-craft/desktop/renderer/state/tabs.js";
import {
  pendingOf,
  useTables,
  type TableClauses,
  type TableTarget,
} from "@table-craft/desktop/renderer/state/tables.js";
import { pendingText } from "@table-craft/desktop/renderer/model/editBuffer.js";

const TABLE_ID_PREFIX = "table-";
const SUBMIT = "submit";
const DISCARD = "discard";
let tablesOpened = 0;

/** Open Data's argument: the table, and a WHERE to open it filtered with (foreign-key navigation). */
export interface OpenTableArgs extends TableTarget {
  readonly where?: string;
}

function sameTable(a: TableTarget, b: TableTarget): boolean {
  return (
    a.datasourceId === b.datasourceId &&
    a.relation === b.relation &&
    a.path.length === b.path.length &&
    a.path.every((part, index) => part === b.path[index])
  );
}

function newTab(relation: string): Tab {
  return { id: `${TABLE_ID_PREFIX}${String(tablesOpened++)}`, kind: "table", title: relation };
}

/** Whether the datasource's tabs are remembered: an ephemeral one never is (decision 018). */
function persists(datasourceId: string): boolean {
  const view = datasourceById(useDatasources.getState(), datasourceId);
  return view !== undefined && !view.ephemeral;
}

/**
 * Opens the table in the data editor (plan 008 decision 1), or brings its open tab forward; a
 * `where` reads that tab's rows again filtered, once its pending changes are settled.
 */
export async function openTable(args: OpenTableArgs): Promise<void> {
  const { tables } = useTables.getState();
  const existing = Object.entries(tables).find(([, session]) => sameTable(session, args))?.[0];
  if (existing !== undefined) {
    useTabs.getState().activate(existing);
    if (args.where === undefined) return;
    const session = tables[existing];
    await filterTable(existing, { where: args.where, orderBy: session?.applied.orderBy ?? "" });
    return;
  }
  const tab = newTab(args.relation);
  useTabs.getState().open(tab);
  await useTables.getState().open(tab.id, args, { where: args.where });
}

/** Reopens the table tabs the layout remembers, each disconnected until Reload (decision 2). */
export function restoreTables(): void {
  const before = useTabs.getState();
  const selected = before.tabs.map((tab) => ({
    id: tab.id,
    groupId: groupOf(tab),
    selected: before.groupActiveIds[groupOf(tab)] === tab.id,
  }));
  let active: string | null = null;
  for (const entry of useLayout.getState().layout.openTables) {
    if (!persists(entry.datasourceId)) continue;
    const tab = newTab(entry.relation);
    useTabs.getState().open({ ...tab, groupId: entry.groupId ?? "left" });
    void useTables.getState().open(tab.id, entry, { connect: false });
    selected.push({ id: tab.id, groupId: entry.groupId ?? "left", selected: entry.groupActive ?? entry.active });
    if (entry.active) active = tab.id;
  }
  useTabs.getState().restoreGroups(selected);
  const focused = active ?? before.activeId;
  if (focused !== null) useTabs.getState().activate(focused);
}

/** Keeps the layout's list of open table tabs in step with the tab strip. */
export function rememberOpenTables(): () => void {
  const remember = () => {
    const strip = useTabs.getState();
    const current = activeTab(strip)?.id ?? null;
    const { tables } = useTables.getState();
    useLayout.getState().setOpenTables(
      strip.tabs.flatMap((tab) => {
        const session = tables[tab.id];
        if (tab.kind !== "table" || session === undefined || !persists(session.datasourceId)) return [];
        const { datasourceId, path, relation } = session;
        return [
          {
            datasourceId,
            path,
            relation,
            active: tab.id === current,
            groupId: groupOf(tab),
            groupActive: strip.groupActiveIds[groupOf(tab)] === tab.id,
          },
        ];
      }),
    );
  };
  remember();
  const offTabs = useTabs.subscribe(remember);
  const offTables = useTables.subscribe((state, previous) => {
    if (Object.keys(state.tables).length !== Object.keys(previous.tables).length) remember();
  });
  return () => {
    offTabs();
    offTables();
  };
}

/**
 * Asks once whether to submit or discard the pending changes of the table tabs in `tableIds`
 * (plan 008 decision 16), then does it; false when the user cancelled or a submit was rejected.
 */
export async function settlePendingEdits(tableIds: readonly string[], verb: string): Promise<boolean> {
  const { tables } = useTables.getState();
  const pending = tableIds.filter((id) => pendingOf(tables[id]) > 0);
  if (pending.length === 0) return true;
  const tabs = useTabs.getState().tabs;
  const answer = await useModal.getState().ask({
    kind: "choice",
    title: "Pending changes",
    message: `${pending.length === 1 ? "This table has" : "These tables have"} changes not yet submitted. Submit or discard them to ${verb}.`,
    items: pending.map((id) => {
      const session = tables[id];
      const datasource = datasourceById(useDatasources.getState(), session?.datasourceId ?? "");
      const title = tabs.find((tab) => tab.id === id)?.title ?? session?.relation ?? id;
      return {
        label: datasource === undefined ? title : `${title} [${datasource.name}]`,
        detail: pendingText(pendingOf(session)) ?? "",
      };
    }),
    choices: [
      { id: SUBMIT, label: "Submit", variant: "primary" },
      { id: DISCARD, label: "Discard", variant: "danger" },
    ],
  });
  if (answer === null) return false;
  const store = useTables.getState();
  if (answer === DISCARD) {
    for (const id of pending) store.revertAll(id);
    return true;
  }
  const submitted = await Promise.all(pending.map((id) => store.submit(id)));
  return submitted.every(Boolean);
}

/** Reads the rows again with `clauses`, once pending changes are settled. */
export async function filterTable(id: string, clauses: TableClauses): Promise<void> {
  if (!(await settlePendingEdits([id], "read the rows again"))) return;
  await useTables.getState().query(id, clauses);
}

/** Reload, Rerun and Enter in a bar: the bars' text as typed, once pending changes are settled. */
export async function reloadTable(id: string): Promise<void> {
  const session = useTables.getState().tables[id];
  if (session === undefined) return;
  useTables.getState().commitEdit(id);
  await filterTable(id, useTables.getState().tables[id]?.draft ?? session.draft);
}
