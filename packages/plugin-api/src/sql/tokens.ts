/** What a dialect needs the shared splitter and classifier to know (decision 023). */
export interface SqlDialectOptions {
  /** PostgreSQL `$tag$ … $tag$` strings. */
  readonly dollarQuotes?: boolean;
  /** MySQL `'\''`: a backslash escapes the next character in strings and double-quoted text. */
  readonly backslashEscapes?: boolean;
  /** The MySQL client's `DELIMITER //` line, which changes what ends a statement. */
  readonly delimiterCommand?: boolean;
  /** PostgreSQL block comments nest: a comment inside a comment needs its own close. */
  readonly nestedBlockComments?: boolean;
  /** MySQL `# comment`; PostgreSQL uses `#` as an operator. */
  readonly hashComments?: boolean;
  /** Keywords that open a body holding semicolons, closed by `END`, inside `CREATE TRIGGER`, `FUNCTION` and the like. */
  readonly blockKeywords?: readonly string[];
  /** The statements that move the session's current namespace in this dialect (plan 022). */
  readonly namespaceStatements?: readonly NamespaceStatementForm[];
  /** SQL Server `[name]`, where `]]` is a `]` inside the name (decision 100). */
  readonly bracketIdentifiers?: boolean;
  /**
   * A line that ends a batch and belongs to no statement: SQL Server's `GO` (optionally `GO 3`) or
   * Oracle's `/`. A routine definition, and under `slash` an anonymous block, keeps its own `;` and
   * runs to that line (decision 100).
   */
  readonly batchSeparator?: BatchSeparator;
  /** Oracle `q'[…]'` strings, whose delimiter is chosen per string. */
  readonly qQuotes?: boolean;
  /** `N'…'` national character strings. */
  readonly nationalStrings?: boolean;
}

export type BatchSeparator = "go" | "slash";

/**
 * `use` is MySQL's `USE db`; `searchPath` is PostgreSQL's `SET [SESSION | LOCAL] search_path`,
 * `SET SCHEMA` and `RESET search_path` / `RESET ALL`; `alterSessionSchema` is Oracle's
 * `ALTER SESSION SET CURRENT_SCHEMA = name`.
 */
export type NamespaceStatementForm = "use" | "searchPath" | "alterSessionSchema";

export type TokenKind = "word" | "quoted" | "string" | "comment" | "symbol" | "delimiter";

export interface Token {
  readonly kind: TokenKind;
  readonly from: number;
  readonly to: number;
}

export const DEFAULT_DELIMITER = ";";

const NEWLINE = "\n";
const FIRST_NON_ASCII = 0x80;
const DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/y;
/** PostgreSQL's `E'…'` string, where backslashes escape whatever the dialect's default. */
const ESCAPE_STRING_PREFIX = /^[eE]$/;
const NATIONAL_STRING_PREFIX = /^[nN]$/;
/** Oracle's `q'…'` and `Nq'…'`. */
const Q_QUOTE_PREFIX = /^[nN]?[qQ]$/;
const Q_QUOTE_PAIRS: ReadonlyMap<string, string> = new Map([
  ["[", "]"],
  ["{", "}"],
  ["(", ")"],
  ["<", ">"],
]);
const STRING_QUOTE = "'";
const BRACKET_OPEN = "[";
const BRACKET_CLOSE = "]";

function isSpace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f" || char === "\v";
}

function isWordChar(char: string): boolean {
  const code = char.charCodeAt(0);
  if (code >= FIRST_NON_ASCII) return true;
  return (
    (char >= "a" && char <= "z") ||
    (char >= "A" && char <= "Z") ||
    (char >= "0" && char <= "9") ||
    char === "_" ||
    char === "$"
  );
}

/** A hand-written scanner: it knows quoting and comments, never grammar, so it cannot reject a statement. */
export class Lexer {
  position = 0;

  constructor(
    readonly text: string,
    readonly options: SqlDialectOptions,
  ) {}

  /** The next token after whitespace, or null at the end. `delimiter` ends a statement wherever it starts outside quotes. */
  next(delimiter: string = DEFAULT_DELIMITER): Token | null {
    const text = this.text;
    let at = this.position;
    while (at < text.length && isSpace(text.charAt(at))) at += 1;
    if (at >= text.length) {
      this.position = at;
      return null;
    }
    const char = text.charAt(at);
    const following = text.charAt(at + 1);
    let token: Token;
    if (char === "-" && following === "-") token = this.#lineComment(at);
    else if (char === "#" && this.options.hashComments === true) token = this.#lineComment(at);
    else if (char === "/" && following === "*") token = this.#blockComment(at);
    else if (text.startsWith(delimiter, at)) token = { kind: "delimiter", from: at, to: at + delimiter.length };
    else if (char === "'") token = this.#quoted(at, "'", "string", this.options.backslashEscapes === true);
    else if (char === '"') token = this.#quoted(at, '"', "quoted", this.options.backslashEscapes === true);
    else if (char === "`") token = this.#quoted(at, "`", "quoted", false);
    else if (char === BRACKET_OPEN && this.options.bracketIdentifiers === true) token = this.#bracketed(at);
    else if (char === "$" && this.options.dollarQuotes === true && this.#dollarTag(at) !== null) {
      token = this.#dollarQuoted(at, this.#dollarTag(at) ?? "");
    } else if (isWordChar(char)) token = this.#word(at, delimiter);
    else token = { kind: "symbol", from: at, to: at + 1 };
    this.position = token.to;
    return token;
  }

  #lineComment(from: number): Token {
    const end = this.text.indexOf(NEWLINE, from);
    return { kind: "comment", from, to: end < 0 ? this.text.length : end };
  }

  #blockComment(from: number): Token {
    const text = this.text;
    const nested = this.options.nestedBlockComments === true;
    let depth = 1;
    let at = from + 2;
    while (at < text.length && depth > 0) {
      if (text.startsWith("*/", at)) {
        depth -= 1;
        at += 2;
      } else if (nested && text.startsWith("/*", at)) {
        depth += 1;
        at += 2;
      } else {
        at += 1;
      }
    }
    return { kind: "comment", from, to: Math.min(at, text.length) };
  }

  /** A doubled quote is the quote itself; an unterminated one runs to the end of the text. */
  #quoted(from: number, quote: string, kind: TokenKind, backslashEscapes: boolean): Token {
    const text = this.text;
    let at = from + 1;
    while (at < text.length) {
      const char = text.charAt(at);
      if (backslashEscapes && char === "\\") {
        at += 2;
      } else if (char === quote) {
        if (text.charAt(at + 1) !== quote) return { kind, from, to: at + 1 };
        at += 2;
      } else {
        at += 1;
      }
    }
    return { kind, from, to: text.length };
  }

  /** `]]` is a `]` inside the name; `[` needs no escape. */
  #bracketed(from: number): Token {
    const text = this.text;
    let at = from + 1;
    while (at < text.length) {
      if (text.charAt(at) === BRACKET_CLOSE) {
        if (text.charAt(at + 1) !== BRACKET_CLOSE) return { kind: "quoted", from, to: at + 1 };
        at += 2;
      } else {
        at += 1;
      }
    }
    return { kind: "quoted", from, to: text.length };
  }

  /** `q'<open>…<close>'`, where `[`, `{`, `(` and `<` close with their pair and any other character with itself. */
  #qQuoted(from: number, quote: number): Token | null {
    const open = this.text.charAt(quote + 1);
    if (open === "" || isSpace(open)) return null;
    const terminator = (Q_QUOTE_PAIRS.get(open) ?? open) + STRING_QUOTE;
    const end = this.text.indexOf(terminator, quote + 2);
    return { kind: "string", from, to: end < 0 ? this.text.length : end + terminator.length };
  }

  #dollarTag(at: number): string | null {
    if (at > 0 && isWordChar(this.text.charAt(at - 1))) return null;
    DOLLAR_TAG.lastIndex = at;
    return DOLLAR_TAG.exec(this.text)?.[0] ?? null;
  }

  #dollarQuoted(from: number, tag: string): Token {
    const end = this.text.indexOf(tag, from + tag.length);
    return { kind: "string", from, to: end < 0 ? this.text.length : end + tag.length };
  }

  #word(from: number, delimiter: string): Token {
    const text = this.text;
    const customDelimiter = delimiter !== DEFAULT_DELIMITER;
    let at = from;
    while (at < text.length && isWordChar(text.charAt(at))) {
      if (customDelimiter && at > from && text.startsWith(delimiter, at)) break;
      at += 1;
    }
    if (text.charAt(at) !== STRING_QUOTE) return { kind: "word", from, to: at };
    const prefix = text.slice(from, at);
    if (ESCAPE_STRING_PREFIX.test(prefix)) {
      const string = this.#quoted(at, STRING_QUOTE, "string", true);
      return { kind: "string", from, to: string.to };
    }
    if (this.options.qQuotes === true && Q_QUOTE_PREFIX.test(prefix)) {
      const string = this.#qQuoted(from, at);
      if (string !== null) return string;
    }
    if (this.options.nationalStrings === true && NATIONAL_STRING_PREFIX.test(prefix)) {
      const string = this.#quoted(at, STRING_QUOTE, "string", this.options.backslashEscapes === true);
      return { kind: "string", from, to: string.to };
    }
    return { kind: "word", from, to: at };
  }
}

/** A batch separator line: where it ends, and `GO <n>`'s count. */
export interface SeparatorLine {
  readonly to: number;
  readonly repeat: number | undefined;
}

const GO = "GO";
const SLASH = "/";
/** What may follow `GO` on its line: a count, then a comment, as `sqlcmd` reads it. */
const GO_REST = /^(?:[ \t]+([1-9]\d*))?[ \t]*(?:--.*)?\r?$/;
const SLASH_REST = /^[ \t]*\r?$/;
const LINE_INDENT = /^[ \t]*$/;

/** The separator line `token` starts, or null when `token` is not alone on its line as one. */
export function separatorLineAt(text: string, token: Token, separator: BatchSeparator): SeparatorLine | null {
  const lineStart = text.lastIndexOf(NEWLINE, token.from - 1) + 1;
  if (!LINE_INDENT.test(text.slice(lineStart, token.from))) return null;
  const newline = text.indexOf(NEWLINE, token.to);
  const lineEnd = newline < 0 ? text.length : newline;
  const rest = text.slice(token.to, lineEnd);
  const word = text.slice(token.from, token.to);
  if (separator === "slash") {
    return token.kind === "symbol" && word === SLASH && SLASH_REST.test(rest)
      ? { to: lineEnd, repeat: undefined }
      : null;
  }
  if (token.kind !== "word" || word.toUpperCase() !== GO) return null;
  const match = GO_REST.exec(rest);
  if (match === null) return null;
  const count = match[1];
  return { to: lineEnd, repeat: count === undefined ? undefined : Number(count) };
}

/** Every token of `text` but comments, as one dialect reads it. */
export function significantTokens(text: string, options: SqlDialectOptions): Token[] {
  const lexer = new Lexer(text, options);
  const tokens: Token[] = [];
  for (let token = lexer.next(); token !== null; token = lexer.next()) {
    if (token.kind !== "comment") tokens.push(token);
  }
  return tokens;
}

export function wordOf(text: string, token: Token): string {
  return text.slice(token.from, token.to).toUpperCase();
}
