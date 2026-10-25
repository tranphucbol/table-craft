import type { InspectionRequest, Problem, QuickFix, StatementClass, StatementSpan } from "@table-craft/plugin-api";
import { COMMAND_FLAGS } from "./subcommands.generated.js";
import { isCommentOrBlank, tokenize, type Token } from "./tokens.js";

/** The inspection id of a costly-command mark (decision 112), which the user can turn off. */
export const COSTLY_INSPECTION = "RedisCostlyCommand";

const SCAN_COUNT = "1000";
const FIRST_WINDOW = "99";
const XRANGE_COUNT = "100";
const LINE_BREAK = /\r?\n/g;

/** Every command line of `text`: one statement per line, blank and `#` comment lines skipped. */
export function split(text: string): StatementSpan[] {
  const spans: StatementSpan[] = [];
  let start = 0;
  const breaks = [...text.matchAll(LINE_BREAK)];
  for (const lineBreak of [...breaks, null]) {
    const end = lineBreak === null ? text.length : lineBreak.index;
    const line = text.slice(start, end);
    if (!isCommentOrBlank(line)) {
      const from = start + (line.length - line.trimStart().length);
      const to = start + line.trimEnd().length;
      spans.push({ from, to, sql: text.slice(from, to) });
    }
    if (lineBreak !== null) start = lineBreak.index + lineBreak[0].length;
  }
  return spans;
}

/** The upper-case command words of a line: `["CONFIG", "SET", …]`. */
export function wordsOf(tokens: readonly Token[]): string[] {
  return tokens.map((token) => token.text.toUpperCase());
}

/** The command's name as `COMMAND_FLAGS` keys it: `CONFIG SET` for a container's subcommand. */
export function commandKey(words: readonly string[]): string {
  const [name = "", second] = words;
  if (second !== undefined && COMMAND_FLAGS[`${name} ${second}`] !== undefined) return `${name} ${second}`;
  return name;
}

const CONFIRM_BY_NAME = new Set(["FLUSHALL", "FLUSHDB"]);

const DESTRUCTIVE: Readonly<Record<string, string>> = {
  FLUSHALL: "FLUSHALL deletes every key in every database",
  FLUSHDB: "FLUSHDB deletes every key in the database",
  SHUTDOWN: "SHUTDOWN stops the server",
  "SCRIPT FLUSH": "SCRIPT FLUSH removes every cached script",
  "FUNCTION FLUSH": "FUNCTION FLUSH deletes every function",
  "CONFIG SET": "CONFIG SET changes the server's configuration",
  "CONFIG RESETSTAT": "CONFIG RESETSTAT resets the server's statistics",
  DEBUG: "DEBUG can stall or crash the server",
  "CLUSTER RESET": "CLUSTER RESET takes the node out of its cluster",
  "CLUSTER FAILOVER": "CLUSTER FAILOVER swaps a replica in for its primary",
  "CLUSTER FORGET": "CLUSTER FORGET removes a node from the cluster",
  SWAPDB: "SWAPDB swaps the contents of two databases",
};

function destructiveOf(key: string, tokens: readonly Token[]): string | null {
  const reason = DESTRUCTIVE[key];
  if (reason !== undefined) return reason;
  const keys = tokens.length - 1;
  if ((key === "DEL" || key === "UNLINK") && keys > 1) return `${key} of ${String(keys)} keys`;
  return null;
}

/** What makes a command costly, and the fix that bounds it, if one is known (decision 9 of plan 058). */
interface Costly {
  readonly reason: string;
  readonly fix: { readonly title: string; readonly text: string } | null;
}

function source(line: string, token: Token | undefined): string {
  return token === undefined ? "" : line.slice(token.from, token.to);
}

function isWholeRange(words: readonly string[]): boolean {
  return words[2] === "0" && words[3] === "-1";
}

function costlyOf(line: string, tokens: readonly Token[]): Costly | null {
  const words = wordsOf(tokens);
  const key = source(line, tokens[1]);
  switch (words[0]) {
    case "KEYS":
      return {
        reason: "KEYS walks every key and blocks the server while it does",
        fix: { title: "Use SCAN", text: `SCAN 0 MATCH ${source(line, tokens[1]) || "*"} COUNT ${SCAN_COUNT}` },
      };
    case "HGETALL":
      return {
        reason: "HGETALL reads the whole hash",
        fix: { title: "Use HSCAN", text: `HSCAN ${key} 0 COUNT ${SCAN_COUNT}` },
      };
    case "SMEMBERS":
      return {
        reason: "SMEMBERS reads the whole set",
        fix: { title: "Use SSCAN", text: `SSCAN ${key} 0 COUNT ${SCAN_COUNT}` },
      };
    case "LRANGE":
      return isWholeRange(words)
        ? {
            reason: "LRANGE 0 -1 reads the whole list",
            fix: { title: "Read the first 100", text: `LRANGE ${key} 0 ${FIRST_WINDOW}` },
          }
        : null;
    case "ZRANGE":
      return isWholeRange(words) && tokens.length === 4
        ? {
            reason: "ZRANGE 0 -1 reads the whole sorted set",
            fix: { title: "Read the first 100", text: `ZRANGE ${key} 0 ${FIRST_WINDOW}` },
          }
        : null;
    case "SORT":
      return { reason: "SORT reads and sorts the whole collection", fix: null };
    case "XRANGE":
    case "XREVRANGE":
      return words.includes("COUNT") || tokens.length < 4
        ? null
        : {
            reason: `${words[0]} without COUNT reads the whole range`,
            fix: { title: `Add COUNT ${XRANGE_COUNT}`, text: `${line.trimEnd()} COUNT ${XRANGE_COUNT}` },
          };
    default:
      return null;
  }
}

/** What a command does, from the 7.4 flags snapshot; the live server's flags gate a read-only session. */
export function classify(command: string): StatementClass {
  const tokens = tokenize(command);
  const words = wordsOf(tokens);
  const key = commandKey(words);
  const flags = COMMAND_FLAGS[key] ?? [];
  const destructive = destructiveOf(key, tokens);
  const costly = costlyOf(command, tokens);
  return {
    kind: flags.includes("write") ? "write" : flags.includes("readonly") ? "read" : "other",
    destructive,
    ...(words[0] === "SELECT" ? { setsNamespace: true } : {}),
    ...(costly === null ? {} : { costly: costly.reason }),
    ...(destructive !== null && CONFIRM_BY_NAME.has(key) ? { confirmByName: true } : {}),
  };
}

/** A mark on every costly command of the text, with the bounded command as its fix. */
export function inspect(request: InspectionRequest): Promise<readonly Problem[]> {
  if (request.disabled?.includes(COSTLY_INSPECTION) === true) return Promise.resolve([]);
  const problems: Problem[] = [];
  for (const span of split(request.text)) {
    const tokens = tokenize(span.sql);
    const costly = costlyOf(span.sql, tokens);
    if (costly === null) continue;
    const fixes: QuickFix[] =
      costly.fix === null
        ? []
        : [{ title: costly.fix.title, edits: [{ from: span.from, to: span.to, insert: costly.fix.text }] }];
    const name = tokens[0];
    problems.push({
      from: span.from + (name?.from ?? 0),
      to: span.from + (name?.to ?? span.sql.length),
      severity: "warning",
      inspection: COSTLY_INSPECTION,
      message: costly.reason,
      fixes,
    });
  }
  return Promise.resolve(problems);
}
