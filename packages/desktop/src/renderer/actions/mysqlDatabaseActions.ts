import type { Namespace } from "@table-craft/desktop/engine/protocol.js";
import type { ActionContext } from "@table-craft/desktop/renderer/actions/context.js";
import {
  copyMysqlDatabase,
  verifyMysqlData,
  verifyMysqlSchema,
  type MysqlCopyMode,
} from "@table-craft/desktop/renderer/actions/mysqlCopy.js";
import { datasourceById, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useCatalog } from "@table-craft/desktop/renderer/state/catalog.js";
import { parseMultiPickAnswer, useModal } from "@table-craft/desktop/renderer/state/modal.js";
import { toError } from "@table-craft/desktop/renderer/state/resultWindows.js";

function selectedSchema(
  context: ActionContext,
): { readonly datasourceId: string; readonly path: readonly string[] } | null {
  const selection = context.selection;
  if (selection?.kind !== "catalog" || selection.name !== null) return null;
  const namespaces = useCatalog.getState().catalogs[selection.id]?.namespaces ?? [];
  const namespace = namespaces.find(
    (item) =>
      item.path.length === selection.path.length && item.path.every((part, index) => part === selection.path[index]),
  );
  return namespace?.kind === "schema" ? { datasourceId: selection.id, path: selection.path } : null;
}
export async function verifyMysqlDatabaseAction(context: ActionContext): Promise<void> {
  const target = selectedSchema(context);
  if (target === null || target.path.length !== 1) return;
  const state = useDatasources.getState();
  const source = datasourceById(state, target.datasourceId);
  if (source?.pluginId !== "mysql") return;
  const destinations = state.datasources.filter((datasource) => datasource.pluginId === "mysql");
  const destinationId = await useModal.getState().ask({
    kind: "pick",
    title: "Verify against",
    searchLabel: "MySQL data sources",
    items: destinations.map((datasource) => ({
      id: datasource.id,
      label: datasource.name,
      detail: datasource.pluginId,
    })),
    empty: "No MySQL data sources are available.",
    confirm: "Choose",
  });
  if (destinationId === null) return;
  const destination = datasourceById(useDatasources.getState(), destinationId);
  if (destination?.pluginId !== "mysql") return;
  let destinationClient: Awaited<ReturnType<ReturnType<typeof useDatasources.getState>["connect"]>>;
  let availableDatabases: readonly Namespace[];
  try {
    destinationClient = await useDatasources.getState().connect(destination.id);
    availableDatabases = (
      await destinationClient.call<"catalog.namespaces">("catalog.namespaces", { refresh: true })
    ).filter(
      (namespace) =>
        namespace.kind === "schema" &&
        namespace.path.length === 1 &&
        !namespace.system &&
        !(destination.id === source.id && namespace.path[0] === target.path[0]),
    );
  } catch (cause) {
    await useModal.getState().ask({
      kind: "notice",
      title: "Could not read verification databases",
      message: toError(cause).message,
      hint: toError(cause).hint,
    });
    return;
  }
  if (availableDatabases.length === 0) {
    await useModal.getState().ask({
      kind: "notice",
      title: "No comparison database",
      message: "Choose a MySQL connection with another existing non-system database.",
      hint: "",
    });
    return;
  }
  const destinationDatabase = await useModal.getState().ask({
    kind: "pick",
    title: "Choose database to compare",
    searchLabel: "Existing MySQL databases",
    items: availableDatabases.map((database) => ({
      id: database.path[0] ?? database.name,
      label: database.name,
      detail: database.current ? "Current database" : "MySQL database",
    })),
    empty: "No existing comparison databases are available.",
    confirm: "Choose",
  });
  if (destinationDatabase === null) return;
  const choice = await useModal.getState().ask({
    kind: "choice",
    title: "Verification scope",
    message: `Compare database ${target.path[0]} on ${source.name} with ${destinationDatabase} on ${destination.name}.`,
    choices: [
      { id: "schema", label: "Verify schema", variant: "primary" },
      { id: "data", label: "Verify data" },
      { id: "both", label: "Verify schema and data" },
    ],
  });
  if (choice === null) return;
  try {
    const sourceClient =
      destination.id === source.id ? destinationClient : await useDatasources.getState().connect(source.id);
    const schema =
      choice === "schema" || choice === "both"
        ? await verifyMysqlSchema(sourceClient, destinationClient, target.path, [destinationDatabase])
        : [];
    const data =
      choice === "data" || choice === "both"
        ? await verifyMysqlData(sourceClient, destinationClient, target.path, [destinationDatabase])
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

export async function copyMysqlDatabaseAction(context: ActionContext): Promise<void> {
  const target = selectedSchema(context);
  if (target === null || target.path.length !== 1) return;
  const state = useDatasources.getState();
  const source = datasourceById(state, target.datasourceId);
  if (source?.pluginId !== "mysql") return;
  const destinations = state.datasources.filter(
    (datasource) => datasource.pluginId === "mysql" && !datasource.readOnly,
  );
  if (destinations.length === 0) {
    await useModal.getState().ask({
      kind: "notice",
      title: "No MySQL destination",
      message: "Add a writable MySQL data source before copying this database.",
      hint: "",
    });
    return;
  }
  const destinationId = await useModal.getState().ask({
    kind: "pick",
    title: "Copy database to",
    searchLabel: "MySQL data sources",
    items: destinations.map((datasource) => ({
      id: datasource.id,
      label: datasource.name,
      detail: datasource.id === source.id ? "Same connection" : datasource.pluginId,
    })),
    empty: "No writable MySQL data sources are available.",
    confirm: "Choose",
  });
  if (destinationId === null) return;
  const destination = datasourceById(useDatasources.getState(), destinationId);
  if (destination?.pluginId !== "mysql" || destination.readOnly) return;
  let destinationClient: Awaited<ReturnType<ReturnType<typeof useDatasources.getState>["connect"]>>;
  let availableDatabases: readonly Namespace[];
  try {
    destinationClient = await useDatasources.getState().connect(destination.id);
    availableDatabases = (
      await destinationClient.call<"catalog.namespaces">("catalog.namespaces", { refresh: true })
    ).filter(
      (namespace) =>
        namespace.kind === "schema" &&
        namespace.path.length === 1 &&
        !namespace.system &&
        !(destination.id === source.id && namespace.path[0] === target.path[0]),
    );
  } catch (cause) {
    await useModal.getState().ask({
      kind: "notice",
      title: "Could not read destination databases",
      message: toError(cause).message,
      hint: toError(cause).hint,
    });
    return;
  }
  if (availableDatabases.length === 0) {
    await useModal.getState().ask({
      kind: "notice",
      title: "No destination database",
      message: "Choose a MySQL connection with another existing non-system database.",
      hint: "",
    });
    return;
  }
  const destinationDatabase = await useModal.getState().ask({
    kind: "pick",
    title: "Choose destination database",
    searchLabel: "Existing MySQL databases",
    items: availableDatabases.map((database) => ({
      id: database.path[0] ?? database.name,
      label: database.name,
      detail: database.current ? "Current database" : "MySQL database",
    })),
    empty: "No existing destination databases are available.",
    confirm: "Choose",
  });
  if (destinationDatabase === null) return;
  const modeAnswer = await useModal.getState().ask({
    kind: "choice",
    title: "Copy options",
    message: `Copy database ${target.path[0]} on ${source.name} to database ${destinationDatabase} on ${destination.name}.`,
    choices: [
      { id: "schema-data", label: "Schema and data", variant: "primary" },
      { id: "schema-only", label: "Schema only" },
      { id: "data-only", label: "Data only" },
    ],
  });
  if (modeAnswer === null) return;
  const mode = modeAnswer as MysqlCopyMode;
  let sourceClient: Awaited<ReturnType<ReturnType<typeof useDatasources.getState>["connect"]>>;
  let selectedTables: readonly string[] | undefined;
  try {
    sourceClient =
      destination.id === source.id ? destinationClient : await useDatasources.getState().connect(source.id);
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
        items: tables.map(({ name }) => ({ id: name, label: name, detail: "Table rows" })),
        selected: tables.map(({ name }) => name),
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
    title: "Copy MySQL database?",
    message: `${mode === "data-only" ? `This copies rows from ${selectedTables?.length ?? 0} selected tables` : mode === "schema-only" ? "This creates table and view definitions" : `This creates table and view definitions and copies rows from ${selectedTables?.length ?? 0} selected tables`} in the existing database ${destinationDatabase} on ${destination.name}. Existing object names stop the copy; data-only requires matching layouts and empty selected tables. ${mode === "data-only" ? "Routines, triggers, and events are outside data-only scope." : "Routines, triggers, and events are skipped; their counts appear after the copy."} Generated columns, non-InnoDB tables, circular foreign keys, and cross-database foreign keys still stop the copy. MySQL DDL commits implicitly, so a failed schema copy may leave created objects. Database content stays on this computer.`,
    items: [
      { label: "Source", detail: `${source.name} / ${target.path[0]}`, tone: "info" },
      { label: "Destination", detail: `${destination.name} / ${destinationDatabase}`, tone: "info" },
    ],
    confirm: "Start copy",
  });
  if (confirmed === null) return;
  useModal.getState().showCopyProgress({
    title: "Copying MySQL database",
    phase: "Preparing",
    current: "Opening source and destination",
    completed: 0,
    total: 0,
  });
  let failure: unknown = null;
  let copyReport: Awaited<ReturnType<typeof copyMysqlDatabase>> | null = null;
  let latestProgress = { completed: 0, total: 0, current: "Opening source and destination" };
  try {
    copyReport = await copyMysqlDatabase({
      source: sourceClient,
      destination: destinationClient,
      sourcePath: target.path,
      destinationPath: [destinationDatabase],
      mode,
      selectedTables,
      onProgress: ({ completed, total, current }) => {
        latestProgress = { completed, total, current };
        const rowsCopied = /: (\d+) rows/.exec(current)?.[1];
        useModal.getState().updateCopyProgress({
          title: "Copying MySQL database",
          phase: current.startsWith("Schema object")
            ? "Creating schema"
            : current.includes("rows")
              ? "Copying table data"
              : "Preparing",
          current,
          completed,
          total,
          ...(rowsCopied === undefined ? {} : { rowsCopied: Number(rowsCopied) }),
        });
      },
    });
    await useCatalog.getState().synchronize(destination.id, [destinationDatabase]);
  } catch (cause) {
    failure = cause;
  } finally {
    useModal.getState().clearCopyProgress();
  }
  if (failure === null) {
    const skipped = copyReport?.skippedObjects;
    const skippedTotal = skipped === undefined ? 0 : skipped.routines + skipped.triggers + skipped.events;
    await useModal.getState().ask({
      kind: "notice",
      title: skippedTotal === 0 ? "Database copy completed" : "Database copy completed with skipped objects",
      message:
        skippedTotal === 0
          ? `Database ${target.path[0]} was copied to ${destination.name} / ${destinationDatabase}.`
          : `Database ${target.path[0]} was copied to ${destination.name} / ${destinationDatabase}. Omitted objects: ${skipped?.routines ?? 0} routines, ${skipped?.triggers ?? 0} triggers, and ${skipped?.events ?? 0} events.`,
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
}
