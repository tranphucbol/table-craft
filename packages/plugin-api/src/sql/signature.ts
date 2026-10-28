import { statementTokens } from "./scope.js";
import type { SqlDialectOptions, Token } from "./tokens.js";

/** The function call around a caret, before the plugin looks its name up. */
export interface CallAt {
  /** As written. */
  readonly name: string;
  /** The top-level commas before the caret. */
  readonly argument: number;
  /**
   * The call's top-level `,` and words before the caret, in order, words upper case: what moves a
   * keyword-led parameter list such as `EXTRACT(YEAR FROM d)` along. Always set by `callAt`;
   * optional so a value built against the older shape still type-checks (decision 106).
   */
  readonly separators?: readonly string[];
  readonly from: number;
  readonly to: number;
}

/** A callable name before `(`: one word, or `pkg.member` read as one. */
interface CallName {
  readonly written: string;
  readonly from: number;
}

interface Frame {
  /** The name before the `(` when it may call a function; null for a grouping parenthesis. */
  readonly name: CallName | null;
  /** Whether a word other than a callable name sits right before the `(`: `IN (`, `t (`, `VALUES (`. */
  readonly named: boolean;
  readonly open: number;
  commas: number;
  readonly separators: string[];
}

const COMMA = ",";
const MEMBER_SEPARATOR = ".";
/** Calls a procedure by name, so it may come before a package member as it never may before a function. */
const CALL_WORD = "CALL";

/** Words a relation or routine name follows, so `TABLE upper (` defines rather than calls. */
const NAME_INTRODUCERS = new Set([
  "CALL",
  "EXISTS",
  "FROM",
  "FUNCTION",
  "INDEX",
  "INTO",
  "JOIN",
  "KEY",
  "PROCEDURE",
  "REFERENCES",
  "TABLE",
  "TRIGGER",
  "UPDATE",
  "VIEW",
]);
const QUERY_STARTS = new Set(["SELECT", "WITH"]);

function symbol(text: string, token: Token | undefined, char: string): boolean {
  return token?.kind === "symbol" && text.slice(token.from, token.to) === char;
}

function upperWord(text: string, token: Token | undefined): string | null {
  return token?.kind === "word" ? text.slice(token.from, token.to).toUpperCase() : null;
}

/**
 * Finds the innermost call around `offset` whose name `known` accepts, counting its top-level
 * commas and listing its separators; strings, comments and quoted names are tokens of their own,
 * so their commas never count. `pkg.member (` asks `known` for `PKG.MEMBER`.
 * Grouping parentheses are looked through; a subquery, a non-function name before `(` or a caret
 * in a string or comment ends the search with null. `reserved` holds the dialect's keywords: a
 * function spelled like one (`VALUES`, `LEFT`) is a call only where an operand fits, not after a
 * name such as `INSERT INTO t VALUES (`.
 */
export function callAt(
  text: string,
  offset: number,
  dialect: SqlDialectOptions,
  reserved: ReadonlySet<string>,
  known: (name: string) => boolean,
): CallAt | null {
  const { tokens, literal } = statementTokens(text, offset, dialect);
  if (literal) return null;

  /** `pkg.member` ending at `at`, when the package's spec knows the member. */
  function member(at: number): CallName | null {
    const name = tokens[at];
    const owner = tokens[at - 2];
    const word = upperWord(text, name);
    const ownerWord = upperWord(text, owner);
    if (name === undefined || owner === undefined || word === null || ownerWord === null) return null;
    if (!known(`${ownerWord}${MEMBER_SEPARATOR}${word}`)) return null;
    const previous = upperWord(text, tokens[at - 3]);
    if (previous !== null && previous !== CALL_WORD && NAME_INTRODUCERS.has(previous)) return null;
    return {
      written: `${text.slice(owner.from, owner.to)}${MEMBER_SEPARATOR}${text.slice(name.from, name.to)}`,
      from: owner.from,
    };
  }

  function callable(at: number): CallName | null {
    const name = tokens[at];
    const before = tokens[at - 1];
    if (symbol(text, before, MEMBER_SEPARATOR)) return member(at);
    const word = upperWord(text, name);
    if (name === undefined || word === null || !known(word)) return null;
    const found = { written: text.slice(name.from, name.to), from: name.from };
    const previous = upperWord(text, before);
    if (previous !== null && NAME_INTRODUCERS.has(previous)) return null;
    if (!reserved.has(word)) return found;
    const operandFits =
      before === undefined ||
      (before.kind === "symbol" && !symbol(text, before, ")")) ||
      (previous !== null && reserved.has(previous));
    return operandFits ? found : null;
  }

  const frames: Frame[] = [];
  let index = 0;
  for (; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || token.from >= offset) break;
    if (symbol(text, token, "(")) {
      const name = callable(index - 1);
      frames.push({
        name,
        named: name === null && !grouping(text, tokens[index - 1]),
        open: index,
        commas: 0,
        separators: [],
      });
    } else if (symbol(text, token, ")")) frames.pop();
    else if (symbol(text, token, COMMA)) {
      const top = frames.at(-1);
      if (top !== undefined) {
        top.commas += 1;
        top.separators.push(COMMA);
      }
    } else {
      const word = upperWord(text, token);
      if (word !== null) frames.at(-1)?.separators.push(word);
    }
  }

  for (let depth = frames.length - 1; depth >= 0; depth -= 1) {
    const frame = frames[depth];
    if (frame === undefined) return null;
    if (frame.name === null) {
      if (frame.named || QUERY_STARTS.has(upperWord(text, tokens[frame.open + 1]) ?? "")) return null;
      continue;
    }
    return {
      name: frame.name.written,
      argument: frame.commas,
      separators: frame.separators,
      from: frame.name.from,
      to: closeOf(text, tokens, index, frames.length - depth) ?? offset,
    };
  }
  return null;
}

/** Whether a `(` after `before` only groups: it starts the statement or follows an operator or operand keyword. */
function grouping(text: string, before: Token | undefined): boolean {
  if (before === undefined) return true;
  if (before.kind === "symbol") return !symbol(text, before, ")");
  return GROUPING_WORDS.has(upperWord(text, before) ?? "");
}

/** Keywords an operand follows, so a `(` right after one groups an expression instead of naming a list. */
const GROUPING_WORDS = new Set([
  "AND",
  "AS",
  "BETWEEN",
  "BY",
  "CASE",
  "DISTINCT",
  "ELSE",
  "HAVING",
  "IS",
  "LIKE",
  "NOT",
  "ON",
  "OR",
  "RETURN",
  "SELECT",
  "SET",
  "THEN",
  "WHEN",
  "WHERE",
  "XOR",
]);

/** The end of the `)` closing the call `levels` parentheses up from the caret, if the statement has one. */
function closeOf(text: string, tokens: readonly Token[], from: number, levels: number): number | null {
  let open = levels;
  for (let at = from; at < tokens.length; at += 1) {
    const token = tokens[at];
    if (symbol(text, token, "(")) open += 1;
    else if (symbol(text, token, ")")) {
      open -= 1;
      if (open === 0) return token?.to ?? null;
    }
  }
  return null;
}
