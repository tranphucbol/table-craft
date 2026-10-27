import type { InspectionRequest, Problem, QuickFix, StatementClass, StatementSpan } from "@table-craft/plugin-api";
import { isFlag } from "./args.js";
import { commandOf } from "./docs.js";
import { END, TXN } from "./txn.js";
import { isCommentOrBlank, tokenize, type Token } from "./tokens.js";

/** The inspection id of a costly-command mark, which the user can turn off. */
export const COSTLY_INSPECTION = "EtcdCostlyCommand";

const RANGE_LIMIT = "1000";
const LINE_BREAK = /\r?\n/g;
const RANGE_FLAGS = ["--prefix", "--from-key"];
const BRANCH_HEADINGS = /^(?:if:|then:|else:)\s*/i;
const WRITE_OPS = new Set(["put", "del"]);

interface Line {
  readonly from: number;
  readonly to: number;
  readonly text: string;
}

function linesOf(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (const lineBreak of [...text.matchAll(LINE_BREAK), null]) {
    const end = lineBreak === null ? text.length : lineBreak.index;
    lines.push({ from: start, to: end, text: text.slice(start, end) });
    if (lineBreak !== null) start = lineBreak.index + lineBreak[0].length;
  }
  return lines;
}

function isTxnHead(line: string): boolean {
  const tokens = tokenize(line);
  return tokens.length === 1 && tokens[0]?.text.toLowerCase() === TXN;
}

/**
 * Every command of `text`: one per line, blank and `#` comment lines skipped, and a `txn` block
 * through its `end` line as one command; a block without `end` runs to the end of the text.
 */
export function split(text: string): StatementSpan[] {
  const spans: StatementSpan[] = [];
  const lines = linesOf(text);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || isCommentOrBlank(line.text)) continue;
    const from = line.from + (line.text.length - line.text.trimStart().length);
    let last = line;
    if (isTxnHead(line.text)) {
      while (index + 1 < lines.length && last.text.trim().toLowerCase() !== END) {
        index += 1;
        last = lines[index] ?? last;
      }
      while (isCommentOrBlank(last.text) && last !== line) last = lines[--index] ?? line;
    }
    const to = last.from + last.text.trimEnd().length;
    spans.push({ from, to, sql: text.slice(from, to) });
  }
  return spans;
}

/** The lower-case command words of a line, flags left out: `["lease", "grant", "60"]`. */
export function wordsOf(tokens: readonly Token[]): string[] {
  return tokens.filter((token) => !isFlag(token)).map((token) => token.text.toLowerCase());
}

function hasFlag(tokens: readonly Token[], ...names: readonly string[]): boolean {
  return tokens.some((token) => isFlag(token) && names.some((name) => token.text.split("=")[0] === name));
}

/** Whether a `get` or `del` names more than one key: a range end, `--prefix` or `--from-key`. */
function namesRange(tokens: readonly Token[]): boolean {
  const positional = tokens.filter((token) => !isFlag(token));
  return positional.length > 2 || hasFlag(tokens, ...RANGE_FLAGS);
}

function shownKey(token: Token | undefined): string {
  return JSON.stringify(token?.text ?? "");
}

function destructiveOf(name: string, tokens: readonly Token[]): { reason: string; byName: boolean } | null {
  const key = tokens.filter((token) => !isFlag(token))[1];
  switch (name) {
    case "del": {
      if (!namesRange(tokens)) return null;
      const everything = (key?.text ?? "") === "" && hasFlag(tokens, ...RANGE_FLAGS);
      if (everything) return { reason: "del deletes every key", byName: true };
      if (hasFlag(tokens, "--prefix")) return { reason: `del deletes every key under ${shownKey(key)}`, byName: false };
      if (hasFlag(tokens, "--from-key"))
        return { reason: `del deletes every key from ${shownKey(key)} on`, byName: false };
      return { reason: "del deletes a range of keys", byName: false };
    }
    case "compaction":
      return { reason: `compaction discards every revision before ${key?.text ?? "the one given"}`, byName: false };
    case "lease revoke":
      return { reason: "lease revoke deletes every key attached to the lease", byName: false };
    default:
      return null;
  }
}

/** What makes a command costly, and the fix that bounds it, if one is known. */
interface Costly {
  readonly reason: string;
  readonly fix: { readonly title: string; readonly text: string } | null;
}

function costlyOf(line: string, name: string, tokens: readonly Token[]): Costly | null {
  if (name === "defrag") return { reason: "defrag blocks the member while it rewrites its storage", fix: null };
  if (name !== "get" || !namesRange(tokens) || hasFlag(tokens, "--limit", "--count-only")) return null;
  return {
    reason: "get of a range without --limit reads every key in it",
    fix: { title: `Add --limit=${RANGE_LIMIT}`, text: `${line.trimEnd()} --limit=${RANGE_LIMIT}` },
  };
}

/** Whether any op of a `txn` block writes: a `put` or `del` line in either branch. */
function txnWrites(block: string): boolean {
  return block
    .split(LINE_BREAK)
    .slice(1)
    .some((line) => {
      const first = tokenize(line.trim().replace(BRANCH_HEADINGS, ""))[0];
      return first !== undefined && WRITE_OPS.has(first.text.toLowerCase());
    });
}

function nameOf(tokens: readonly Token[]): string {
  return commandOf(tokens.map((token) => token.text))?.doc.name ?? tokens[0]?.text.toLowerCase() ?? "";
}

/** What a command does: from the command table, a `txn` by its branches' ops. */
export function classify(command: string): StatementClass {
  const firstLine = command.split(LINE_BREAK)[0] ?? "";
  if (isTxnHead(firstLine)) return { kind: txnWrites(command) ? "write" : "read", destructive: null };
  const tokens = tokenize(command);
  const found = commandOf(tokens.map((token) => token.text));
  const name = nameOf(tokens);
  const destructive = destructiveOf(name, tokens);
  const costly = costlyOf(command, name, tokens);
  return {
    kind: found?.doc.kind ?? "other",
    destructive: destructive?.reason ?? null,
    ...(costly === null ? {} : { costly: costly.reason }),
    ...(destructive?.byName === true ? { confirmByName: true } : {}),
  };
}

/** A mark on every costly command of the text, with the bounded command as its fix. */
export function inspect(request: InspectionRequest): Promise<readonly Problem[]> {
  if (request.disabled?.includes(COSTLY_INSPECTION) === true) return Promise.resolve([]);
  const problems: Problem[] = [];
  for (const span of split(request.text)) {
    if (isTxnHead(span.sql.split(LINE_BREAK)[0] ?? "")) continue;
    const tokens = tokenize(span.sql);
    const costly = costlyOf(span.sql, nameOf(tokens), tokens);
    if (costly === null) continue;
    const fixes: QuickFix[] =
      costly.fix === null
        ? []
        : [{ title: costly.fix.title, edits: [{ from: span.from, to: span.to, insert: costly.fix.text }] }];
    const first = tokens[0];
    problems.push({
      from: span.from + (first?.from ?? 0),
      to: span.from + (first?.to ?? span.sql.length),
      severity: "warning",
      inspection: COSTLY_INSPECTION,
      message: costly.reason,
      fixes,
    });
  }
  return Promise.resolve(problems);
}
