import {
  toBytesValue,
  toWireInteger,
  type Column,
  type ExecuteResult,
  type KeyType,
  type Row,
  type WireValue,
  type WireValueOptions,
} from "@table-craft/plugin-api";

/** A reply as node-redis decodes it here: bulk strings as `Buffer`, maps as `Map`. */
export type Reply = unknown;

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const PRINTABLE_ASCII_FIRST = 0x20;
const PRINTABLE_ASCII_LAST = 0x7e;
const HEX_RADIX = 16;
const HEX_WIDTH = 2;
const ESCAPED: Readonly<Record<number, string>> = { 0x0a: "\\n", 0x0d: "\\r", 0x09: "\\t", 0x22: '\\"', 0x5c: "\\\\" };

const INDEX_COLUMN: Column = { name: "#", type: null, typeClass: "integer" };
const VALUE_COLUMN: Column = { name: "value", type: null };
const KEY_COLUMN: Column = { name: "key", type: null };
const FIELD_COLUMN: Column = { name: "field", type: null };
const MEMBER_COLUMN: Column = { name: "member", type: null };
const SCORE_COLUMN: Column = { name: "score", type: null, typeClass: "float" };
/** The column a fan-out to every primary leads each row with (decision 114). */
export const NODE_COLUMN: Column = { name: "node", type: null };

/** The bytes as text when they are valid UTF-8, else null. */
export function utf8OrNull(bytes: Uint8Array): string | null {
  try {
    return UTF8.decode(bytes);
  } catch {
    return null;
  }
}

/** A bulk string as a cell: text when it is valid UTF-8, the bytes otherwise. */
export function bulkValue(bytes: Uint8Array, options: WireValueOptions = {}): WireValue {
  return utf8OrNull(bytes) ?? toBytesValue(bytes, options);
}

/** Bytes as `redis-cli` quotes them: printable ASCII as is, the rest `\xNN`. */
export function quotedBytes(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) {
    const escaped = ESCAPED[byte];
    if (escaped !== undefined) text += escaped;
    else if (byte >= PRINTABLE_ASCII_FIRST && byte <= PRINTABLE_ASCII_LAST) text += String.fromCharCode(byte);
    else text += `\\x${byte.toString(HEX_RADIX).padStart(HEX_WIDTH, "0")}`;
  }
  return `"${text}"`;
}

function isScalar(reply: Reply): boolean {
  return !Array.isArray(reply) && !(reply instanceof Map) && !(reply instanceof Set);
}

/** A reply as `redis-cli` prints a scalar: `"Ann"`, `(integer) 5`, `(nil)`, `OK`. */
export function replyText(reply: Reply): string {
  if (reply === null || reply === undefined) return "(nil)";
  if (reply instanceof Uint8Array) return quotedBytes(reply);
  if (reply instanceof Error) return `(error) ${reply.message}`;
  switch (typeof reply) {
    case "number":
      return Number.isInteger(reply) ? `(integer) ${String(reply)}` : `(double) ${String(reply)}`;
    case "bigint":
      return `(integer) ${reply.toString()}`;
    case "boolean":
      return reply ? "(true)" : "(false)";
    case "string":
      return reply;
    default:
      return JSON.stringify(jsonOf(reply));
  }
}

function jsonOf(reply: Reply): unknown {
  if (reply instanceof Uint8Array) return utf8OrNull(reply) ?? quotedBytes(reply);
  if (reply instanceof Error) return reply.message;
  if (typeof reply === "bigint") return reply.toString();
  if (Array.isArray(reply) || reply instanceof Set) return [...(reply as Iterable<Reply>)].map(jsonOf);
  if (reply instanceof Map) {
    return Object.fromEntries(
      [...(reply as Map<Reply, Reply>)].map(([key, value]) => [String(jsonOf(key)), jsonOf(value)]),
    );
  }
  return reply ?? null;
}

/** One reply element as a cell: nested structure becomes JSON (decision 7 of plan 058). */
export function cellOf(reply: Reply, options: WireValueOptions = {}): WireValue {
  if (reply === null || reply === undefined) return null;
  if (reply instanceof Uint8Array) return bulkValue(reply, options);
  if (reply instanceof Error) return `(error) ${reply.message}`;
  switch (typeof reply) {
    case "number":
    case "boolean":
    case "string":
      return reply;
    case "bigint":
      return toWireInteger(reply);
    default:
      return { kind: "json", text: JSON.stringify(jsonOf(reply)) };
  }
}

function isScoredPair(element: Reply): boolean {
  return Array.isArray(element) && element.length === 2 && isScalar(element[0]) && typeof element[1] === "number";
}

/** Columns and rows of a reply that is not a scalar; null for a scalar. */
export function tableOf(reply: Reply, options: WireValueOptions = {}): { columns: Column[]; rows: Row[] } | null {
  if (reply instanceof Map) {
    const rows = [...(reply as Map<Reply, Reply>)].map(([key, value]) => [
      cellOf(key, options),
      cellOf(value, options),
    ]);
    return { columns: [KEY_COLUMN, VALUE_COLUMN], rows };
  }
  if (!Array.isArray(reply) && !(reply instanceof Set)) return null;
  const elements = [...(reply as Iterable<Reply>)];
  if (elements.length > 0 && elements.every(isScoredPair)) {
    const rows = elements.map((element) => {
      const [member, score] = element as [Reply, number];
      return [cellOf(member, options), score];
    });
    return { columns: [MEMBER_COLUMN, SCORE_COLUMN], rows };
  }
  return {
    columns: [INDEX_COLUMN, VALUE_COLUMN],
    rows: elements.map((element, index) => [index + 1, cellOf(element, options)]),
  };
}

async function* yieldRows(rows: readonly Row[]): AsyncIterable<Row> {
  for (const row of rows) yield row;
  return Promise.resolve();
}

/**
 * A command's reply as an `ExecuteResult`: a scalar as `reply`, anything else as rows. A bulk
 * string, or the nil of a command that reads one key, is a value read (decision 119).
 */
export function resultOf(reply: Reply, options: WireValueOptions = {}, readsKey = false): ExecuteResult {
  const table = tableOf(reply, options);
  if (table === null) {
    const read = reply instanceof Uint8Array || (readsKey && (reply === null || reply === undefined));
    return {
      columns: [],
      rows: yieldRows([]),
      rowsAffected: null,
      reply: { value: cellOf(reply, options), text: replyText(reply), ...(read ? { read } : {}) },
    };
  }
  return { columns: table.columns, rows: yieldRows(table.rows), rowsAffected: null };
}

function membersOf(reply: Reply): Reply[] | null {
  return Array.isArray(reply) || reply instanceof Set ? [...(reply as Iterable<Reply>)] : null;
}

/**
 * A reply holding a whole key in the columns a key tab reads that type with (decision 119), so an
 * edit maps to the key the same way: list positions count from 0 as `LSET` does. Null when the
 * reply is not that shape, or the type is not one a console result edits as rows.
 */
export function wholeKeyResult(reply: Reply, type: KeyType, options: WireValueOptions = {}): ExecuteResult | null {
  const result = (columns: Column[], rows: Row[]): ExecuteResult => ({
    columns,
    rows: yieldRows(rows),
    rowsAffected: null,
  });
  const members = membersOf(reply);
  switch (type) {
    case "hash":
      if (!(reply instanceof Map)) return null;
      return result(
        [FIELD_COLUMN, VALUE_COLUMN],
        [...(reply as Map<Reply, Reply>)].map(([field, value]) => [cellOf(field, options), cellOf(value, options)]),
      );
    case "set":
      return members === null
        ? null
        : result(
            [MEMBER_COLUMN],
            members.map((member) => [cellOf(member, options)]),
          );
    case "list":
      return members === null
        ? null
        : result(
            [INDEX_COLUMN, VALUE_COLUMN],
            members.map((element, index) => [index, cellOf(element, options)]),
          );
    case "zset":
      if (members === null) return null;
      if (members.length > 0 && members.every(isScoredPair)) {
        return result(
          [MEMBER_COLUMN, SCORE_COLUMN],
          members.map((element) => {
            const [member, score] = element as [Reply, number];
            return [cellOf(member, options), score];
          }),
        );
      }
      return result(
        [MEMBER_COLUMN],
        members.map((member) => [cellOf(member, options)]),
      );
    default:
      return null;
  }
}

/** One reply per primary, each row led by the node it came from (decision 114). */
export function fannedOutResult(
  replies: readonly { readonly node: string; readonly reply: Reply }[],
  options: WireValueOptions = {},
): ExecuteResult {
  const tables = replies.map(({ node, reply }) => ({ node, table: tableOf(reply, options), reply }));
  const shaped = tables.find((entry) => entry.table !== null)?.table ?? null;
  const columns = shaped === null ? [VALUE_COLUMN] : shaped.columns;
  const rows: Row[] = [];
  for (const { node, table, reply } of tables) {
    if (table === null) rows.push([node, cellOf(reply, options)]);
    else for (const row of table.rows) rows.push([node, ...row]);
  }
  return { columns: [NODE_COLUMN, ...columns], rows: yieldRows(rows), rowsAffected: null };
}
