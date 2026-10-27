import { PluginError } from "@table-craft/plugin-api";
import type { ICompare, ITxnRequest } from "etcd3";
import { hexId } from "./args.js";
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
const DECIMAL = /^\d+$/;
const HEX_ID = /^(?:0x)?[0-9a-f]+$/i;
const HEX_PREFIX = "0x";
const INDENT = "  ";

/** One compare; `value` holds bytes for `value(…)`, else etcd's int64 as a decimal string. */
export interface TxnCompare {
  readonly target: CompareTarget;
  readonly key: Buffer;
  readonly operator: CompareOperator;
  readonly value: Buffer | string;
}

export interface Txn {
  readonly compares: readonly TxnCompare[];
  readonly success: readonly KvOp[];
  readonly failure: readonly KvOp[];
}

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
  if (line[index] !== ")") throw failure(`${line} has no closing ) after the key.`);
  const rest = line.slice(index + 1).trimStart();
  const operator = OPERATORS.find((candidate) => rest.startsWith(candidate));
  if (operator === undefined) throw failure(`${line} needs one of =, !=, > and < after the key.`);
  const operands = tokenize(rest.slice(operator.length));
  const operand = operands[0];
  if (operand === undefined || operands.length > 1 || !operand.closed) {
    throw failure(`${line} needs one value after ${operator}.`);
  }
  if (target === "value") return { target, key, operator, value: operand.bytes };
  if (target === "lease") {
    if (!HEX_ID.test(operand.text)) throw failure(`a lease compares with a hex id or 0, not ${operand.text}.`);
    const hex = operand.text.toLowerCase().startsWith(HEX_PREFIX) ? operand.text : `${HEX_PREFIX}${operand.text}`;
    return { target, key, operator, value: BigInt(hex).toString() };
  }
  if (!DECIMAL.test(operand.text)) throw failure(`${target} compares with a whole number, not ${operand.text}.`);
  return { target, key, operator, value: BigInt(operand.text).toString() };
}

/** The lines of a block between `txn` and `end`, each with what it holds. */
function bodyLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const first = lines.findIndex((line) => !isCommentOrBlank(line));
  const head = tokenize(lines[first] ?? "");
  if (head.length !== 1 || head[0]?.text.toLowerCase() !== TXN) {
    throw failure("a block starts with txn alone on its line.");
  }
  const body: string[] = [];
  for (const line of lines.slice(first + 1)) {
    const trimmed = line.trim();
    if (trimmed.toLowerCase() === END) return body;
    if (!isCommentOrBlank(trimmed)) body.push(trimmed);
  }
  throw failure("the block has no end line. Close it with end.");
}

/** A whole `txn … end` block as the compares and the two lists of ops. */
export function parseTxn(text: string): Txn {
  const items: Record<Section, string[]> = { compares: [], success: [], failure: [] };
  let section: Section | null = null;
  for (const line of bodyLines(text)) {
    const heading = Object.keys(SECTIONS).find((word) => line.toLowerCase().startsWith(word)) as
      keyof typeof SECTIONS | undefined;
    let item = line;
    if (heading !== undefined) {
      section = SECTIONS[heading];
      item = line.slice(heading.length).trim();
      if (item === "") continue;
    }
    if (section === null) throw failure(`${line} comes before if:, then: or else:. Start each list with its heading.`);
    items[section].push(item);
  }
  return {
    compares: items.compares.map(parseCompare),
    success: items.success.map((line) => kvOpOf(tokenize(line))),
    failure: items.failure.map((line) => kvOpOf(tokenize(line))),
  };
}

/** The compare as etcd's `Compare` takes it. */
export function compareOf(compare: TxnCompare): ICompare {
  const base = { key: compare.key, target: SERVER_TARGETS[compare.target], result: SERVER_RESULTS[compare.operator] };
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
    success: txn.success.map(requestOf),
    failure: txn.failure.map(requestOf),
  };
}

/** Whether running the block may write, in either branch. */
export function txnWrites(txn: Txn): boolean {
  return [...txn.success, ...txn.failure].some((op) => op.kind !== "get");
}

function compareText(compare: TxnCompare): string {
  const operand =
    compare.target === "value"
      ? quoteBytes(compare.value as Buffer)
      : compare.target === "lease"
        ? hexId(compare.value as string)
        : (compare.value as string);
  const key = quoteBytes(compare.key);
  // Bare, a key holding `)` would end the compare early.
  return `${compare.target}(${key.startsWith('"') ? key : `"${key}"`}) ${compare.operator} ${operand}`;
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
    ...sectionText("then:", txn.success.map(opText)),
    ...sectionText("else:", txn.failure.map(opText)),
    END,
  ].join("\n");
}
