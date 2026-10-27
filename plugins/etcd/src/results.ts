import {
  toBytesValue,
  toWireInteger,
  type Column,
  type ExecuteResult,
  type Row,
  type WireValue,
  type WireValueOptions,
} from "@table-craft/plugin-api";
import type { IKeyValue } from "etcd3";
import { hexId } from "./args.js";

/** A leading byte order mark is part of the value: stripping it would change the bytes. */
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const NO_LEASE = "0";

/** The columns every key-value row has (decision 8 of plan 110). */
export const KV_COLUMNS: readonly Column[] = [
  { name: "key", type: null },
  { name: "value", type: null },
  { name: "create_revision", type: null, typeClass: "integer" },
  { name: "mod_revision", type: null, typeClass: "integer" },
  { name: "version", type: null, typeClass: "integer" },
  { name: "lease", type: null },
];

/** The bytes as text when they are valid UTF-8, else null. */
export function utf8OrNull(bytes: Uint8Array): string | null {
  try {
    return UTF8.decode(bytes);
  } catch {
    return null;
  }
}

/** Bytes as a cell: text when they are valid UTF-8, the bytes otherwise. */
export function bytesCell(bytes: Uint8Array, options: WireValueOptions = {}): WireValue {
  return utf8OrNull(bytes) ?? toBytesValue(bytes, options);
}

/** A lease id as `etcdctl` prints it, null for none. */
export function leaseCell(lease: string): string | null {
  return lease === NO_LEASE || lease === "" ? null : hexId(lease);
}

/** One key-value pair as a row of `KV_COLUMNS`; a keys-only read has no value. */
export function kvRow(kv: IKeyValue, options: WireValueOptions = {}, keysOnly = false): Row {
  return [
    bytesCell(kv.key, options),
    keysOnly ? null : bytesCell(kv.value, options),
    toWireInteger(kv.create_revision),
    toWireInteger(kv.mod_revision),
    toWireInteger(kv.version),
    leaseCell(kv.lease),
  ];
}

async function* yieldRows(rows: readonly Row[]): AsyncIterable<Row> {
  for (const row of rows) yield row;
  return Promise.resolve();
}

export function tableResult(columns: readonly Column[], rows: readonly Row[]): ExecuteResult {
  return { columns, rows: yieldRows(rows), rowsAffected: null };
}

/** Columns by name, each text unless named in `integers`. */
export function columnsOf(names: readonly string[], integers: readonly string[] = []): Column[] {
  return names.map((name) =>
    integers.includes(name) ? { name, type: null, typeClass: "integer" as const } : { name, type: null },
  );
}

export function kvResult(kvs: readonly IKeyValue[], options: WireValueOptions = {}, keysOnly = false): ExecuteResult {
  return tableResult(
    KV_COLUMNS,
    kvs.map((kv) => kvRow(kv, options, keysOnly)),
  );
}

/** A one-value answer for Output, such as `OK` or a count. */
export function replyResult(value: WireValue, text: string): ExecuteResult {
  return { columns: [], rows: yieldRows([]), rowsAffected: null, reply: { value, text } };
}
