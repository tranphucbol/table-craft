import { PluginError } from "@table-craft/plugin-api";
import type { ICompare, ITxnRequest } from "etcd3";
import { hexId } from "./args.js";
import { consoleInt64, consoleLeaseId } from "./consoleNumbers.js";
import { kvOpOf, opText, requestOf, type KvOp } from "./ops.js";
import { isCommentOrBlank, quoteBytes, readQuoted, tokenize } from "./tokens.js";

/**
 * A `txn` block (decision 8 of plan 110): `txn`, then `if:` compares, `then:` and `else:` ops,
 * one per line, a section's first item on its own heading line or the next, closed by `end`.
 */
export const TXN = "txn";
export const END = "end";

export const COMPARE_TARGETS = ["value", "mod", "create", "version", "lease"] as const;
export type CompareTarget = (typeof COMPARE_TARGETS)[number];
const OPERATORS = ["!=", "=", ">", "<"] as const;
export type CompareOperator = (typeof OPERATORS)[number];

const SECTIONS = { "if:": "compares", "then:": "success", "else:": "failure" } as const;
type Section = (typeof SECTIONS)[keyof typeof SECTIONS];

const SERVER_TARGETS: Readonly<Record<CompareTarget, ICompare["target"]>> = {
  value: "Value",
  mod: "Mod",
  create: "Create",
  version: "Version",
  lease: "Lease",
};
const SERVER_RESULTS: Readonly<Record<CompareOperator, ICompare["result"]>> = {
  "=": "Equal",
  "!=": "NotEqual",
  ">": "Greater",
  "<": "Less",
};
const COMPARE_HEAD = new RegExp(`^(${COMPARE_TARGETS.join("|")})\\(`, "i");
const INDENT = "  ";

/** One compare; `value` holds bytes for `value(…)`, else etcd's int64 as a decimal string. */
export interface TxnCompare {
  readonly target: CompareTarget;
  readonly key: Buffer;
  readonly rangeEnd?: Buffer;
  readonly operator: CompareOperator;
  readonly value: Buffer | string;
}

export interface Txn {
  readonly compares: readonly TxnCompare[];
  readonly success: readonly TxnOp[];
  readonly failure: readonly TxnOp[];
}

export type TxnOp = KvOp | { readonly kind: "txn"; readonly transaction: Txn };
export const TXN_MAX_DEPTH = 8;
export const TXN_OPERATION_LIMIT = 128;
export const TXN_MAX_BYTES = 1_048_576;

function failure(message: string): PluginError {
  return new PluginError("statementFailed", `txn: ${message}`);
}

/** One compare line, such as `value("a") = "1"` or `mod("b") > 5`. */
export function parseCompare(line: string): TxnCompare {
  const head = COMPARE_HEAD.exec(line);
  if (head === null) {
    throw failure(`${line} is not a compare. Write value("k") = "v", mod("k") > 5, create, version or lease.`);
  }
  const target = (head[1] ?? "").toLowerCase() as CompareTarget;
  let index = head[0].length;
  let key: Buffer;
  if (line[index] === '"' || line[index] === "'") {
    const read = readQuoted(line, index);
    if (!read.closed) throw failure(`the key in ${line} has no closing quote.`);
    key = Buffer.from(read.bytes);
    index = read.end;
  } else {
    const close = line.indexOf(")", index);
    if (close < 0) throw failure(`${line} has no closing ).`);
    key = Buffer.from(line.slice(index, close), "utf8");
    index = close;
  }
  while (index < line.length && /\s/.test(line[index] ?? "")) index += 1;
  let rangeEnd: Buffer | undefined;
  if (line[index] === ",") {
    index += 1;
    while (/\s/.test(line[index] ?? "") && index < line.length) index += 1;
    const end = readQuoted(line, index);
    if ((line[index] !== '"' && line[index] !== "'") || !end.closed) throw failure("range end must be quoted.");
    rangeEnd = Buffer.from(end.bytes);
    index = end.end;
    while (index < line.length && /\s/.test(line[index] ?? "")) index += 1;
  }
  if (line[index] !== ")") throw failure(`${line} has no closing ) after the key.`);
  const range = rangeEnd === undefined ? {} : { rangeEnd };
  const rest = line.slice(index + 1).trimStart();
  const operator = OPERATORS.find((candidate) => rest.startsWith(candidate));
  if (operator === undefined) throw failure(`${line} needs one of =, !=, > and < after the key.`);
  const operands = tokenize(rest.slice(operator.length));
  const operand = operands[0];
  if (operand === undefined || operands.length > 1 || !operand.closed) {
    throw failure(`${line} needs one value after ${operator}.`);
  }
  if (target === "value") return { target, key, ...range, operator, value: operand.bytes };
  if (target === "lease") {
    return { target, key, ...range, operator, value: consoleLeaseId(operand.text) };
  }
  return { target, key, ...range, operator, value: consoleInt64(operand.text) };
}

/** A whole `txn … end` block as the compares and the two lists of ops. */
export function parseTxn(text: string): Txn {
  if (Buffer.byteLength(text) > TXN_MAX_BYTES) throw failure("transaction exceeds the configured byte limit.");
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => !isCommentOrBlank(line));
  let at = 0;
  let operations = 0;
  function block(depth: number): Txn {
    if (depth > TXN_MAX_DEPTH) throw failure(`maximum depth is ${String(TXN_MAX_DEPTH)}.`);
    if (lines[at++]?.toLowerCase() !== TXN) throw failure("a block starts with txn alone on its line.");
    const compares: TxnCompare[] = [];
    const success: TxnOp[] = [];
    const failureOps: TxnOp[] = [];
    let section: Section | null = null;
    const seen = new Set<Section>();
    while (at < lines.length) {
      let line = lines[at++] ?? "";
      if (line.toLowerCase() === END) return { compares, success, failure: failureOps };
      const heading = Object.keys(SECTIONS).find((word) => line.toLowerCase().startsWith(word)) as
        keyof typeof SECTIONS | undefined;
      if (heading !== undefined) {
        section = SECTIONS[heading];
        if (seen.has(section)) throw failure("duplicate section heading.");
        seen.add(section);
        line = line.slice(heading.length).trim();
        if (line === "") continue;
      }
      if (section === null)
        throw failure(`${line} comes before if:, then: or else:. Start each list with its heading.`);
      operations += 1;
      if (operations > TXN_OPERATION_LIMIT)
        throw failure(`configured operation limit is ${String(TXN_OPERATION_LIMIT)}.`);
      if (section === "compares") compares.push(parseCompare(line));
      else {
        let op: TxnOp;
        if (line.toLowerCase() === TXN) {
          at -= 1;
          lines[at] = TXN;
          op = { kind: "txn", transaction: block(depth + 1) };
        } else {
          const tokens = tokenize(line);
          if (tokens.some((token) => !token.closed)) throw failure("unclosed quote.");
          const parsed = kvOpOf(tokens);
          op =
            parsed.kind === "put" ? { ...parsed, lease: BigInt.asIntN(64, BigInt(parsed.lease)).toString() } : parsed;
        }
        (section === "success" ? success : failureOps).push(op);
      }
    }
    throw failure("the block has no end line. Close it with end.");
  }
  const txn = block(1);
  if (at !== lines.length) throw failure("unexpected text after end.");
  return txn;
}

/** The compare as etcd's `Compare` takes it. */
export function compareOf(compare: TxnCompare): ICompare {
  const base = {
    key: compare.key,
    ...(compare.rangeEnd === undefined ? {} : { range_end: compare.rangeEnd }),
    target: SERVER_TARGETS[compare.target],
    result: SERVER_RESULTS[compare.operator],
  };
  switch (compare.target) {
    case "value":
      return { ...base, value: compare.value as Buffer };
    case "mod":
      return { ...base, mod_revision: compare.value as string };
    case "create":
      return { ...base, create_revision: compare.value as string };
    case "version":
      return { ...base, version: compare.value as string };
    case "lease":
      return { ...base, lease: compare.value as string };
  }
}

/** The block as etcd's `Txn` request. */
export function txnRequestOf(txn: Txn): ITxnRequest {
  return {
    compare: txn.compares.map(compareOf),
    success: txn.success.map(txnOpRequest),
    failure: txn.failure.map(txnOpRequest),
  };
}

/** Whether running the block may write, in either branch. */
export function txnWrites(txn: Txn): boolean {
  return [...txn.success, ...txn.failure].some((op) =>
    op.kind === "txn" ? txnWrites(op.transaction) : op.kind !== "get",
  );
}

function txnOpRequest(op: TxnOp) {
  return op.kind === "txn" ? { request_txn: txnRequestOf(op.transaction) } : requestOf(op);
}

function compareText(compare: TxnCompare): string {
  const operand =
    compare.target === "value"
      ? quoteBytes(compare.value as Buffer)
      : compare.target === "lease"
        ? hexId(BigInt.asUintN(64, BigInt(compare.value as string)).toString())
        : (compare.value as string);
  const key = quoteBytes(compare.key);
  // Bare, a key holding `)` would end the compare early.
  const end = compare.rangeEnd === undefined ? "" : `,${forceQuoted(compare.rangeEnd)}`;
  return `${compare.target}(${key.startsWith('"') ? key : `"${key}"`}${end}) ${compare.operator} ${operand}`;
}

function forceQuoted(bytes: Buffer): string {
  const text = quoteBytes(bytes);
  return text.startsWith('"') ? text : `"${text}"`;
}

function sectionText(heading: string, lines: readonly string[]): string[] {
  if (lines.length === 0) return [];
  return [`${heading} ${lines[0] ?? ""}`, ...lines.slice(1).map((line) => `${INDENT}${line}`)];
}

/** The block as console text that runs it again. */
export function txnText(txn: Txn): string {
  return [
    TXN,
    ...sectionText("if:", txn.compares.map(compareText)),
    ...sectionText(
      "then:",
      txn.success.map((op) => (op.kind === "txn" ? txnText(op.transaction) : opText(op))),
    ),
    ...sectionText(
      "else:",
      txn.failure.map((op) => (op.kind === "txn" ? txnText(op.transaction) : opText(op))),
    ),
    END,
  ].join("\n");
}
