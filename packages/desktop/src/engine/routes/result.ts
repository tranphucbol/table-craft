import { cellClipboardText, project, rowWriter } from "@table-craft/core";
import type { Row } from "@table-craft/plugin-api";
import type { ConnectionContext } from "@table-craft/desktop/engine/connection.js";
import { EngineFailure, SERVER_SORT_HINT, statementFailed } from "@table-craft/desktop/engine/failures.js";
import type { RowRange } from "@table-craft/desktop/engine/protocol.js";
import type { RoutesFor } from "@table-craft/desktop/engine/routes/types.js";

function rowsIn(rows: readonly Row[], ranges: readonly RowRange[]): Row[] {
  return ranges.flatMap((range) => rows.slice(range.from, Math.max(range.from, range.to)));
}

export function resultRoutes(connection: ConnectionContext): RoutesFor<"result"> {
  const {
    options,
    sqlLanguage,
    results,
    handles,
    cursors,
    tables,
    forget,
    noteClosing,
    track,
    chosenColumns,
    ownedHandle,
    resultEditable,
  } = connection;
  return {
    "result.window": ({ handle, offset, limit }) => Promise.resolve(results.window(ownedHandle(handle), offset, limit)),
    "result.release": async ({ handle }) => {
      const owner = handles.get(handle);
      if (owner === undefined) return null;
      forget(handle);
      const released = results.release(handle);
      if (cursors.get(owner) === handle) {
        cursors.delete(owner);
        noteClosing(owner, released);
      }
      await released;
      return null;
    },
    "result.fetchMore": async ({ handle, all, pageRows, fetchAllCap }) => {
      const state = await results
        .fetchMore(ownedHandle(handle), { all, pageRows, fetchAllCap })
        .catch((cause: unknown) => {
          throw statementFailed(cause, options.datasource.readOnly);
        });
      return track(handle, state);
    },
    "result.stopFetch": async ({ handle }) => track(handle, await results.stopFetch(ownedHandle(handle))),
    "result.sort": ({ handle, keys }) => {
      if (tables.has(ownedHandle(handle))) {
        throw new EngineFailure({
          code: "invalidRequest",
          message: "A table editor's rows are sorted by the database, not locally (decision 026).",
          hint: SERVER_SORT_HINT,
        });
      }
      return Promise.resolve(results.sort(handle, keys));
    },
    "result.view": ({ handle, spec }) => Promise.resolve(results.setView(ownedHandle(handle), spec)),
    "result.viewState": ({ handle }) => Promise.resolve(results.viewState(ownedHandle(handle))),
    "result.findMatch": ({ handle, from, backward }) =>
      Promise.resolve(results.findMatch(ownedHandle(handle), from, backward)),
    "result.extract": ({ handle, extractor, rows, columns }) => {
      const chosen = chosenColumns(ownedHandle(handle), columns);
      const picked = rowsIn(results.shownRows(handle), rows);
      const [only] = picked;
      // One cell is a value to paste elsewhere, not a table: no header, no quoting (as DataGrip copies it).
      if (picked.length === 1 && only !== undefined && columns.length === 1) {
        return Promise.resolve(cellClipboardText(project(only, columns)[0] ?? null));
      }
      const writer = rowWriter(extractor, chosen, { dialect: sqlLanguage() });
      const body = picked.map((row, index) => writer.row(project(row, columns), index)).join("");
      return Promise.resolve(writer.start() + body + writer.end(picked.length));
    },
    "result.editable": (request) => resultEditable(request),
  };
}
