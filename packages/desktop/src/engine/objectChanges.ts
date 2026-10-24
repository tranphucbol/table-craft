import { CoreError, applyDdl, loadedPlugin } from "@table-craft/core";
import {
  isPluginError,
  type DdlScript,
  type ObjectChange,
  type ObjectEditor,
  type Relation,
  type TableDesign,
} from "@table-craft/plugin-api";
import { connectDatasource } from "@table-craft/desktop/engine/connect.js";
import type { BaseContext } from "@table-craft/desktop/engine/context.js";
import {
  BUG_HINT,
  DESIGN_HINT,
  EngineFailure,
  OBJECT_BUSY_HINT,
  PRIVATE_OBJECTS,
  PRIVATE_OBJECTS_HINT,
  READ_ONLY_OBJECTS,
  READ_ONLY_OBJECTS_HINT,
  STALE_PREVIEW,
  STALE_PREVIEW_HINT,
  SYNCHRONIZE_HINT,
  statementFailed,
} from "@table-craft/desktop/engine/failures.js";
import type { AppliedChange } from "@table-craft/desktop/engine/protocol.js";
import type { TransferContext } from "@table-craft/desktop/engine/transfers.js";

/** Changing objects from the tree: designs, previews and applying a change on a session of its own. */
export function objectContext(base: BaseContext, transfers: TransferContext) {
  const { options, now, connector, introspect, qualifiedOf } = base;
  const { tasks, imports, exportTables } = transfers;

  function objectEditor(): ObjectEditor {
    const { plugin } = loadedPlugin(options.plugins, options.datasource.pluginId);
    const editor = plugin.language?.objects;
    if (!plugin.capabilities.includes("objects") || editor === undefined) {
      throw new EngineFailure({
        code: "invalidRequest",
        message: "This datasource's plugin does not declare the objects capability.",
        hint: BUG_HINT,
      });
    }
    return editor;
  }

  /** Read afresh: a design or a diff from a stale cache would undo what another session changed. */
  async function freshRelation(path: readonly string[], name: string): Promise<Relation> {
    const described = await introspect(({ cache }) => cache.describe(path, true));
    const relation = described.catalog.relations.find((entry) => entry.name === name);
    if (relation === undefined) {
      throw new EngineFailure({
        code: "invalidRequest",
        message: `There is no table ${name} in ${path.join(".")}.`,
        hint: SYNCHRONIZE_HINT,
      });
    }
    return relation;
  }

  /** A design the plugin cannot write comes back as a PluginError; it is the user's to fix. */
  function designed<T>(write: () => T): T {
    try {
      return write();
    } catch (cause) {
      if (!isPluginError(cause)) throw cause;
      throw new EngineFailure({ code: "statementFailed", message: cause.message, hint: DESIGN_HINT }, cause);
    }
  }

  async function objectDesign(path: readonly string[], name: string): Promise<TableDesign> {
    const editor = objectEditor();
    const relation = await freshRelation(path, name);
    return designed(() => editor.design(relation));
  }

  async function objectScript(change: ObjectChange): Promise<DdlScript> {
    const editor = objectEditor();
    const introspector = await introspect(({ session }) => session.introspector);
    const altered = change.kind === "alterTable" ? await freshRelation(change.path, change.relation) : null;
    const current = altered === null ? null : designed(() => editor.design(altered));
    const qualifiedName = (path: readonly string[], name: string): string =>
      introspector?.qualifiedName(path, name) ?? name;
    return designed(() => editor.script(change, { qualifiedName, current }));
  }

  /** The table a change empties or removes, which a running import or export must not be reading or filling. */
  function busyTable(change: ObjectChange): { path: readonly string[]; name: string } | null {
    if (change.kind === "truncate" || change.kind === "alterTable") return { path: change.path, name: change.relation };
    if ((change.kind === "drop" || change.kind === "rename") && change.object.kind === "table") {
      return { path: change.path, name: change.object.name };
    }
    return null;
  }

  async function refuseWhileBusy(change: ObjectChange): Promise<void> {
    const table = busyTable(change);
    if (table === null) return;
    const qualified = await qualifiedOf(table.path, table.name);
    const importing = imports.list().find((task) => task.state === "running" && task.table === qualified);
    const exporting = tasks
      .list()
      .find((task) => task.state === "running" && exportTables.get(task.taskId) === qualified);
    const running = importing === undefined ? (exporting === undefined ? null : "An export") : "An import";
    if (running === null) return;
    throw new EngineFailure({
      code: "objectBusy",
      message: `${running} is using ${table.name}, so it cannot be changed now.`,
      hint: OBJECT_BUSY_HINT,
    });
  }

  function sameStatements(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((statement, index) => statement === right[index]);
  }

  async function applyObjectChange(change: ObjectChange, previewed: readonly string[]): Promise<AppliedChange> {
    const started = now();
    if (options.datasource.readOnly) {
      throw new EngineFailure({ code: "invalidRequest", message: READ_ONLY_OBJECTS, hint: READ_ONLY_OBJECTS_HINT });
    }
    const privateDatabase = await introspect(({ session }) => session.privateDatabase === true);
    if (privateDatabase) {
      throw new EngineFailure({ code: "invalidRequest", message: PRIVATE_OBJECTS, hint: PRIVATE_OBJECTS_HINT });
    }
    await refuseWhileBusy(change);
    const script = await objectScript(change);
    if (!sameStatements(script.statements, previewed)) {
      throw new EngineFailure({ code: "invalidRequest", message: STALE_PREVIEW, hint: STALE_PREVIEW_HINT });
    }
    if (script.statements.length > 0) {
      const session = await connectDatasource(options, connector);
      try {
        await applyDdl(session, script);
      } catch (cause) {
        throw cause instanceof CoreError ? cause : statementFailed(cause, false);
      } finally {
        await session.close().catch(() => undefined);
      }
    }
    await introspect(async ({ cache }) => {
      if (change.kind === "createNamespace") await cache.namespaces(true);
      else await cache.describe(change.path, true);
    }).catch(() => undefined);
    return { statements: script.statements.length, elapsedMs: now() - started };
  }

  return {
    objectEditor,
    freshRelation,
    designed,
    objectDesign,
    objectScript,
    busyTable,
    refuseWhileBusy,
    sameStatements,
    applyObjectChange,
  };
}
