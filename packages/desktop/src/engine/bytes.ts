import { randomUUID } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { matchCondition } from "@table-craft/core";
import { BYTES_PREVIEW_LENGTH, type BytesValue, type Row, type WireValue } from "@table-craft/plugin-api";
import { connectDatasource } from "@table-craft/desktop/engine/connect.js";
import type { LiveContext, TableResult } from "@table-craft/desktop/engine/connection.js";
import {
  BUG_HINT,
  EngineFailure,
  FILE_HINT,
  messageOf,
  statementFailed,
} from "@table-craft/desktop/engine/failures.js";
import type { CellBytes, RequestOf, StagedBytes } from "@table-craft/desktop/engine/protocol.js";

const BYTES_PER_MIB = 1024 * 1024;
const HEX = "hex";
const LIMIT_HINT = "Raise BLOB file limit in Settings › Data Editor, or choose a smaller value.";
const STALE_HINT = "Reload the result and choose the cell again.";

function refused(message: string, hint: string): EngineFailure {
  return new EngineFailure({ code: "invalidRequest", message, hint });
}

function isBytes(value: WireValue | undefined): value is BytesValue {
  return typeof value === "object" && value !== null && value.kind === "bytes";
}

function isComplete(value: BytesValue): boolean {
  return value.preview.length === 2 * value.length;
}

function mib(bytes: number): string {
  return (bytes / BYTES_PER_MIB).toFixed(1);
}

function absolute(path: string): void {
  if (!isAbsolute(path)) throw refused(`A file needs an absolute path, not "${path}".`, BUG_HINT);
}

function overLimit(what: "file" | "value", length: number, maxBytes: number): EngineFailure {
  return refused(`The ${what} is ${mib(length)} MiB, over the ${mib(maxBytes)} MiB limit.`, LIMIT_HINT);
}

/**
 * Binary cells to and from files (plan 043). The renderer never touches a file: main asks the user
 * for a path and the engine reads or writes it. A result holds only the first bytes of a long
 * value, so every byte is read again by the row's key on a read-only session of its own, which only
 * a table or an editable console result can name.
 */
export function bytesRunners(live: LiveContext, tableFor: (handle: string) => TableResult) {
  const { options, connector, results, staged, sessions, handles, tables, edited, ownedHandle, sqlLanguage } = live;

  function heldBytes(handle: string, row: number, column: number): BytesValue {
    const value = results.heldRows(handle)[row]?.[column];
    if (value === undefined) throw refused(`Row ${String(row + 1)} is no longer held.`, STALE_HINT);
    if (!isBytes(value)) {
      throw refused(
        value === null ? "The cell is NULL; it has no bytes." : "The cell is not binary.",
        "Choose a binary cell.",
      );
    }
    return value;
  }

  async function reread(handle: string, row: number, column: number): Promise<BytesValue> {
    const table = tables.get(handle) ?? edited.get(handle);
    if (table === undefined) {
      throw refused(
        `This result holds only the first ${String(BYTES_PREVIEW_LENGTH)} bytes of the value.`,
        "Open the table, or select the value with its table's key, to read every byte.",
      );
    }
    if (sessions.get(handles.get(handle) ?? "")?.session.privateDatabase === true) {
      throw refused(
        "This in-memory database cannot be read from a second connection.",
        "Save the database to a file and open that.",
      );
    }
    const language = sqlLanguage();
    const held = results.heldRows(handle)[row] ?? [];
    const key = table.identity.map((index) => ({ name: table.columns[index]?.name ?? "", type: null }));
    const where = matchCondition(language, key, [table.identity.map((index) => held[index] ?? null)]);
    const name = language.quoteIdentifier(table.columns[column]?.name ?? "");
    const session = await connectDatasource(options, connector, true);
    try {
      const read = await session.execute(`SELECT ${name} FROM ${table.table} WHERE ${where}`, [], { fullBytes: true });
      const rows: Row[] = [];
      for await (const one of read.rows) rows.push(one);
      const value = rows[0]?.[0];
      if (rows.length !== 1 || !isBytes(value)) {
        throw refused("The row changed in the database since it was read.", STALE_HINT);
      }
      return value;
    } catch (cause) {
      if (cause instanceof EngineFailure) throw cause;
      throw statementFailed(cause, true);
    } finally {
      await session.close().catch(() => undefined);
    }
  }

  async function fullBytes(request: { handle: string; row: number; column: number; maxBytes: number }) {
    const handle = ownedHandle(request.handle);
    const held = heldBytes(handle, request.row, request.column);
    if (held.length > request.maxBytes) throw overLimit("value", held.length, request.maxBytes);
    return isComplete(held) ? held : reread(handle, request.row, request.column);
  }

  async function cellBytes(request: RequestOf<"result.cellBytes">): Promise<CellBytes> {
    const { preview, length } = await fullBytes(request);
    return { kind: "bytes", preview, length };
  }

  async function saveBytes(request: RequestOf<"result.saveBytes">): Promise<number> {
    absolute(request.path);
    const bytes = await fullBytes(request);
    try {
      await writeFile(request.path, Buffer.from(bytes.preview, HEX));
    } catch (cause) {
      throw new EngineFailure(
        { code: "invalidRequest", message: `Could not write ${request.path}: ${messageOf(cause)}`, hint: FILE_HINT },
        cause,
      );
    }
    return bytes.length;
  }

  async function loadBytes(request: RequestOf<"result.loadBytes">): Promise<StagedBytes> {
    absolute(request.path);
    const handle = ownedHandle(request.handle);
    tableFor(handle);
    let contents: Buffer;
    try {
      const { size } = await stat(request.path);
      if (size > request.maxBytes) throw overLimit("file", size, request.maxBytes);
      contents = await readFile(request.path);
    } catch (cause) {
      if (cause instanceof EngineFailure) throw cause;
      throw new EngineFailure(
        { code: "invalidRequest", message: `Could not read ${request.path}: ${messageOf(cause)}`, hint: FILE_HINT },
        cause,
      );
    }
    if (contents.length > request.maxBytes) throw overLimit("file", contents.length, request.maxBytes);
    const id = randomUUID();
    const hex = contents.toString(HEX);
    staged.set(id, { handle, bytes: { kind: "bytes", preview: hex, length: contents.length } });
    return { id, length: contents.length, preview: hex.slice(0, 2 * BYTES_PREVIEW_LENGTH) };
  }

  return { cellBytes, saveBytes, loadBytes };
}
