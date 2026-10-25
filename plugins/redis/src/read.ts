import {
  type Column,
  type ExecuteResult,
  type KeyContents,
  type KeyDetails,
  type KeyName,
  type KeyReadRequest,
  type KeyType,
  type Row,
  type WireValue,
} from "@table-craft/plugin-api";
import { bytesOf } from "./keyBytes.js";
import { bulkValue } from "./replies.js";

/** Decision 14: a value is read whole up to this many bytes; a longer string shows this much. */
export const VALUE_LIMIT_BYTES = 1024 * 1024;
const END_OF_PASS = "0";
const NO_EXPIRY = -1;
const MISSING = -2;
const FULL_BYTES = { fullBytes: true } as const;

const FIELD: Column = { name: "field", type: null };
const VALUE: Column = { name: "value", type: null };
const TTL: Column = { name: "ttl", type: null, typeClass: "integer" };
const INDEX: Column = { name: "#", type: null, typeClass: "integer" };
const MEMBER: Column = { name: "member", type: null };
const SCORE: Column = { name: "score", type: null, typeClass: "float" };
const ID: Column = { name: "id", type: null };

/** The length command of each type that has one. */
const LENGTH_COMMANDS: Partial<Record<KeyType, string>> = {
  string: "STRLEN",
  hash: "HLEN",
  list: "LLEN",
  set: "SCARD",
  zset: "ZCARD",
  stream: "XLEN",
};

/** What reading a key needs from its session. */
export interface ReadHost {
  /** Runs `args` on the node that holds `key`, on the session's connection to the database. */
  onKey(database: number, key: Buffer, args: readonly (string | Buffer)[]): Promise<unknown>;
  /** Whether the server has per-field hash TTLs (`HPTTL`, Redis 7.4). */
  hashFieldTtl(): Promise<boolean>;
}

/** The key's type as `TYPE` names it, with what `describe` already maps it to. */
export interface TypedKey {
  readonly type: KeyType | null;
  readonly typeName: string | null;
  readonly ttlMs: number | null;
}

function text(reply: unknown): string {
  return reply instanceof Uint8Array ? Buffer.from(reply).toString("utf8") : String(reply);
}

function numberOrNull(reply: unknown): number | null {
  if (reply === null || reply === undefined) return null;
  const value = Number(text(reply));
  return Number.isFinite(value) ? value : null;
}

function cell(reply: unknown): WireValue {
  return reply instanceof Uint8Array ? bulkValue(reply, FULL_BYTES) : reply === null ? null : text(reply);
}

function scanReply(reply: unknown): { cursor: string; elements: readonly unknown[] } {
  const [cursor, elements] = Array.isArray(reply) ? (reply as [unknown, unknown]) : [END_OF_PASS, []];
  return { cursor: text(cursor), elements: Array.isArray(elements) ? elements : [] };
}

function pairs(flat: readonly unknown[]): [unknown, unknown][] {
  const out: [unknown, unknown][] = [];
  for (let index = 0; index + 1 < flat.length; index += 2) out.push([flat[index], flat[index + 1]]);
  return out;
}

/** A field, member or entry reply turned into rows, one batch after another until the key is read. */
async function* batches(next: () => Promise<{ rows: readonly Row[]; more: boolean }>): AsyncIterable<Row> {
  for (;;) {
    const batch = await next();
    for (const row of batch.rows) yield row;
    if (!batch.more) return;
  }
}

/** The optional facts `OBJECT` and `MEMORY` give; each is null when ACL refuses it. */
async function details(
  host: ReadHost,
  database: number,
  name: KeyName,
  key: Buffer,
  typed: TypedKey,
): Promise<KeyDetails> {
  const quiet = (args: readonly string[]) =>
    host.onKey(database, key, [...args, key]).then(numberOrNullOrText, () => null);
  const lengthCommand = typed.type === null ? undefined : LENGTH_COMMANDS[typed.type];
  const [length, memory, encoding, idle] = await Promise.all([
    lengthCommand === undefined ? null : quiet([lengthCommand]),
    quiet(["MEMORY", "USAGE"]),
    quiet(["OBJECT", "ENCODING"]),
    quiet(["OBJECT", "IDLETIME"]),
  ]);
  return {
    key: name,
    ...typed,
    length: typeof length === "number" ? length : null,
    memoryBytes: typeof memory === "number" ? memory : null,
    encoding: typeof encoding === "string" ? encoding : null,
    idleSeconds: typeof idle === "number" ? idle : null,
  };
}

function numberOrNullOrText(reply: unknown): number | string | null {
  if (reply === null || reply === undefined) return null;
  if (typeof reply === "number") return reply;
  const value = text(reply);
  return /^-?\d+$/.test(value) ? Number(value) : value;
}

async function stringContents(host: ReadHost, database: number, key: Buffer, length: number | null) {
  if (length !== null && length > VALUE_LIMIT_BYTES) {
    const head = await host.onKey(database, key, ["GETRANGE", key, "0", String(VALUE_LIMIT_BYTES - 1)]);
    return {
      value: cell(head),
      readOnly: `the value is ${length.toLocaleString("en-US")} bytes; the first MiB is shown`,
    };
  }
  return { value: cell(await host.onKey(database, key, ["GET", key])), readOnly: null };
}

async function hashResult(
  host: ReadHost,
  database: number,
  key: Buffer,
  request: KeyReadRequest,
): Promise<ExecuteResult> {
  const withTtl = await host.hashFieldTtl();
  let cursor = END_OF_PASS;
  const rows = batches(async () => {
    const reply = scanReply(
      await host.onKey(database, key, [
        "HSCAN",
        key,
        cursor,
        "MATCH",
        request.match ?? "*",
        "COUNT",
        String(request.window),
      ]),
    );
    cursor = reply.cursor;
    const fields = pairs(reply.elements);
    const ttls = withTtl && fields.length > 0 ? await fieldTtls(host, database, key, fields) : [];
    return {
      rows: fields.map(([field, value], index) =>
        withTtl ? [cell(field), cell(value), ttls[index] ?? null] : [cell(field), cell(value)],
      ),
      more: cursor !== END_OF_PASS,
    };
  });
  return { columns: withTtl ? [FIELD, VALUE, TTL] : [FIELD, VALUE], rows, rowsAffected: null };
}

async function fieldTtls(
  host: ReadHost,
  database: number,
  key: Buffer,
  fields: readonly [unknown, unknown][],
): Promise<(number | null)[]> {
  const names = fields.map(([field]) => field as Buffer);
  const reply = await host.onKey(database, key, ["HPTTL", key, "FIELDS", String(names.length), ...names]);
  return (Array.isArray(reply) ? reply : []).map((ms) => {
    const value = Number(ms);
    return value === NO_EXPIRY || value === MISSING || !Number.isFinite(value) ? null : value;
  });
}

function rangeResult(
  columns: readonly Column[],
  request: KeyReadRequest,
  read: (from: number, to: number) => Promise<readonly unknown[]>,
  rowOf: (element: unknown, index: number) => Row,
): ExecuteResult {
  let offset = request.offset ?? 0;
  const rows = batches(async () => {
    const elements = await read(offset, offset + request.window - 1);
    const first = offset;
    offset += elements.length;
    return {
      rows: elements.map((element, index) => rowOf(element, first + index)),
      more: elements.length === request.window,
    };
  });
  return { columns, rows, rowsAffected: null };
}

function scanResult(
  columns: readonly Column[],
  scan: (cursor: string) => Promise<unknown>,
  rowsOf: (elements: readonly unknown[]) => readonly Row[],
): ExecuteResult {
  let cursor = END_OF_PASS;
  const rows = batches(async () => {
    const reply = scanReply(await scan(cursor));
    cursor = reply.cursor;
    return { rows: rowsOf(reply.elements), more: cursor !== END_OF_PASS };
  });
  return { columns, rows, rowsAffected: null };
}

function zsetResult(host: ReadHost, database: number, key: Buffer, request: KeyReadRequest): ExecuteResult {
  const columns = [INDEX, MEMBER, SCORE];
  if (request.match !== undefined && request.match !== "*") {
    const match = request.match;
    return scanResult(
      columns,
      (cursor) => host.onKey(database, key, ["ZSCAN", key, cursor, "MATCH", match, "COUNT", String(request.window)]),
      (elements) => pairs(elements).map(([member, score]) => [null, cell(member), numberOrNull(score)]),
    );
  }
  return rangeResult(
    columns,
    request,
    async (from, to) => {
      const reply = await host.onKey(database, key, ["ZRANGE", key, String(from), String(to), "WITHSCORES"]);
      return Array.isArray(reply) ? (reply as unknown[]) : [];
    },
    (element, index) => {
      const [member, score] = Array.isArray(element) ? (element as [unknown, unknown]) : [element, null];
      return [index, cell(member), numberOrNull(score)];
    },
  );
}

function entryOf(element: unknown): { id: string; fields: [string, unknown][] } {
  const [id, flat] = Array.isArray(element) ? (element as [unknown, unknown]) : ["", []];
  return {
    id: text(id),
    fields: pairs(Array.isArray(flat) ? flat : []).map(([field, value]) => [text(field), value]),
  };
}

/**
 * A stream's entries, `id` then one column per field name the first window holds; a later entry's
 * field outside those is left out, as the columns are fixed before the rows are read.
 */
async function streamResult(
  host: ReadHost,
  database: number,
  key: Buffer,
  request: KeyReadRequest,
): Promise<ExecuteResult> {
  const range = async (from: string) => {
    const reply = await host.onKey(database, key, [
      "XRANGE",
      key,
      from,
      request.to ?? "+",
      "COUNT",
      String(request.window),
    ]);
    return (Array.isArray(reply) ? reply : []).map(entryOf);
  };
  const first = await range(request.from ?? "-");
  const names = [...new Set(first.flatMap((entry) => entry.fields.map(([name]) => name)))];
  const rowOf = (entry: { id: string; fields: [string, unknown][] }): Row => {
    const values = new Map(entry.fields);
    return [entry.id, ...names.map((name) => (values.has(name) ? cell(values.get(name)) : null))];
  };
  let pending: readonly { id: string; fields: [string, unknown][] }[] | null = first;
  let last = first.at(-1)?.id ?? null;
  const rows = batches(async () => {
    const entries = pending ?? (last === null ? [] : await range(successorId(last)));
    pending = null;
    last = entries.at(-1)?.id ?? last;
    return { rows: entries.map(rowOf), more: entries.length === request.window };
  });
  return { columns: [ID, ...names.map((name) => ({ name, type: null }))], rows, rowsAffected: null };
}

const MAX_SEQUENCE = 2n ** 64n - 1n;

/**
 * The first stream id after `id`, where the next window starts: the exclusive `(id` start came in
 * 6.2, and 5.0 is supported (decision 116).
 */
export function successorId(id: string): string {
  const [ms = "0", sequence = "0"] = id.split("-");
  const next = BigInt(sequence) + 1n;
  return next > MAX_SEQUENCE ? `${String(BigInt(ms) + 1n)}-0` : `${ms}-${String(next)}`;
}

function elementsResult(
  host: ReadHost,
  database: number,
  key: Buffer,
  type: KeyType,
  request: KeyReadRequest,
): Promise<ExecuteResult> | ExecuteResult | null {
  const count = String(request.window);
  switch (type) {
    case "hash":
      return hashResult(host, database, key, request);
    case "list":
      return rangeResult(
        [INDEX, VALUE],
        request,
        async (from, to) => {
          const reply = await host.onKey(database, key, ["LRANGE", key, String(from), String(to)]);
          return Array.isArray(reply) ? (reply as unknown[]) : [];
        },
        (element, index) => [index, cell(element)],
      );
    case "set":
      return scanResult(
        [MEMBER],
        (cursor) => host.onKey(database, key, ["SSCAN", key, cursor, "MATCH", request.match ?? "*", "COUNT", count]),
        (elements) => elements.map((member) => [cell(member)]),
      );
    case "zset":
      return zsetResult(host, database, key, request);
    case "stream":
      return streamResult(host, database, key, request);
    default:
      return null;
  }
}

/** A key's details and contents (decision 14): rows for the collection types, a value for the rest. */
export async function readKey(
  host: ReadHost,
  database: number,
  name: KeyName,
  typed: TypedKey,
  request: KeyReadRequest,
): Promise<KeyContents> {
  const key = bytesOf(name);
  const found = await details(host, database, name, key, typed);
  const type = typed.type;
  if (type === null) return { details: found, result: null, value: null, readOnly: null };
  if (type === "string") {
    const { value, readOnly } = await stringContents(host, database, key, found.length);
    return { details: found, result: null, value, readOnly };
  }
  if (type === "json") {
    const json = await host.onKey(database, key, ["JSON.GET", key]).then(text, () => null);
    return {
      details: found,
      result: null,
      value: json === null ? null : { kind: "json", text: json },
      readOnly: "RedisJSON documents open read-only",
    };
  }
  const result = await elementsResult(host, database, key, type, request);
  if (result === null) {
    return { details: found, result: null, value: null, readOnly: `type ${typed.typeName ?? type}: not supported` };
  }
  return { details: found, result, value: null, readOnly: null };
}
