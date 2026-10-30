import type {
  CommandTransaction,
  CommandTransactionBuilder,
  CommandTransactionCompare,
  CommandTransactionOperation,
  KeyBytes,
  KeyRange,
} from "@table-craft/plugin-api";
import { bytesOf, keyBytesOf } from "./keyBytes.js";
import { consoleInt64 } from "./consoleNumbers.js";
import { kvOpOf } from "./ops.js";
import { NO_END, prefixEnd } from "./scan.js";
import { quoteBytes, tokenize } from "./tokens.js";
import {
  parseTxn,
  txnText,
  TXN_MAX_BYTES,
  TXN_MAX_DEPTH,
  TXN_OPERATION_LIMIT,
  type Txn,
  type TxnCompare,
  type TxnOp,
} from "./txn.js";

const TARGETS = {
  value: "value",
  version: "version",
  createRevision: "create",
  modRevision: "mod",
  lease: "lease",
} as const;
const MAX_TEXT = 200_000;

function buffer(key: KeyBytes): Buffer {
  if (key.hex !== null && !/^(?:[0-9a-fA-F]{2})*$/.test(key.hex)) throw new Error("Invalid hex bytes.");
  const result = bytesOf(key);
  if (result.length > TXN_MAX_BYTES) throw new Error("Key/value exceeds configured byte limit.");
  return result;
}

function rangeOf(range: KeyRange): { key: Buffer; rangeEnd: Buffer | null } {
  switch (range.kind) {
    case "key":
      return { key: buffer(range.key), rangeEnd: null };
    case "prefix": {
      const key = buffer(range.prefix);
      return key.length === 0
        ? { key: Buffer.from(NO_END), rangeEnd: Buffer.from(NO_END) }
        : { key, rangeEnd: prefixEnd(key) };
    }
    case "range":
      return { key: buffer(range.from), rangeEnd: buffer(range.to) };
    case "all":
      return { key: Buffer.from(NO_END), rangeEnd: Buffer.from(NO_END) };
  }
}

function publicRange(key: Buffer, end: Buffer | null): KeyRange {
  if (end === null) return { kind: "key", key: keyBytesOf(key) };
  if (key.equals(Buffer.from(NO_END)) && end.equals(Buffer.from(NO_END))) return { kind: "all" };
  if (prefixEnd(key).equals(end)) return { kind: "prefix", prefix: keyBytesOf(key) };
  return { kind: "range", from: keyBytesOf(key), to: keyBytesOf(end) };
}

function publicCompare(compare: TxnCompare): CommandTransactionCompare {
  const target =
    compare.target === "mod" ? "modRevision" : compare.target === "create" ? "createRevision" : compare.target;
  return {
    range: publicRange(compare.key, compare.rangeEnd ?? null),
    target,
    operator: compare.operator,
    operand: Buffer.isBuffer(compare.value) ? keyBytesOf(compare.value) : compare.value,
  };
}

function publicOp(op: TxnOp): CommandTransactionOperation {
  if (op.kind === "txn") return { kind: "txn", transaction: publicTxn(op.transaction) };
  if (op.kind === "put") {
    if (op.prevKv || op.ignoreValue) throw new Error("Put options cannot be represented by the builder.");
    return {
      kind: "put",
      key: keyBytesOf(op.key),
      value: keyBytesOf(op.value),
      lease: op.ignoreLease
        ? { kind: "preserve" }
        : op.lease === "0"
          ? { kind: "detach" }
          : { kind: "attach", leaseId: op.lease },
    };
  }
  if (
    op.kind === "del"
      ? op.prevKv
      : op.keysOnly ||
        op.countOnly ||
        op.printValueOnly ||
        op.limit !== 0 ||
        String(op.revision) !== "0" ||
        op.sortTarget !== null ||
        op.sortOrder !== null
  ) {
    throw new Error("Range options cannot be represented by the builder.");
  }
  return { kind: op.kind === "del" ? "delete" : "get", range: publicRange(op.key, op.rangeEnd) };
}

function publicTxn(txn: Txn): CommandTransaction {
  return {
    compare: txn.compares.map(publicCompare),
    success: txn.success.map(publicOp),
    failure: txn.failure.map(publicOp),
  };
}

function nativeTxn(transaction: CommandTransaction, depth = 1, budget = { count: 0 }): Txn {
  if (depth > TXN_MAX_DEPTH) throw new Error(`Maximum transaction depth is ${String(TXN_MAX_DEPTH)}.`);
  budget.count += transaction.compare.length + transaction.success.length + transaction.failure.length;
  if (budget.count > TXN_OPERATION_LIMIT)
    throw new Error(`Configured operation limit is ${String(TXN_OPERATION_LIMIT)} (not a measured server limit).`);
  const compares = transaction.compare.map((compare): TxnCompare => {
    const range = rangeOf(compare.range);
    const operand = compare.operand;
    if (compare.target === "value" ? typeof operand === "string" : typeof operand !== "string")
      throw new Error("Compare operand does not match its target.");
    if (typeof operand === "string") consoleInt64(operand, compare.target === "lease");
    return {
      key: range.key,
      ...(range.rangeEnd === null ? {} : { rangeEnd: range.rangeEnd }),
      target: TARGETS[compare.target],
      operator: compare.operator,
      value: typeof operand === "string" ? operand : buffer(operand),
    };
  });
  const opOf = (op: CommandTransactionOperation): TxnOp => {
    if (op.kind === "txn") return { kind: "txn", transaction: nativeTxn(op.transaction, depth + 1, budget) };
    if (op.kind === "put") {
      let suffix = "";
      if (op.lease.kind === "preserve") suffix = " --ignore-lease";
      if (op.lease.kind === "attach") {
        consoleInt64(op.lease.leaseId, true);
        if (BigInt(op.lease.leaseId) === 0n) throw new Error("Lease ID must be a nonzero decimal int64.");
        suffix = ` --lease=${BigInt.asUintN(64, BigInt(op.lease.leaseId)).toString(16)}`;
      }
      const parsed = kvOpOf(tokenize(`put ${quoteBytes(buffer(op.key))} ${quoteBytes(buffer(op.value))}${suffix}`));
      return parsed.kind === "put" && op.lease.kind === "attach" ? { ...parsed, lease: op.lease.leaseId } : parsed;
    }
    const range = rangeOf(op.range);
    const parsed = kvOpOf(
      tokenize(
        `${op.kind === "delete" ? "del" : "get"} ${quoteBytes(range.key)}${range.rangeEnd === null ? "" : ` ${quoteBytes(range.rangeEnd)}`}`,
      ),
    );
    return parsed;
  };
  return { compares, success: transaction.success.map(opOf), failure: transaction.failure.map(opOf) };
}

interface Write {
  readonly key: Buffer;
  readonly end: Buffer | null;
  readonly branches: ReadonlyMap<number, boolean>;
}

export function transactionErrors(txn: Txn): string[] {
  const writes: Write[] = [];
  const errors: string[] = [];
  let id = 0;
  function validateRange(key: Buffer, end: Buffer | null) {
    if (key.length === 0) errors.push("An exact key must not be empty.");
    if (end !== null && end.length === 0) errors.push("Range end must not be empty.");
    if (end !== null && !end.equals(Buffer.from(NO_END)) && Buffer.compare(key, end) >= 0)
      errors.push("Range end must be greater than its start.");
  }
  function visit(block: Txn, branches: ReadonlyMap<number, boolean>) {
    const blockId = id++;
    for (const compare of block.compares) validateRange(compare.key, compare.rangeEnd ?? null);
    for (const [branch, ops] of [
      [true, block.success],
      [false, block.failure],
    ] as const) {
      const path = new Map(branches).set(blockId, branch);
      for (const op of ops) {
        if (op.kind === "txn") visit(op.transaction, path);
        else {
          const end = op.kind === "put" ? null : op.rangeEnd;
          validateRange(op.key, end);
          if (op.kind !== "get") writes.push({ key: op.key, end, branches: path });
        }
      }
    }
  }
  visit(txn, new Map());
  function beforeEnd(key: Buffer, end: Buffer) {
    return end.equals(Buffer.from(NO_END)) || Buffer.compare(key, end) < 0;
  }
  for (let i = 0; i < writes.length; i += 1) {
    const a = writes[i];
    if (a === undefined) continue;
    for (const b of writes.slice(i + 1)) {
      if ([...a.branches].some(([branch, value]) => b.branches.has(branch) && b.branches.get(branch) !== value))
        continue;
      const overlap =
        a.end === null
          ? b.end === null
            ? a.key.equals(b.key)
            : Buffer.compare(a.key, b.key) >= 0 && beforeEnd(a.key, b.end)
          : b.end === null
            ? Buffer.compare(b.key, a.key) >= 0 && beforeEnd(b.key, a.end)
            : beforeEnd(a.key, b.end) && beforeEnd(b.key, a.end);
      if (overlap) errors.push("Duplicate or conflicting writes may modify the same key in one transaction branch.");
    }
  }
  return [...new Set(errors)];
}

/** Builder uses the execution parser; unsupported options never silently disappear from manual text. */
export const transactionBuilder: CommandTransactionBuilder = {
  parse(text, offset) {
    if (text.length > MAX_TEXT || !Number.isInteger(offset) || offset < 0 || offset > text.length)
      return { kind: "unparsed", reason: "Text or caret exceeds configured bounds." };
    const lines = text.split(/\r?\n/);
    let position = 0;
    let start: number | null = null;
    let depth = 0;
    for (const line of lines) {
      const item = line.trim().replace(/^(?:then:|else:)\s*/i, "");
      if (item.toLowerCase() === "txn") {
        if (depth === 0) start = position + line.indexOf(line.trimStart());
        depth += 1;
      }
      if (item.toLowerCase() === "end" && depth > 0) {
        depth -= 1;
        const to = position + line.trimEnd().length;
        if (depth === 0 && start !== null && offset >= start && offset <= to) {
          try {
            return { kind: "parsed", transaction: publicTxn(parseTxn(text.slice(start, to))), from: start, to };
          } catch (error) {
            return { kind: "unparsed", reason: error instanceof Error ? error.message : "Edited by hand" };
          }
        }
      }
      position += line.length + (text[position + line.length] === "\r" ? 2 : 1);
    }
    return { kind: "unparsed", reason: "No complete supported transaction at the caret. Edited by hand." };
  },
  serialize(transaction) {
    const budget = { count: 0 };
    try {
      const txn = nativeTxn(transaction, 1, budget);
      const text = txnText(txn);
      const errors = transactionErrors(txn);
      if (Buffer.byteLength(text) > TXN_MAX_BYTES || text.length > MAX_TEXT)
        errors.push("Transaction exceeds configured text/byte limit.");
      return { text, operationCount: budget.count, operationLimit: TXN_OPERATION_LIMIT, errors };
    } catch (error) {
      return {
        text: "",
        operationCount: budget.count,
        operationLimit: TXN_OPERATION_LIMIT,
        errors: [error instanceof Error ? error.message : "Invalid transaction"],
      };
    }
  },
};
