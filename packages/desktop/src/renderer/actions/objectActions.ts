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
import {
  OBJECT_CHOICES,
  parseMultiPickAnswer,
  parseObjectAnswer,
  useModal,
} from "@table-craft/desktop/renderer/state/modal.js";
import { featuresOf } from "@table-craft/desktop/renderer/state/objects.js";
import { toError } from "@table-craft/desktop/renderer/state/resultWindows.js";
import { useTables } from "@table-craft/desktop/renderer/state/tables.js";
import { useTabs } from "@table-craft/desktop/renderer/state/tabs.js";
import { selectedKey } from "@table-craft/desktop/renderer/actions/keyActions.js";
import { deleteKey, renameKey } from "@table-craft/desktop/renderer/actions/keyEditActions.js";
import {
  copyPostgresDatabase,
  copyPostgresSchema,
  type PostgresCopyMode,
  verifyPostgresData,
  verifyPostgresSchema,
} from "@table-craft/desktop/renderer/actions/postgresCopy.js";
import {
  copyMysqlDatabaseAction,
  verifyMysqlDatabaseAction,
} from "@table-craft/desktop/renderer/actions/mysqlDatabaseActions.js";

import type { OpenKeyArgs } from "@table-craft/desktop/renderer/palette/keysProvider.js";

export const OBJECT_ACTION_IDS = {
  newTable: "explorer.newTable",
  newSchema: "explorer.newSchema",
  newDatabase: "explorer.newDatabase",
  modifyTable: "explorer.modifyTable",
  rename: "explorer.renameObject",
  truncate: "explorer.truncateTable",
  drop: "explorer.dropObject",
  copySchema: "explorer.copyPostgresSchema",
  copyDatabase: "explorer.copyPostgresDatabase",
  verifyPostgres: "explorer.verifyPostgresCopy",
  copyMysqlDatabase: "explorer.copyMysqlDatabase",
  verifyMysqlDatabase: "explorer.verifyMysqlDatabase",
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

async function verifyPostgresSchemaAction(context: ActionContext): Promise<void> {
  const target = selectedSchema(context);
  if (target === null) return;
  const state = useDatasources.getState();
  const source = datasourceById(state, target.datasourceId);
  if (source?.pluginId !== "postgres") return;
  const destinations = state.datasources.filter(
    (datasource) => datasource.id !== source.id && datasource.pluginId === "postgres",
  );
  const destinationId = await useModal.getState().ask({
    kind: "pick",
    title: "Verify against",
    searchLabel: "PostgreSQL data sources",
    items: destinations.map((datasource) => ({
      id: datasource.id,
      label: datasource.name,
      detail: datasource.pluginId,
    })),
    empty: "No other PostgreSQL data sources are available.",
    confirm: "Choose",
  });
  if (destinationId === null) return;
  const destination = datasourceById(useDatasources.getState(), destinationId);
  if (destination?.pluginId !== "postgres") return;
  const choice = await useModal.getState().ask({
    kind: "choice",
    title: "Verification scope",
    message: `Compare ${target.path.at(-1)} on ${source.name} with ${destination.name}.`,
    choices: [
      { id: "schema", label: "Verify schema", variant: "primary" },
      { id: "data", label: "Verify data" },
      { id: "both", label: "Verify schema and data" },
    ],
  });
  if (choice === null) return;
  try {
    const [sourceClient, destinationClient] = await Promise.all([
      useDatasources.getState().connect(source.id),
      useDatasources.getState().connect(destination.id),
    ]);
    const schema =
      choice === "schema" || choice === "both"
        ? await verifyPostgresSchema(sourceClient, destinationClient, target.path, target.path)
        : [];
    const data =
      choice === "data" || choice === "both"
        ? await verifyPostgresData(sourceClient, destinationClient, target.path, target.path)
        : [];
    const findings = [...schema, ...data];
    const failures = findings.filter(({ status }) => status !== "match");
    const summary =
      findings.length === 0
        ? "No supported tables were found to compare."
        : failures.length === 0
          ? `${findings.length} checks matched.`
          : `${failures.length} of ${findings.length} checks need attention.`;
    await useModal.getState().ask({
      kind: "notice",
      title: failures.length === 0 ? "Verification passed" : "Verification found differences",
      message: [summary, ...failures.map(({ object, status, detail }) => `${object}: ${status} — ${detail}`)].join(
        "\n",
      ),
      hint: "",
      tone: failures.length === 0 ? "info" : undefined,
    });
  } catch (cause) {
    await useModal.getState().ask({
      kind: "notice",
      title: "Verification stopped",
      message: toError(cause).message,
      hint: toError(cause).hint,
    });
  }
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

/** A selected schema namespace for read operations, including copy and verification from read-only sources. */
function selectedSchema(
  context: ActionContext,
): { readonly datasourceId: string; readonly path: readonly string[] } | null {
  const selection = context.selection;
  if (selection?.kind !== "catalog" || selection.name !== null) return null;
  if (namespaceAt(selection.id, selection.path)?.kind !== "schema") return null;
  return { datasourceId: selection.id, path: selection.path };
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
    id: OBJECT_ACTION_IDS.verifyMysqlDatabase,
    title: "Verify Schema or Data…",
    category: "Database",
    icon: "details",
    when: (context) => {
      const target = selectedSchema(context);
      return (
        target !== null &&
        target.path.length === 1 &&
        namespaceAt(target.datasourceId, target.path)?.system === false &&
        datasourceById(useDatasources.getState(), target.datasourceId)?.pluginId === "mysql"
      );
    },
    run: verifyMysqlDatabaseAction,
  }),
  defineAction({
    id: OBJECT_ACTION_IDS.copyMysqlDatabase,
    title: "Copy Database to…",
    category: "Database",
    icon: "copy",
    when: (context) => {
      const target = selectedSchema(context);
      return (
        target !== null &&
        target.path.length === 1 &&
        namespaceAt(target.datasourceId, target.path)?.system === false &&
        datasourceById(useDatasources.getState(), target.datasourceId)?.pluginId === "mysql"
      );
    },
    run: copyMysqlDatabaseAction,
  }),
  defineAction({
    id: OBJECT_ACTION_IDS.verifyPostgres,
    title: "Verify Schema or Data…",
    category: "Database",
    icon: "details",
    when: (context) => {
      const target = selectedSchema(context);
      return target !== null && datasourceById(useDatasources.getState(), target.datasourceId)?.pluginId === "postgres";
    },
    run: verifyPostgresSchemaAction,
  }),
  defineAction({
    id: OBJECT_ACTION_IDS.copyDatabase,
    title: "Copy Database to…",
    category: "Database",
    icon: "copy",
    when: (context) =>
      context.selection?.kind === "datasource" &&
      datasourceById(useDatasources.getState(), context.selection.id)?.pluginId === "postgres",
    run: async (context) => {
      const sourceId = context.selection?.kind === "datasource" ? context.selection.id : null;
      const source = datasourceById(useDatasources.getState(), sourceId);
      if (source?.pluginId !== "postgres") return;
      const destinations = useDatasources
        .getState()
        .datasources.filter(
          (datasource) => datasource.id !== source.id && datasource.pluginId === "postgres" && !datasource.readOnly,
        );
      if (destinations.length === 0) {
        await useModal.getState().ask({
          kind: "notice",
          title: "No PostgreSQL destination",
          message: "Add another writable PostgreSQL data source before copying this database.",
          hint: "",
        });
        return;
      }
      const destinationId = await useModal.getState().ask({
        kind: "pick",
        title: "Copy database to",
        searchLabel: "PostgreSQL data sources",
        items: destinations.map((datasource) => ({
          id: datasource.id,
          label: datasource.name,
          detail: datasource.pluginId,
        })),
        empty: "No writable PostgreSQL data sources are available.",
        confirm: "Choose",
      });
      if (destinationId === null) return;
      const destination = datasourceById(useDatasources.getState(), destinationId);
      if (destination?.pluginId !== "postgres" || destination.readOnly) return;
      const modeAnswer = await useModal.getState().ask({
        kind: "choice",
        title: "Copy options",
        message: `Copy all non-system schemas from ${source.name} to ${destination.name}.`,
        choices: [
          { id: "schema-data", label: "Schema and data", variant: "primary" },
          { id: "schema-only", label: "Schema only" },
          { id: "data-only", label: "Data only" },
        ],
      });
      if (modeAnswer === null) return;
      const mode = modeAnswer as PostgresCopyMode;
      let sourceClient: Awaited<ReturnType<ReturnType<typeof useDatasources.getState>["connect"]>>;
      let destinationClient: Awaited<ReturnType<ReturnType<typeof useDatasources.getState>["connect"]>>;
      let selectedTables: readonly string[] | undefined;
      try {
        [sourceClient, destinationClient] = await Promise.all([
          useDatasources.getState().connect(source.id),
          useDatasources.getState().connect(destination.id),
        ]);
        if (mode !== "schema-only") {
          const namespaces = await sourceClient.call<"catalog.namespaces">("catalog.namespaces", { refresh: true });
          const schemaPaths = namespaces
            .filter(({ path }) => path.length === 2 && path[1] !== "information_schema" && !path[1]?.startsWith("pg_"))
            .map(({ path }) => path);
          const items = [] as { id: string; label: string; detail: string }[];
          for (const schemaPath of schemaPaths) {
            const schemaName = schemaPath[1];
            if (schemaName === undefined) continue;
            const catalog = await sourceClient.call<"catalog.describe">("catalog.describe", {
              path: schemaPath,
              refresh: true,
            });
            items.push(
              ...catalog.catalog.relations
                .filter(({ kind }) => kind === "table")
                .map(({ name }) => ({
                  id: JSON.stringify([schemaName, name]),
                  label: `${schemaName}.${name}`,
                  detail: "Table rows",
                })),
            );
          }
          const answer = await useModal.getState().ask({
            kind: "multiPick",
            title: "Choose tables to copy",
            searchLabel: "Search tables",
            items,
            selected: items.map(({ id }) => id),
            empty: "No tables match this search.",
            confirm: "Continue",
          });
          if (answer === null) return;
          selectedTables = parseMultiPickAnswer(answer);
        }
      } catch (cause) {
        const error = toError(cause);
        await useModal
          .getState()
          .ask({ kind: "notice", title: "Could not prepare database copy", message: error.message, hint: error.hint });
        return;
      }
      const confirmed = await useModal.getState().ask({
        kind: "confirm",
        title: "Copy PostgreSQL database?",
        message: `This writes supported table/view definitions${mode === "schema-only" ? "" : ` and rows from ${selectedTables?.length ?? 0} selected tables`} for all non-system schemas to ${destination.name}. Existing object names stop the copy; data-only requires matching layouts and empty selected destination tables. Routines, triggers, standalone sequences, and sequence counters are not copied. Circular or cross-schema foreign keys stop data copy. Database content stays on this computer.`,
        items: [
          { label: "Source", detail: source.name, tone: "info" },
          { label: "Destination", detail: destination.name, tone: "info" },
        ],
        confirm: "Start copy",
      });
      if (confirmed === null) return;
      useModal.getState().showCopyProgress({
        title: "Copying PostgreSQL database",
        phase: "Preparing",
        current: "Opening source and destination",
        completed: 0,
        total: 0,
      });
      let failure: unknown = null;
      let latestProgress = { completed: 0, total: 0, current: "Opening source and destination" };
      try {
        await copyPostgresDatabase({
          source: sourceClient,
          destination: destinationClient,
          mode,
          selectedTables,
          onProgress: ({ completed, total, current }) => {
            latestProgress = { completed, total, current };
            const rowsCopied = /: (\d+) rows/.exec(current)?.[1];
            useModal.getState().updateCopyProgress({
              title: "Copying PostgreSQL database",
              phase: current.startsWith("Preparing")
                ? "Preparing"
                : current.includes("statement") || current.startsWith("Create schema")
                  ? "Creating schema"
                  : current.includes("rows")
                    ? "Copying table data"
                    : "Working",
              current,
              completed,
              total,
              ...(rowsCopied === undefined ? {} : { rowsCopied: Number(rowsCopied) }),
            });
          },
        });
        await useCatalog.getState().synchronize(destination.id, null);
      } catch (cause) {
        failure = cause;
      } finally {
        useModal.getState().clearCopyProgress();
      }
      if (failure === null) {
        await useModal.getState().ask({
          kind: "notice",
          title: "Database copy completed",
          message: `The non-system schemas were copied to ${destination.name}.`,
          hint: "",
          tone: "info",
        });
      } else {
        const error = toError(failure);
        await useModal.getState().ask({
          kind: "notice",
          title: "Database copy stopped",
          message: `${error.message}\nStopped after ${latestProgress.completed} of ${latestProgress.total} steps at ${latestProgress.current}.`,
          hint: error.hint,
        });
      }
    },
  }),
  defineAction({
    id: OBJECT_ACTION_IDS.copySchema,
    title: "Copy Schema to…",
    category: "Database",
    icon: "copy",
    when: (context) => {
      const target = selectedSchema(context);
      return target !== null && datasourceById(useDatasources.getState(), target.datasourceId)?.pluginId === "postgres";
    },
    run: async (context) => {
      const target = selectedSchema(context);
      if (target === null) return;
      const state = useDatasources.getState();
      const source = datasourceById(state, target.datasourceId);
      if (source?.pluginId !== "postgres") return;
      const destinations = state.datasources.filter(
        (datasource) => datasource.id !== source.id && datasource.pluginId === "postgres" && !datasource.readOnly,
      );
      if (destinations.length === 0) {
        await useModal.getState().ask({
          kind: "notice",
          title: "No PostgreSQL destination",
          message: "Add another writable PostgreSQL data source before copying this schema.",
          hint: "",
        });
        return;
      }
      const destinationId = await useModal.getState().ask({
        kind: "pick",
        title: "Copy schema to",
        searchLabel: "PostgreSQL data sources",
        items: destinations.map((datasource) => ({
          id: datasource.id,
          label: datasource.name,
          detail: datasource.pluginId,
        })),
        empty: "No writable PostgreSQL data sources are available.",
        confirm: "Choose",
      });
      if (destinationId === null) return;
      const destination = datasourceById(useDatasources.getState(), destinationId);
      if (destination?.pluginId !== "postgres" || destination.readOnly) return;
      const modeId = await useModal.getState().ask({
        kind: "choice",
        title: "Copy options",
        message: `Copy schema ${target.path.at(-1)} from ${source.name} to ${destination.name}.`,
        choices: [
          { id: "schema-data", label: "Schema and data", variant: "primary" },
          { id: "schema-only", label: "Schema only" },
          { id: "data-only", label: "Data only" },
        ],
      });
      if (modeId === null) return;
      const mode = modeId as PostgresCopyMode;
      let sourceClient: Awaited<ReturnType<ReturnType<typeof useDatasources.getState>["connect"]>>;
      let destinationClient: Awaited<ReturnType<ReturnType<typeof useDatasources.getState>["connect"]>>;
      let selectedTables: readonly string[] | undefined;
      try {
        [sourceClient, destinationClient] = await Promise.all([
          useDatasources.getState().connect(source.id),
          useDatasources.getState().connect(destination.id),
        ]);
        if (mode !== "schema-only") {
          const catalog = await sourceClient.call<"catalog.describe">("catalog.describe", {
            path: target.path,
            refresh: true,
          });
          const tables = catalog.catalog.relations.filter(({ kind }) => kind === "table");
          const answer = await useModal.getState().ask({
            kind: "multiPick",
            title: "Choose tables to copy",
            searchLabel: "Search tables",
            items: tables.map(({ name }) => ({ id: JSON.stringify([name]), label: name, detail: "Table rows" })),
            selected: tables.map(({ name }) => JSON.stringify([name])),
            empty: "No tables match this search.",
            confirm: "Continue",
          });
          if (answer === null) return;
          selectedTables = parseMultiPickAnswer(answer);
        }
      } catch (cause) {
        const error = toError(cause);
        await useModal
          .getState()
          .ask({ kind: "notice", title: "Could not prepare schema copy", message: error.message, hint: error.hint });
        return;
      }
      const confirmed = await useModal.getState().ask({
        kind: "confirm",
        title: "Copy PostgreSQL schema?",
        message: `This writes supported table/view definitions${mode === "schema-only" ? "" : ` and rows from ${selectedTables?.length ?? 0} selected tables`} to ${destination.name}. Existing object names stop the copy; data-only requires matching layouts and empty selected destination tables. Routines, triggers, standalone sequences, and sequence counters are not copied. Circular or cross-schema foreign keys stop data copy. Database content stays on this computer.`,
        items: [
          { label: "Source", detail: `${source.name} · ${target.path.join(" / ")}`, tone: "info" },
          { label: "Destination", detail: `${destination.name} · ${target.path.join(" / ")}`, tone: "info" },
        ],
        confirm: "Start copy",
      });
      if (confirmed === null) return;
      useModal.getState().showCopyProgress({
        title: "Copying PostgreSQL schema",
        phase: "Preparing",
        current: "Opening source and destination",
        completed: 0,
        total: 0,
      });
      let failure: unknown = null;
      let latestProgress = { completed: 0, total: 0, current: "Opening source and destination" };
      try {
        await copyPostgresSchema({
          source: sourceClient,
          destination: destinationClient,
          sourcePath: target.path,
          destinationPath: target.path,
          mode,
          selectedTables,
          onProgress: ({ completed, total, current }) => {
            latestProgress = { completed, total, current };
            const rowsCopied = /: (\d+) rows/.exec(current)?.[1];
            useModal.getState().updateCopyProgress({
              title: "Copying PostgreSQL schema",
              phase:
                current.startsWith("Schema statement") || current.startsWith("Create schema")
                  ? "Creating schema"
                  : current.includes("rows")
                    ? "Copying table data"
                    : "Working",
              current,
              completed,
              total,
              ...(rowsCopied === undefined ? {} : { rowsCopied: Number(rowsCopied) }),
            });
          },
        });
        await useCatalog.getState().synchronize(destination.id, target.path);
      } catch (cause) {
        failure = cause;
      } finally {
        useModal.getState().clearCopyProgress();
      }
      if (failure === null) {
        await useModal.getState().ask({
          kind: "notice",
          title: "Schema copy completed",
          message: `The selected schema was copied to ${destination.name}.`,
          hint: "",
          tone: "info",
        });
      } else {
        const error = toError(failure);
        await useModal.getState().ask({
          kind: "notice",
          title: "Schema copy stopped",
          message: `${error.message}\nStopped after ${latestProgress.completed} of ${latestProgress.total} steps at ${latestProgress.current}.`,
          hint: error.hint,
        });
      }
    },
  }),
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
