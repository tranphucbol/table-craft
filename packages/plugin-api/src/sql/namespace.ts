import { PluginError, type NamespaceSwitch } from "@table-craft/plugin-api";
import { closingQuote, unquote, type Identifier } from "./scope.js";
import {
  Lexer,
  significantTokens,
  wordOf,
  type NamespaceStatementForm,
  type SqlDialectOptions,
  type Token,
} from "./tokens.js";

/** Where a session-namespace statement points unqualified names. */
export interface NamespaceTarget {
  readonly kind: "database" | "schema";
  /** In the order the statement lists them; empty for `DEFAULT` and `RESET`, which restore the server's setting. */
  readonly candidates: readonly Identifier[];
}

const USE = "USE";
const SET = "SET";
const RESET = "RESET";
const SET_SCOPES = new Set(["SESSION", "LOCAL"]);
const SEARCH_PATH = "SEARCH_PATH";
const SCHEMA = "SCHEMA";
const ALL = "ALL";
const ASSIGNMENTS = new Set(["TO", "="]);
const DEFAULT = "DEFAULT";
const LIST_SEPARATOR = ",";
const STRING_QUOTE = "'";
const BLOCK_COMMENT_END = "*/";

function identifier(text: string, token: Token | undefined): Identifier | null {
  if (token === undefined) return null;
  const raw = text.slice(token.from, token.to);
  const { from, to } = token;
  if (token.kind === "word") return { name: raw, quoted: false, from, to };
  if (token.kind === "quoted") return { name: unquote(raw), quoted: true, from, to };
  // search_path quotes each element (GUC_LIST_QUOTE), so a string element is an exact name.
  if (token.kind === "string" && raw.startsWith(STRING_QUOTE)) return { name: unquote(raw), quoted: true, from, to };
  return null;
}

function wordAt(text: string, tokens: readonly Token[], at: number): string | undefined {
  const token = tokens[at];
  if (token === undefined) return undefined;
  return token.kind === "word" || token.kind === "symbol" ? wordOf(text, token) : undefined;
}

function useTarget(text: string, tokens: readonly Token[]): NamespaceTarget | null {
  if (tokens.length !== 2 || wordAt(text, tokens, 0) !== USE) return null;
  const name = identifier(text, tokens[1]);
  return name === null || tokens[1]?.kind === "string" ? null : { kind: "database", candidates: [name] };
}

/** `a, "b", 'c'` from `at` to the end; null when it is not such a list. */
function list(text: string, tokens: readonly Token[], at: number): Identifier[] | null {
  const names: Identifier[] = [];
  for (let index = at; index < tokens.length; index += 2) {
    const name = identifier(text, tokens[index]);
    if (name === null) return null;
    names.push(name);
    const separator = tokens[index + 1];
    if (separator !== undefined && wordAt(text, tokens, index + 1) !== LIST_SEPARATOR) return null;
    if (separator !== undefined && index + 2 >= tokens.length) return null;
  }
  return names.length === 0 ? null : names;
}

function searchPathTarget(text: string, tokens: readonly Token[]): NamespaceTarget | null {
  const first = wordAt(text, tokens, 0);
  if (first === RESET) {
    const what = wordAt(text, tokens, 1);
    return tokens.length === 2 && (what === SEARCH_PATH || what === ALL) ? { kind: "schema", candidates: [] } : null;
  }
  if (first !== SET) return null;
  let at = SET_SCOPES.has(wordAt(text, tokens, 1) ?? "") ? 2 : 1;
  const parameter = wordAt(text, tokens, at);
  at += 1;
  if (parameter === SEARCH_PATH) {
    if (!ASSIGNMENTS.has(wordAt(text, tokens, at) ?? "")) return null;
    at += 1;
  } else if (parameter !== SCHEMA) {
    return null;
  }
  if (tokens.length === at + 1 && tokens[at]?.kind === "word" && wordAt(text, tokens, at) === DEFAULT) {
    return { kind: "schema", candidates: [] };
  }
  const names = list(text, tokens, at);
  if (names === null || (parameter === SCHEMA && names.length !== 1)) return null;
  return { kind: "schema", candidates: names };
}

const ALTER_SESSION_PREFIX = ["ALTER", "SESSION", "SET", "CURRENT_SCHEMA", "="];

function alterSessionPrefix(text: string, tokens: readonly Token[]): boolean {
  return ALTER_SESSION_PREFIX.every((word, at) => wordAt(text, tokens, at) === word);
}

function alterSessionTarget(text: string, tokens: readonly Token[]): NamespaceTarget | null {
  if (tokens.length !== ALTER_SESSION_PREFIX.length + 1 || !alterSessionPrefix(text, tokens)) return null;
  const token = tokens[ALTER_SESSION_PREFIX.length];
  const name = identifier(text, token);
  return name === null || token?.kind === "string" ? null : { kind: "schema", candidates: [name] };
}

/** The caret's place in a session-namespace statement's target list. */
export interface NamespaceSlot {
  readonly kind: NamespaceTarget["kind"];
  /** What accepting an item replaces; inside a quote it starts after the quote. */
  readonly from: number;
  readonly to: number;
  /** The quote the caret is inside, and whether the name already closes it. */
  readonly quote: { readonly char: string; readonly closed: boolean } | null;
  /** The names the statement lists before the caret's. */
  readonly listed: readonly Identifier[];
}

const NAME_TOKENS = new Set<Token["kind"]>(["word", "quoted", "string"]);

/** The statement's tokens around `offset`, comments dropped; null when the caret is in a comment. */
function tokensAround(text: string, offset: number, dialect: SqlDialectOptions): Token[] | null {
  const lexer = new Lexer(text, dialect);
  let tokens: Token[] = [];
  for (let token = lexer.next(); token !== null; token = lexer.next()) {
    if (token.kind === "comment") {
      if (token.from < offset && offset < token.to) return null;
      if (offset === token.to && !text.slice(token.from, token.to).endsWith(BLOCK_COMMENT_END)) return null;
      continue;
    }
    if (token.kind === "delimiter") {
      if (token.to <= offset) tokens = [];
      else if (token.from >= offset) break;
      continue;
    }
    tokens.push(token);
  }
  return tokens;
}

function closes(raw: string): boolean {
  return raw.length >= 2 && raw.endsWith(closingQuote(raw.charAt(0)));
}

/** The names of `name , name ,` from `at` to the end; null when the tokens are not such a list. */
function listedBefore(text: string, tokens: readonly Token[], at: number): Identifier[] | null {
  if ((tokens.length - at) % 2 !== 0) return null;
  const names: Identifier[] = [];
  for (let index = at; index < tokens.length; index += 2) {
    const name = identifier(text, tokens[index]);
    if (name === null || wordAt(text, tokens, index + 1) !== LIST_SEPARATOR) return null;
    names.push(name);
  }
  return names;
}

function searchPathListStart(text: string, tokens: readonly Token[]): { at: number; single: boolean } | null {
  if (wordAt(text, tokens, 0) !== SET) return null;
  let at = SET_SCOPES.has(wordAt(text, tokens, 1) ?? "") ? 2 : 1;
  const parameter = wordAt(text, tokens, at);
  at += 1;
  if (parameter === SCHEMA) return { at, single: true };
  if (parameter !== SEARCH_PATH || !ASSIGNMENTS.has(wordAt(text, tokens, at) ?? "")) return null;
  return { at: at + 1, single: false };
}

/**
 * Where the caret at `offset` names a namespace a session-namespace statement of the dialect moves
 * to: `USE |`, `ALTER SESSION SET CURRENT_SCHEMA = |` or the elements of `SET search_path TO a, |`
 * and `SET SCHEMA |`. Null anywhere else,
 * and after a name whose closing quote is typed.
 */
export function namespaceSlotAt(text: string, offset: number, dialect: SqlDialectOptions): NamespaceSlot | null {
  const forms = dialect.namespaceStatements ?? [];
  if (forms.length === 0) return null;
  const tokens = tokensAround(text, offset, dialect);
  if (tokens === null) return null;
  const touched = tokens.findIndex((token) => token.from < offset && offset <= token.to);
  const prefix = touched >= 0 && NAME_TOKENS.has(tokens[touched]?.kind ?? "symbol") ? tokens[touched] : undefined;
  const before = tokens.filter((token) => (prefix === undefined ? token.to <= offset : token.to <= prefix.from));
  let from = prefix?.from ?? offset;
  let quote: NamespaceSlot["quote"] = null;
  if (prefix !== undefined && prefix.kind !== "word") {
    const raw = text.slice(prefix.from, prefix.to);
    const char = raw.charAt(0);
    if (prefix.kind === "string" && char !== STRING_QUOTE) return null;
    const closed = closes(raw);
    if (closed && offset === prefix.to) return null;
    quote = { char, closed };
    from = prefix.from + char.length;
  }
  for (const form of forms) {
    if (form === "use") {
      if (prefix?.kind === "string" || before.length !== 1 || wordAt(text, before, 0) !== USE) continue;
      return { kind: "database", from, to: offset, quote, listed: [] };
    }
    if (form === "alterSessionSchema") {
      if (prefix?.kind === "string" || before.length !== ALTER_SESSION_PREFIX.length) continue;
      if (!alterSessionPrefix(text, before)) continue;
      return { kind: "schema", from, to: offset, quote, listed: [] };
    }
    const start = searchPathListStart(text, before);
    if (start === null) continue;
    if (start.single && before.length !== start.at) continue;
    const listed = listedBefore(text, before, start.at);
    if (listed !== null) return { kind: "schema", from, to: offset, quote, listed };
  }
  return null;
}

/**
 * Whether `sql` is a statement that moves the session's current namespace in a dialect declaring
 * `namespaceStatements`, and where it points. It never asks the server, so a named namespace may
 * not exist; the session's `currentNamespace()` is the truth once the statement ran.
 */
export function namespaceTarget(sql: string, dialect: SqlDialectOptions): NamespaceTarget | null {
  const forms = dialect.namespaceStatements ?? [];
  if (forms.length === 0) return null;
  const tokens = significantTokens(sql, dialect).filter((token) => token.kind !== "delimiter");
  for (const form of forms) {
    const target = TARGET_READERS[form](sql, tokens);
    if (target !== null) return target;
  }
  return null;
}

const TARGET_READERS: Readonly<
  Record<NamespaceStatementForm, (text: string, tokens: readonly Token[]) => NamespaceTarget | null>
> = {
  use: useTarget,
  searchPath: searchPathTarget,
  alterSessionSchema: alterSessionTarget,
};

const SWITCH_TARGETS: Readonly<Record<NamespaceStatementForm, NamespaceSwitch["targets"]>> = {
  use: "topLevel",
  searchPath: "schema",
  alterSessionSchema: "schema",
};

const SWITCH_STATEMENTS: Readonly<Record<NamespaceStatementForm, (quoted: string) => string>> = {
  use: (quoted) => `USE ${quoted}`,
  searchPath: (quoted) => `SET search_path TO ${quoted}`,
  alterSessionSchema: (quoted) => `ALTER SESSION SET CURRENT_SCHEMA = ${quoted}`,
};

/**
 * The console's namespace switch for a dialect moving its namespace by `form` (decision 060):
 * `USE db`, or a search path of exactly the one schema, so nothing unqualified resolves in a schema
 * the console's label does not show. Only the search path is undone by a rollback.
 */
export function namespaceSwitcher(
  form: NamespaceStatementForm,
  quoteIdentifier: (name: string) => string,
): NamespaceSwitch {
  return {
    targets: SWITCH_TARGETS[form],
    transactional: form === "searchPath",
    statement(path) {
      const name = path.at(-1);
      if (name === undefined) {
        throw new PluginError("statementFailed", "A namespace switch names no namespace; pick one from the list.");
      }
      return SWITCH_STATEMENTS[form](quoteIdentifier(name));
    },
  };
}
