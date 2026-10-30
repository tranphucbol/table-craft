import type {
  CommandTransaction,
  CommandTransactionCompare,
  CommandTransactionOperation,
  KeyBytes,
} from "@table-craft/desktop/engine/protocol.js";

export const EMPTY_TRANSACTION: CommandTransaction = { compare: [], success: [], failure: [] };
export const DEFAULT_OPERATION_LIMIT = 128;
export const MAX_TRANSACTION_DEPTH = 8;
export const EMPTY_BYTES = { text: "", hex: null } as const;
export const COMPARE_TARGETS = [
  { value: "value", label: "Value" },
  { value: "version", label: "Version" },
  { value: "createRevision", label: "Created rev" },
  { value: "modRevision", label: "Modified rev" },
  { value: "lease", label: "Lease" },
] as const;
export const COMPARE_OPERATORS = ["=", "!=", "<", ">"] as const;
const HEX_DIGITS_PER_BYTE = 2;

export function byteEncoding(value: KeyBytes, encoding: "text" | "hex"): KeyBytes {
  if (encoding === "hex")
    return value.hex !== null
      ? value
      : {
          text: "",
          hex: Array.from(new TextEncoder().encode(value.text), (byte) =>
            byte.toString(16).padStart(HEX_DIGITS_PER_BYTE, "0"),
          ).join(""),
        };
  if (value.hex === null || !/^(?:[\da-f]{2})*$/i.test(value.hex)) return value;
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(
        Uint8Array.from(value.hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16)),
      ),
      hex: null,
    };
  } catch {
    return value;
  }
}

export function newCompare(): CommandTransactionCompare {
  return { range: { kind: "key", key: EMPTY_BYTES }, target: "modRevision", operator: "=", operand: "0" };
}

export function newOperation(kind: CommandTransactionOperation["kind"]): CommandTransactionOperation {
  if (kind === "txn") return { kind, transaction: EMPTY_TRANSACTION };
  if (kind === "put") return { kind, key: EMPTY_BYTES, value: EMPTY_BYTES, lease: { kind: "detach" } };
  return { kind, range: { kind: "key", key: EMPTY_BYTES } };
}

export function moved<T>(rows: readonly T[], index: number, delta: number): readonly T[] {
  const destination = index + delta;
  if (index < 0 || index >= rows.length || destination < 0 || destination >= rows.length) return rows;
  const result = [...rows];
  const row = result.splice(index, 1)[0];
  if (row !== undefined) result.splice(destination, 0, row);
  return result;
}

export function validSpan(text: string, from: number, to: number): boolean {
  return Number.isInteger(from) && Number.isInteger(to) && from >= 0 && to >= from && to <= text.length;
}

export function transactionCount(transaction: CommandTransaction): number {
  return (
    transaction.compare.length +
    [...transaction.success, ...transaction.failure].reduce(
      (count, operation) => count + 1 + (operation.kind === "txn" ? transactionCount(operation.transaction) : 0),
      0,
    )
  );
}

export function transactionProblems(transaction: CommandTransaction, depth = 1): readonly string[] {
  const errors: string[] = [];
  if (depth === 1 && transactionCount(transaction) > DEFAULT_OPERATION_LIMIT)
    errors.push(
      `The builder supports at most ${String(DEFAULT_OPERATION_LIMIT)} checks and operations across all branches.`,
    );
  const bytes = (value: { readonly text: string | null; readonly hex: string | null }) => {
    if (value.hex !== null && (!/^[\da-f]*$/i.test(value.hex) || value.hex.length % 2 !== 0)) {
      errors.push("Hex must contain complete byte pairs (00–ff), without spaces.");
    }
  };
  const range = (value: CommandTransactionCompare["range"]) => {
    if (value.kind === "key") bytes(value.key);
    if (value.kind === "prefix") bytes(value.prefix);
    if (value.kind === "range") {
      bytes(value.from);
      bytes(value.to);
    }
  };
  if (depth > MAX_TRANSACTION_DEPTH)
    errors.push(`Transactions can nest at most ${String(MAX_TRANSACTION_DEPTH)} levels.`);
  for (const compare of transaction.compare) {
    range(compare.range);
    if (typeof compare.operand !== "string") bytes(compare.operand);
    else if (!/^(0|[1-9]\d{0,19})$/.test(compare.operand))
      errors.push("Comparisons need a whole decimal number, without leading zeros.");
  }
  for (const operation of [...transaction.success, ...transaction.failure]) {
    if (operation.kind === "txn") errors.push(...transactionProblems(operation.transaction, depth + 1));
    else if (operation.kind === "put") {
      bytes(operation.key);
      bytes(operation.value);
      if (operation.lease.kind === "attach" && !/^-?[1-9]\d{0,19}$/.test(operation.lease.leaseId))
        errors.push("Lease ID must be a nonzero decimal number.");
    } else range(operation.range);
  }
  return [...new Set(errors)];
}
