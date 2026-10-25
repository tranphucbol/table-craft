import type {
  CatalogObject,
  DdlScript,
  Namespace,
  NamespaceCatalog,
  ObjectChange,
  ObjectFeatures,
  ObjectKind,
  TableDesign,
} from "@table-craft/desktop/engine/protocol.js";
import type { ActionContext } from "@table-craft/desktop/renderer/actions/context.js";
import { openConsole } from "@table-craft/desktop/renderer/actions/consoleCommands.js";
import { revealInDatabase } from "@table-craft/desktop/renderer/actions/explorerActions.js";
import { defineAction, type AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import { settlePendingEdits } from "@table-craft/desktop/renderer/actions/tableCommands.js";
import { emptyDesign, scriptText } from "@table-craft/desktop/renderer/model/tableDesign.js";
import { pathKey, relationKey, routineKey, sequenceKey } from "@table-craft/desktop/renderer/model/explorerTree.js";
import { useCatalog } from "@table-craft/desktop/renderer/state/catalog.js";
import { capabilitiesOf, datasourceById, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { OBJECT_CHOICES, parseObjectAnswer, useModal } from "@table-craft/desktop/renderer/state/modal.js";
import { featuresOf } from "@table-craft/desktop/renderer/state/objects.js";
import { toError } from "@table-craft/desktop/renderer/state/resultWindows.js";
import { useTables } from "@table-craft/desktop/renderer/state/tables.js";
import { useTabs } from "@table-craft/desktop/renderer/state/tabs.js";
import { selectedKey } from "@table-craft/desktop/renderer/actions/keyActions.js";
import { deleteKey, renameKey } from "@table-craft/desktop/renderer/actions/keyEditActions.js";
import type { OpenKeyArgs } from "@table-craft/desktop/renderer/palette/keysProvider.js";

export const OBJECT_ACTION_IDS = {
  newTable: "explorer.newTable",
  newSchema: "explorer.newSchema",
  newDatabase: "explorer.newDatabase",
  modifyTable: "explorer.modifyTable",
  rename: "explorer.renameObject",
  truncate: "explorer.truncateTable",
  drop: "explorer.dropObject",
} as const;

const OBJECTS = "objects";

/** The tree's selected key, when its datasource takes changes: Rename and Drop act on keys too (plan 058). */
function writableKey(context: ActionContext): OpenKeyArgs | null {
  return context.datasource?.view.readOnly === true ? null : selectedKey(context);
}
const NEW_TABLE_NAME = "new_table";
const ROW_COUNT_WHERE = "";

const KIND_LABELS: Readonly<Record<ObjectKind, string>> = {
  table: "table",
  view: "view",
  materializedView: "materialized view",
  sequence: "sequence",
  function: "function",
  procedure: "procedure",
};

/** A writable datasource whose plugin declares `objects`, once its features are known. */
interface Editable {
  readonly datasourceId: string;
  readonly features: ObjectFeatures;
  readonly highlight: string | undefined;
}

function editable(datasourceId: string): Editable | null {
  const state = useDatasources.getState();
  const view = datasourceById(state, datasourceId);
  if (view === undefined || view.readOnly) return null;
  if (!capabilitiesOf(state.plugins, view.pluginId).includes(OBJECTS)) return null;
  const features = featuresOf(datasourceId);
  if (features === null) return null;
  const highlight = state.plugins.find((plugin) => plugin.id === view.pluginId)?.highlight ?? undefined;
  return { datasourceId, features, highlight };
}

function namespacesOf(datasourceId: string): readonly Namespace[] {
  return useCatalog.getState().catalogs[datasourceId]?.namespaces ?? [];
}

function namespaceAt(datasourceId: string, path: readonly string[]): Namespace | undefined {
  const key = pathKey(path);
  return namespacesOf(datasourceId).find((candidate) => pathKey(candidate.path) === key);
}

function describedAt(datasourceId: string, path: readonly string[]): NamespaceCatalog | null {
  return useCatalog.getState().catalogs[datasourceId]?.namespaceStates[pathKey(path)]?.described?.catalog ?? null;
}

/** The selected schema, or a group in it, a new table can go in. */
function schemaTarget(context: ActionContext): (Editable & { readonly path: readonly string[] }) | null {
  const { selection } = context;
  if (selection?.kind !== "catalog" || selection.name !== null) return null;
  if (namespaceAt(selection.id, selection.path)?.kind !== "schema") return null;
  const target = editable(selection.id);
  return target === null ? null : { ...target, path: selection.path };
}

/**
 * Where New Schema or New Database puts the namespace: inside the selected database, beside the
 * selected schema, or at the top of a datasource whose namespaces are databases.
 */
function namespaceTarget(
  context: ActionContext,
  kind: "schema" | "database",
): (Editable & { readonly path: readonly string[] }) | null {
  const { selection } = context;
  if (selection === null || selection.kind === "folder") return null;
  const target = editable(selection.id);
  if (target?.features.namespaceKind !== kind) return null;
  if (selection.kind === "datasource") return kind === "database" ? { ...target, path: [] } : null;
  if (selection.name !== null) return null;
  const namespace = namespaceAt(selection.id, selection.path);
  if (namespace === undefined) return null;
  if (kind === "database") return { ...target, path: [] };
  return { ...target, path: namespace.kind === "database" ? namespace.path : namespace.path.slice(0, -1) };
}

/** The selected relation, routine or sequence, as the object editor names it. */
interface SelectedObject extends Editable {
  readonly path: readonly string[];
  readonly object: CatalogObject;
}

function selectedObject(context: ActionContext): SelectedObject | null {
  const { selection } = context;
  if (selection?.kind !== "catalog" || selection.name === null) return null;
  const target = editable(selection.id);
  const described = describedAt(selection.id, selection.path);
  if (target === null || described === null) return null;
  const { id, path, name, key } = selection;
  const found = (kind: ObjectKind | undefined): SelectedObject | null =>
    kind === undefined ? null : { ...target, path, object: { kind, name } };
  if (key === relationKey(id, path, name)) {
    return found(described.relations.find((relation) => relation.name === name)?.kind);
  }
  const routine = described.routines.find((candidate) => key === routineKey(id, path, candidate));
  if (routine !== undefined) return found(routine.kind);
  if (key === sequenceKey(id, path, name) && described.sequences.some((sequence) => sequence.name === name)) {
    return found("sequence");
  }
  return null;
}

function selectedTable(context: ActionContext): SelectedObject | null {
  const target = selectedObject(context);
  return target?.object.kind === "table" ? target : null;
}

function qualified(path: readonly string[], name: string): string {
  return [...path, name].join(".");
}

function client(datasourceId: string) {
  return useDatasources.getState().connect(datasourceId);
}

function scriptFor(datasourceId: string, change: ObjectChange): Promise<DdlScript> {
  return client(datasourceId).then((engine) => engine.call("objects.script", { change }));
}

async function notice(title: string, cause: unknown): Promise<void> {
  const error = toError(cause);
  await useModal.getState().ask({ kind: "notice", title, message: error.message, hint: error.hint });
}

/** The table tabs showing `relation`, by tab id. */
function tablesShowing(datasourceId: string, path: readonly string[], relation: string): readonly string[] {
  const key = pathKey(path);
  return Object.entries(useTables.getState().tables)
    .filter(
      ([, session]) =>
        session.datasourceId === datasourceId && pathKey(session.path) === key && session.relation === relation,
    )
    .map(([id]) => id);
}

function closeTables(ids: readonly string[]): void {
  for (const id of ids) {
    useTabs.getState().close(id);
    useTables.getState().close(id);
  }
}

/** The change's table editors: gone with the table, or holding rows and columns that changed. */
function tableTabsAfter(datasourceId: string, change: ObjectChange): string | null {
  if (change.kind === "drop" || change.kind === "rename") {
    if (change.object.kind !== "table") return null;
    const ids = tablesShowing(datasourceId, change.path, change.object.name);
    if (ids.length === 0) return null;
    closeTables(ids);
    return change.kind === "drop"
      ? `The editor showing ${change.object.name} was closed, since the table is gone.`
      : `The editor showing ${change.object.name} was closed; open ${change.name} to see its rows.`;
  }
  if (change.kind === "truncate" || change.kind === "alterTable") {
    for (const id of tablesShowing(datasourceId, change.path, change.relation)) void useTables.getState().query(id);
  }
  return null;
}

/** What the tree should select once the change is applied, with its kind for the reveal. */
function landing(change: ObjectChange, design: TableDesign | null): CatalogObject | null {
  switch (change.kind) {
    case "createTable":
    case "alterTable":
      return { kind: "table", name: design?.name ?? change.design.name };
    case "rename":
      return { ...change.object, name: change.name };
    case "truncate":
      return { kind: "table", name: change.relation };
    default:
      return null;
  }
}

function isRelationKind(kind: ObjectKind): kind is "table" | "view" | "materializedView" {
  return kind === "table" || kind === "view" || kind === "materializedView";
}

/**
 * Runs what the dialog answered: Open in Console pastes the script into a new console; Apply hands
 * the previewed statements to the engine, which runs them only if its own script is the same, then
 * reads the namespace again and selects the object.
 */
async function carryOut(
  context: ActionContext,
  datasourceId: string,
  answer: string | null,
  changeOf: (design: TableDesign | null, cascade: boolean) => ObjectChange,
): Promise<void> {
  if (answer === null) return;
  const chosen = parseObjectAnswer(answer);
  if (chosen.choice === OBJECT_CHOICES.console) {
    await openConsole(datasourceId, scriptText(chosen.script));
    return;
  }
  const change = changeOf(chosen.design, chosen.cascade);
  try {
    const engine = await client(datasourceId);
    await engine.call("objects.apply", { change, statements: chosen.script.statements });
  } catch (cause) {
    await notice("Could not change the database", cause);
    return;
  }
  const closed = tableTabsAfter(datasourceId, change);
  const catalog = useCatalog.getState();
  if (change.kind === "createNamespace") await catalog.synchronize(datasourceId, null);
  else await catalog.synchronize(datasourceId, change.path);
  const target = landing(change, chosen.design);
  if (target !== null && isRelationKind(target.kind)) {
    revealInDatabase(context, { datasourceId, path: change.path, name: target.name, kind: target.kind });
  }
  if (closed !== null) {
    await useModal
      .getState()
      .ask({ kind: "notice", tone: "info", title: "Table editor closed", message: closed, hint: "" });
  }
}

async function designTable(
  context: ActionContext,
  target: Editable & { readonly path: readonly string[] },
  relation: string | null,
): Promise<void> {
  let initial: TableDesign;
  try {
    initial =
      relation === null
        ? emptyDesign(NEW_TABLE_NAME, target.features.types)
        : await (await client(target.datasourceId)).call("objects.design", { path: target.path, relation });
  } catch (cause) {
    await notice("Could not read the table", cause);
    return;
  }
  const described = describedAt(target.datasourceId, target.path);
  const targets = (described?.relations ?? [])
    .filter((candidate) => candidate.kind === "table")
    .map((candidate) => ({ name: candidate.name, columns: candidate.columns.map((column) => column.name) }));
  const changeOf = (design: TableDesign): ObjectChange =>
    relation === null
      ? { kind: "createTable", path: target.path, design }
      : { kind: "alterTable", path: target.path, relation, design };
  const answer = await useModal.getState().ask({
    kind: "tableDesign",
    title: relation === null ? "New Table" : `Modify Table ${relation}`,
    note:
      relation === null
        ? `In ${target.path.join(".")}.`
        : `${qualified(target.path, relation)}: only what changed is altered.`,
    initial,
    features: target.features,
    path: target.path,
    targets,
    preview: (design) => scriptFor(target.datasourceId, changeOf(design)),
    highlight: target.highlight,
  });
  await carryOut(context, target.datasourceId, answer, (design) => changeOf(design ?? initial));
}

async function rowsOf(target: SelectedObject): Promise<string> {
  try {
    const engine = await client(target.datasourceId);
    const count = await engine.call("table.count", {
      path: target.path,
      relation: target.object.name,
      where: ROW_COUNT_WHERE,
    });
    return `${count.toLocaleString()} ${count === 1 ? "row" : "rows"}`;
  } catch {
    return "rows not counted";
  }
}

async function destroy(context: ActionContext, target: SelectedObject, kind: "drop" | "truncate"): Promise<void> {
  const { datasourceId, path, object, features } = target;
  const name = qualified(path, object.name);
  const isTable = object.kind === "table";
  if (isTable && kind === "drop") {
    if (!(await settlePendingEdits(tablesShowing(datasourceId, path, object.name), "close"))) return;
  }
  const rows = isTable ? await rowsOf(target) : null;
  const changeOf = (cascade: boolean): ObjectChange =>
    kind === "drop"
      ? { kind: "drop", path, object, cascade }
      : { kind: "truncate", path, relation: object.name, cascade };
  const label = KIND_LABELS[object.kind];
  const answer = await useModal.getState().ask({
    kind: "objectChange",
    title: kind === "drop" ? `Drop ${label}` : "Truncate table",
    message:
      kind === "drop"
        ? `The ${label} and everything in it will be gone. This cannot be undone.`
        : "Every row will be deleted. This cannot be undone.",
    items: [{ label: name, detail: rows ?? label }],
    confirm: kind === "drop" ? "Drop" : "Truncate",
    destructive: true,
    cascade: features.cascade ? false : null,
    preview: (cascade) => scriptFor(datasourceId, changeOf(cascade)),
    highlight: target.highlight,
  });
  await carryOut(context, datasourceId, answer, (_design, cascade) => changeOf(cascade));
}

async function rename(context: ActionContext, target: SelectedObject): Promise<void> {
  const { datasourceId, path, object } = target;
  const label = KIND_LABELS[object.kind];
  const name = await useModal.getState().ask({
    kind: "text",
    title: `Rename ${label}`,
    label: `New name for ${qualified(path, object.name)}`,
    initial: object.name,
    confirm: "Preview",
  });
  if (name === null || name.trim() === "" || name.trim() === object.name) return;
  const change: ObjectChange = { kind: "rename", path, object, name: name.trim() };
  const answer = await useModal.getState().ask({
    kind: "objectChange",
    title: `Rename ${label}`,
    message: `${qualified(path, object.name)} becomes ${qualified(path, change.name)}.`,
    confirm: "Rename",
    destructive: false,
    cascade: null,
    preview: () => scriptFor(datasourceId, change),
    highlight: target.highlight,
  });
  await carryOut(context, datasourceId, answer, () => change);
}

async function newNamespace(
  context: ActionContext,
  target: Editable & { readonly path: readonly string[] },
  kind: "schema" | "database",
): Promise<void> {
  const where = target.path.length === 0 ? "" : ` in ${target.path.join(".")}`;
  const name = await useModal.getState().ask({
    kind: "text",
    title: kind === "schema" ? "New Schema" : "New Database",
    label: `Name of the ${kind}${where}`,
    initial: "",
    confirm: "Preview",
  });
  if (name === null || name.trim() === "") return;
  const change: ObjectChange = { kind: "createNamespace", path: target.path, name: name.trim() };
  const answer = await useModal.getState().ask({
    kind: "objectChange",
    title: kind === "schema" ? "New Schema" : "New Database",
    message: `Creates the ${kind} ${change.name}${where}.`,
    confirm: "Create",
    destructive: false,
    cascade: null,
    preview: () => scriptFor(target.datasourceId, change),
    highlight: target.highlight,
  });
  await carryOut(context, target.datasourceId, answer, () => change);
}

export const OBJECT_ACTIONS: readonly AnyAction[] = [
  defineAction({
    id: OBJECT_ACTION_IDS.newTable,
    title: "New Table…",
    category: "Database",
    icon: "add",
    when: (context) => schemaTarget(context) !== null,
    run: async (context) => {
      const target = schemaTarget(context);
      if (target !== null) await designTable(context, target, null);
    },
  }),
  defineAction({
    id: OBJECT_ACTION_IDS.newSchema,
    title: "New Schema…",
    category: "Database",
    icon: "add",
    when: (context) => namespaceTarget(context, "schema") !== null,
    run: async (context) => {
      const target = namespaceTarget(context, "schema");
      if (target !== null) await newNamespace(context, target, "schema");
    },
  }),
  defineAction({
    id: OBJECT_ACTION_IDS.newDatabase,
    title: "New Database…",
    category: "Database",
    icon: "add",
    when: (context) => namespaceTarget(context, "database") !== null,
    run: async (context) => {
      const target = namespaceTarget(context, "database");
      if (target !== null) await newNamespace(context, target, "database");
    },
  }),
  defineAction({
    id: OBJECT_ACTION_IDS.modifyTable,
    title: "Modify Table…",
    category: "Database",
    icon: "properties",
    shortcut: "Mod+F6",
    shortcutRegion: "database",
    when: (context) => selectedTable(context) !== null,
    run: async (context) => {
      const target = selectedTable(context);
      if (target !== null) await designTable(context, target, target.object.name);
    },
  }),
  defineAction({
    id: OBJECT_ACTION_IDS.rename,
    title: "Rename…",
    category: "Database",
    shortcut: "Shift+F6",
    shortcutRegion: "database",
    when: (context) => {
      if (writableKey(context) !== null) return true;
      const target = selectedObject(context);
      return target !== null && target.features.renamable.includes(target.object.kind);
    },
    run: async (context) => {
      const key = writableKey(context);
      if (key !== null) {
        await renameKey(context, key);
        return;
      }
      const target = selectedObject(context);
      if (target !== null && target.features.renamable.includes(target.object.kind)) await rename(context, target);
    },
  }),
  defineAction({
    id: OBJECT_ACTION_IDS.truncate,
    title: "Truncate…",
    category: "Database",
    when: (context) => selectedTable(context)?.features.truncate === true,
    run: async (context) => {
      const target = selectedTable(context);
      if (target?.features.truncate === true) await destroy(context, target, "truncate");
    },
  }),
  defineAction({
    id: OBJECT_ACTION_IDS.drop,
    title: "Drop…",
    category: "Database",
    icon: "delete",
    shortcut: "Mod+Backspace",
    shortcutRegion: "database",
    when: (context) => {
      if (writableKey(context) !== null) return true;
      const target = selectedObject(context);
      return target !== null && target.features.droppable.includes(target.object.kind);
    },
    run: async (context) => {
      const key = writableKey(context);
      if (key !== null) {
        await deleteKey(key);
        return;
      }
      const target = selectedObject(context);
      if (target !== null && target.features.droppable.includes(target.object.kind)) {
        await destroy(context, target, "drop");
      }
    },
  }),
];
