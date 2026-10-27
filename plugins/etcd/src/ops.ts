import { PluginError } from "@table-craft/plugin-api";
import type { IRequestOp } from "etcd3";
import { argumentsOf, hexId, leaseIdOf, numberFlag, type Arguments } from "./args.js";
import { commandOf, type CommandDoc } from "./docs.js";
import { NO_END, prefixEnd } from "./scan.js";
import { quoteBytes, type Token } from "./tokens.js";

const NO_LEASE = "0";
const DECIMAL = /^\d+$/;
const SORT_TARGETS: Readonly<Record<string, string>> = {
  KEY: "Key",
  CREATE: "Create",
  MODIFY: "Mod",
  VALUE: "Value",
  VERSION: "Version",
};
const SORT_ORDERS: Readonly<Record<string, string>> = { ASCEND: "Ascend", DESCEND: "Descend" };
const DEFAULT_ORDER = "ASCEND";

/** A `get`: one key, or `[key, rangeEnd)`. */
export interface RangeOp {
  readonly kind: "get";
  readonly key: Buffer;
  readonly rangeEnd: Buffer | null;
  readonly keysOnly: boolean;
  readonly countOnly: boolean;
  /** Answer with the first value alone, as `etcdctl --print-value-only` prints it. */
  readonly printValueOnly: boolean;
  readonly limit: number;
  readonly revision: number;
  readonly sortTarget: string | null;
  readonly sortOrder: string | null;
}

/** A `put`; `lease` is etcd's int64 as a decimal string, `"0"` for none. */
export interface PutOp {
  readonly kind: "put";
  readonly key: Buffer;
  readonly value: Buffer;
  readonly lease: string;
  readonly prevKv: boolean;
  readonly ignoreLease: boolean;
  readonly ignoreValue: boolean;
}

/** A `del`: one key, or `[key, rangeEnd)`. */
export interface DeleteOp {
  readonly kind: "del";
  readonly key: Buffer;
  readonly rangeEnd: Buffer | null;
  readonly prevKv: boolean;
}

export type KvOp = RangeOp | PutOp | DeleteOp;

/** The range end a `get` or `del` names: its second argument, `--prefix`, `--from-key`, or none for one key. */
function rangeEndOf(doc: CommandDoc, key: Buffer, args: Arguments): Buffer | null {
  const explicit = args.positional[1];
  const prefix = args.flags.has("prefix");
  const fromKey = args.flags.has("from-key");
  if ([explicit !== undefined, prefix, fromKey].filter(Boolean).length > 1) {
    throw new PluginError("statementFailed", `${doc.name}: give one of <range_end>, --prefix and --from-key.`);
  }
  if (explicit !== undefined) return explicit.bytes;
  if (prefix) return key.length === 0 ? Buffer.from(NO_END) : prefixEnd(key);
  if (fromKey) return Buffer.from(NO_END);
  return null;
}

function choiceOf(doc: CommandDoc, args: Arguments, name: string, choices: Readonly<Record<string, string>>) {
  const value = args.flags.get(name);
  if (value === undefined) return null;
  const choice = typeof value === "string" ? choices[value.toUpperCase()] : undefined;
  if (choice === undefined) {
    throw new PluginError(
      "statementFailed",
      `${doc.name}: --${name} is one of ${Object.keys(choices).join(", ")}, not ${String(value)}.`,
    );
  }
  return choice;
}

/** A `get`, `put` or `del` line's tokens, the name first, as the op it runs; throws for any other command. */
export function kvOpOf(tokens: readonly Token[]): KvOp {
  const found = commandOf(tokens.map((token) => token.text));
  const name = found?.doc.name;
  if (found === null || (name !== "get" && name !== "put" && name !== "del")) {
    throw new PluginError(
      "statementFailed",
      `A txn branch runs get, put and del only, not ${tokens[0]?.text ?? "an empty line"}.`,
    );
  }
  const { doc } = found;
  const args = argumentsOf(doc, tokens.slice(found.length));
  const key = args.positional[0]?.bytes ?? Buffer.alloc(0);
  const rangeEnd = name === "put" ? null : rangeEndOf(doc, key, args);
  // etcd refuses an empty key; a range from `""` starts at `\0`, the first key there is.
  const start = rangeEnd !== null && key.length === 0 ? Buffer.from(NO_END) : key;
  switch (name) {
    case "get": {
      const sortTarget = choiceOf(doc, args, "sort-by", SORT_TARGETS);
      const order = choiceOf(doc, args, "order", SORT_ORDERS);
      return {
        kind: "get",
        key: start,
        rangeEnd,
        keysOnly: args.flags.has("keys-only"),
        countOnly: args.flags.has("count-only"),
        printValueOnly: args.flags.has("print-value-only"),
        limit: numberFlag(doc, args, "limit", 0),
        revision: numberFlag(doc, args, "rev", 0),
        sortTarget,
        sortOrder: order ?? (sortTarget === null ? null : (SORT_ORDERS[DEFAULT_ORDER] ?? null)),
      };
    }
    case "put": {
      const lease = args.flags.get("lease");
      return {
        kind: "put",
        key,
        value: args.positional[1]?.bytes ?? Buffer.alloc(0),
        lease: typeof lease === "string" ? leaseIdOf(doc, lease) : NO_LEASE,
        prevKv: args.flags.has("prev-kv"),
        ignoreLease: args.flags.has("ignore-lease"),
        ignoreValue: args.flags.has("ignore-value"),
      };
    }
    case "del":
      return { kind: "del", key: start, rangeEnd, prevKv: args.flags.has("prev-kv") };
  }
}

/** The op as the request etcd's `Range`, `Put` or `DeleteRange` takes, alone or in a `Txn`. */
export function requestOf(op: KvOp): IRequestOp {
  switch (op.kind) {
    case "get":
      return {
        request_range: {
          key: op.key,
          ...(op.rangeEnd === null ? {} : { range_end: op.rangeEnd }),
          limit: op.limit,
          revision: op.revision,
          keys_only: op.keysOnly,
          count_only: op.countOnly,
          ...(op.sortTarget === null ? {} : { sort_target: op.sortTarget as "Key" }),
          ...(op.sortOrder === null ? {} : { sort_order: op.sortOrder as "Ascend" }),
        },
      };
    case "put":
      return {
        request_put: {
          key: op.key,
          value: op.value,
          ...(op.ignoreLease ? {} : { lease: op.lease }),
          prev_kv: op.prevKv,
          ignore_lease: op.ignoreLease,
          ignore_value: op.ignoreValue,
        },
      };
    case "del":
      return {
        request_delete_range: {
          key: op.key,
          ...(op.rangeEnd === null ? {} : { range_end: op.rangeEnd }),
          prev_kv: op.prevKv,
        },
      };
  }
}

function sortName(table: Readonly<Record<string, string>>, value: string | null): string | null {
  return Object.entries(table).find(([, server]) => server === value)?.[0] ?? null;
}

/** The op as a console line that runs it again. */
export function opText(op: KvOp): string {
  const words: string[] = [op.kind, quoteBytes(op.key)];
  switch (op.kind) {
    case "get": {
      if (op.rangeEnd !== null) words.push(quoteBytes(op.rangeEnd));
      if (op.keysOnly) words.push("--keys-only");
      if (op.countOnly) words.push("--count-only");
      if (op.printValueOnly) words.push("--print-value-only");
      if (op.limit > 0) words.push(`--limit=${String(op.limit)}`);
      if (op.revision > 0) words.push(`--rev=${String(op.revision)}`);
      const target = sortName(SORT_TARGETS, op.sortTarget);
      const order = sortName(SORT_ORDERS, op.sortOrder);
      if (target !== null) words.push(`--sort-by=${target}`);
      if (order !== null && target !== null) words.push(`--order=${order}`);
      break;
    }
    case "put":
      words.push(op.ignoreValue ? '""' : quoteBytes(op.value));
      if (op.lease !== NO_LEASE && !op.ignoreLease) {
        words.push(`--lease=${DECIMAL.test(op.lease) ? hexId(op.lease) : op.lease}`);
      }
      if (op.prevKv) words.push("--prev-kv");
      if (op.ignoreLease) words.push("--ignore-lease");
      if (op.ignoreValue) words.push("--ignore-value");
      break;
    case "del":
      if (op.rangeEnd !== null) words.push(quoteBytes(op.rangeEnd));
      if (op.prevKv) words.push("--prev-kv");
      break;
  }
  return words.join(" ");
}
