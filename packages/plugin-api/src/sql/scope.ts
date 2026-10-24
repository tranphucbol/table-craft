import { Lexer, type SqlDialectOptions, type Token } from "./tokens.js";

/** A name as written: `name` is unquoted, `quoted` says whether the dialect folds it. */
export interface Identifier {
  readonly name: string;
  readonly quoted: boolean;
  readonly from: number;
  readonly to: number;
}

/** `[schema.]table [AS] alias` in a FROM, JOIN, UPDATE or INTO; spans cover the name through the alias. */
export interface RelationSource {
  readonly kind: "relation";
  readonly qualifier: readonly Identifier[];
  readonly name: Identifier;
  readonly alias: Identifier | null;
  readonly from: number;
  readonly to: number;
}

/** `( SELECT … ) [AS] alias`. */
export interface DerivedSource {
  readonly kind: "derived";
  readonly alias: Identifier | null;
  readonly query: Query;
  readonly from: number;
  readonly to: number;
}

export type Source = RelationSource | DerivedSource;

/** A select-list entry: the name it is read back by, or a `*` / `x.*`. */
export type SelectItem =
  | { readonly kind: "named"; readonly name: Identifier }
  | { readonly kind: "star"; readonly qualifier: Identifier | null };

export interface Cte {
  readonly name: Identifier;
  /** `WITH x (a, b) AS …`; null when the select list names the columns. */
  readonly columns: readonly Identifier[] | null;
  readonly query: Query;
}

/** One `SELECT`, `UPDATE`, `INSERT` or `DELETE` level: the statement itself or a parenthesised subquery. */
export interface Query {
  readonly ctes: readonly Cte[];
  readonly sources: readonly Source[];
  /** The first select list, which is what a CTE or derived table exposes. */
  readonly select: readonly SelectItem[];
  /** `INSERT INTO t (…)`: the target and the column list's parentheses, as text offsets. */
  readonly insert: { readonly source: RelationSource; readonly from: number; readonly to: number } | null;
  /** The query this one is nested in, whose sources and CTEs it can also see. */
  readonly parent: Query | null;
}

/**
 * What the caret is completing: `relation` after FROM, JOIN, UPDATE or INTO (`join` after JOIN),
 * `columns` in an expression, `insertColumns` in `INSERT INTO t (…)`, `keywords` elsewhere, `none`
 * inside a string or comment.
 */
export type Clause = "relation" | "join" | "columns" | "insertColumns" | "keywords" | "none";

export interface ScopeAt {
  readonly clause: Clause;
  /** The names before the dots ahead of the caret's word, outermost first: `s.t.c` at `c` gives [s, t]. */
  readonly qualifier: readonly Identifier[];
  /** Where the word the caret is in starts; the caret itself when it is in none. */
  readonly prefixFrom: number;
  /** The whole word the caret touches, when it is a name. */
  readonly word: Identifier | null;
  /** Whether a `.` follows the word, so it qualifies another name. */
  readonly dotAfter: boolean;
  readonly query: Query;
}

interface MutableQuery {
  ctes: Cte[];
  sources: Source[];
  select: SelectItem[];
  insert: Query["insert"];
  parent: Query | null;
}

const OPEN = "(";
const CLOSE = ")";
const DOT = ".";
const COMMA = ",";
const NO_GROUP = -1;
const QUERY_STARTS = new Set(["SELECT", "WITH"]);
const RELATION_INTRODUCERS = new Set(["FROM", "JOIN", "UPDATE", "INTO", "STRAIGHT_JOIN"]);
const RELATION_MODIFIERS = new Set(["LATERAL", "ONLY"]);
const EXPRESSION_CLAUSES = new Set(["SELECT", "WHERE", "ON", "BY", "HAVING", "SET", "RETURNING", "USING"]);
/** Clause keywords that end a FROM list; ON and USING belong to a join inside it. */
const FROM_LIST_ENDS = new Set([
  "SELECT",
  "WHERE",
  "GROUP",
  "ORDER",
  "HAVING",
  "LIMIT",
  "OFFSET",
  "SET",
  "VALUES",
  "UNION",
  "INTERSECT",
  "EXCEPT",
  "RETURNING",
  "WINDOW",
  "FETCH",
  "FOR",
]);
const SELECT_LIST_ENDS = new Set([...FROM_LIST_ENDS, "FROM", "INTO"]);
const CLAUSE_WORDS = new Set([...FROM_LIST_ENDS, ...RELATION_INTRODUCERS, ...EXPRESSION_CLAUSES, "DELETE", "INSERT"]);
/** Words that end a table reference instead of naming or aliasing it. */
const NOT_A_NAME = new Set([
  ...CLAUSE_WORDS,
  "AS",
  "INNER",
  "LEFT",
  "RIGHT",
  "FULL",
  "OUTER",
  "CROSS",
  "NATURAL",
  "LATERAL",
  "USE",
  "FORCE",
  "IGNORE",
  "WITH",
  "DEFAULT",
  "TABLESAMPLE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
  "AND",
  "OR",
  "NOT",
  "DISTINCT",
  "ALL",
  "CASE",
  "NULL",
]);
const AS = "AS";
const WITH = "WITH";
const RECURSIVE = "RECURSIVE";
const CTE_MODIFIERS = new Set(["NOT", "MATERIALIZED"]);
const SELECT_MODIFIERS = new Set(["DISTINCT", "ALL"]);
const STAR = "*";
const DIGIT = /^[0-9]/;
const BLOCK_COMMENT_END = "*/";
const LINE_COMMENT_STARTS = ["--", "#"];

export function unquote(raw: string): string {
  const quote = raw.charAt(0);
  const inner = raw.length >= 2 && raw.endsWith(quote) ? raw.slice(1, -1) : raw.slice(1);
  return inner.replaceAll(quote + quote, quote);
}

/** Whether the caret at `offset` sits inside a string or comment token. */
function insideLiteral(text: string, token: Token, offset: number): boolean {
  if (token.kind !== "string" && token.kind !== "comment") return false;
  if (offset <= token.from || offset > token.to) return false;
  if (offset < token.to) return true;
  const raw = text.slice(token.from, token.to);
  if (token.kind === "comment")
    return LINE_COMMENT_STARTS.some((start) => raw.startsWith(start)) || !raw.endsWith(BLOCK_COMMENT_END);
  const quote = raw.charAt(0);
  return raw.length < 2 || !raw.endsWith(quote);
}

/** The tokens of one statement, its parentheses matched, read for the queries in it. */
class Statement {
  readonly #text: string;
  readonly tokens: readonly Token[];
  /** For each `(`, the index of its `)`, or the token count when it is never closed. */
  readonly #close = new Map<number, number>();
  /** For each `(`, the `(` it sits in, or `NO_GROUP`. */
  readonly #parent = new Map<number, number>();
  readonly #queries = new Map<number, Query>();

  constructor(text: string, tokens: readonly Token[]) {
    this.#text = text;
    this.tokens = tokens;
    const open: number[] = [];
    for (let index = 0; index < tokens.length; index += 1) {
      const symbol = this.#symbol(index);
      if (symbol === OPEN) {
        this.#parent.set(index, open.at(-1) ?? NO_GROUP);
        open.push(index);
      } else if (symbol === CLOSE) {
        const opened = open.pop();
        if (opened !== undefined) this.#close.set(opened, index);
      }
    }
    for (const opened of open) this.#close.set(opened, tokens.length);
  }

  #symbol(index: number | undefined): string | null {
    const token = index === undefined ? undefined : this.tokens[index];
    return token?.kind === "symbol" ? this.#text.charAt(token.from) : null;
  }

  word(index: number | undefined): string | null {
    const token = index === undefined ? undefined : this.tokens[index];
    return token?.kind === "word" ? this.#text.slice(token.from, token.to).toUpperCase() : null;
  }

  isSymbol(index: number | undefined, symbol: string): boolean {
    return this.#symbol(index) === symbol;
  }

  /** A name, quoted or not, that no keyword claims. */
  identifier(index: number | undefined): Identifier | null {
    const token = index === undefined ? undefined : this.tokens[index];
    if (token === undefined) return null;
    const raw = this.#text.slice(token.from, token.to);
    if (token.kind === "quoted") return { name: unquote(raw), quoted: true, from: token.from, to: token.to };
    if (token.kind !== "word" || DIGIT.test(raw) || NOT_A_NAME.has(raw.toUpperCase())) return null;
    return { name: raw, quoted: false, from: token.from, to: token.to };
  }

  closeOf(open: number): number {
    return open === NO_GROUP ? this.tokens.length : (this.#close.get(open) ?? this.tokens.length);
  }

  /** The token indices directly inside `open`, a nested group standing as its `(`. */
  level(open: number): number[] {
    const indices: number[] = [];
    const end = this.closeOf(open);
    for (let index = open + 1; index < end; index += 1) {
      indices.push(index);
      if (this.isSymbol(index, OPEN)) index = this.closeOf(index);
    }
    return indices;
  }

  isQuery(open: number): boolean {
    if (open === NO_GROUP) return true;
    const first = this.word(open + 1);
    return first !== null && QUERY_STARTS.has(first) && open + 1 < this.closeOf(open);
  }

  /** The innermost group holding `offset`, by text position. */
  groupAt(offset: number): number {
    let found = NO_GROUP;
    for (const [open, close] of this.#close) {
      const opened = this.tokens[open];
      const closed = this.tokens[close];
      if (opened === undefined || opened.to > offset) continue;
      if (closed !== undefined && closed.from < offset) continue;
      if (found === NO_GROUP || open > found) found = open;
    }
    return found;
  }

  enclosingQuery(open: number): number {
    let group = open;
    while (!this.isQuery(group)) group = this.#parent.get(group) ?? NO_GROUP;
    return group;
  }

  /** Memoised before it is read, so a subquery naming its parent and the parent reading the subquery meet. */
  query(open: number): Query {
    const known = this.#queries.get(open);
    if (known !== undefined) return known;
    const query: MutableQuery = { ctes: [], sources: [], select: [], insert: null, parent: null };
    this.#queries.set(open, query);
    query.parent = open === NO_GROUP ? null : this.query(this.enclosingQuery(this.#parent.get(open) ?? NO_GROUP));
    new QueryReader(this, open, query).read();
    return query;
  }
}

/** Reads one level's CTEs, sources and select list; anything it does not recognise it skips. */
class QueryReader {
  readonly #statement: Statement;
  readonly #query: MutableQuery;
  readonly #indices: number[];
  #at = 0;

  constructor(statement: Statement, open: number, query: MutableQuery) {
    this.#statement = statement;
    this.#query = query;
    this.#indices = statement.level(open);
  }

  #index(offset = 0): number | undefined {
    return this.#indices[this.#at + offset];
  }

  read(): void {
    const statement = this.#statement;
    if (statement.word(this.#index()) === WITH) this.#readCtes();
    let expectRelation = false;
    let fromList = false;
    let into = false;
    let selecting = false;
    let selected = false;
    let item: number[] = [];
    const flush = (): void => {
      if (!selected) this.#selectItem(item);
      item = [];
    };
    for (; this.#at < this.#indices.length; this.#at += 1) {
      const index = this.#index();
      const word = statement.word(index);
      if (selecting) {
        if (word !== null && SELECT_LIST_ENDS.has(word)) {
          flush();
          selecting = false;
          selected = true;
        } else if (statement.isSymbol(index, COMMA)) {
          flush();
          continue;
        } else {
          if (!(item.length === 0 && word !== null && SELECT_MODIFIERS.has(word)) && index !== undefined)
            item.push(index);
          continue;
        }
      }
      if (word === "SELECT") {
        selecting = !selected;
        expectRelation = false;
        fromList = false;
        continue;
      }
      if (word !== null && RELATION_INTRODUCERS.has(word)) {
        expectRelation = true;
        into = word === "INTO";
        fromList = word !== "INTO";
        continue;
      }
      if (word !== null && CLAUSE_WORDS.has(word)) {
        expectRelation = false;
        if (FROM_LIST_ENDS.has(word)) fromList = false;
        continue;
      }
      if (expectRelation) {
        if (word !== null && RELATION_MODIFIERS.has(word)) continue;
        this.#readSource(into);
        expectRelation = false;
        into = false;
        continue;
      }
      if (fromList && statement.isSymbol(index, COMMA)) expectRelation = true;
    }
    if (selecting) flush();
  }

  #readCtes(): void {
    const statement = this.#statement;
    this.#at += 1;
    if (statement.word(this.#index()) === RECURSIVE) this.#at += 1;
    for (;;) {
      const name = statement.identifier(this.#index());
      if (name === null) return;
      this.#at += 1;
      let columns: Identifier[] | null = null;
      const listOpen = this.#index();
      if (listOpen !== undefined && statement.isSymbol(listOpen, OPEN)) {
        columns = statement
          .level(listOpen)
          .map((index) => statement.identifier(index))
          .filter((identifier) => identifier !== null);
        this.#at += 1;
      }
      if (statement.word(this.#index()) === AS) this.#at += 1;
      while (CTE_MODIFIERS.has(statement.word(this.#index()) ?? "")) this.#at += 1;
      const body = this.#index();
      if (body === undefined || !statement.isSymbol(body, OPEN)) return;
      this.#query.ctes.push({ name, columns, query: statement.query(body) });
      this.#at += 1;
      if (!statement.isSymbol(this.#index(), COMMA)) return;
      this.#at += 1;
    }
  }

  /** Reads one table reference at the cursor and leaves the cursor on its last token. */
  #readSource(into: boolean): void {
    const statement = this.#statement;
    const start = this.#index();
    if (start === undefined) return;
    const startToken = statement.tokens[start];
    if (startToken === undefined) return;
    if (statement.isSymbol(start, OPEN)) {
      const closeToken = statement.tokens[statement.closeOf(start)];
      const alias = this.#alias();
      this.#query.sources.push({
        kind: "derived",
        alias,
        query: statement.query(start),
        from: startToken.from,
        to: alias?.to ?? closeToken?.to ?? startToken.to,
      });
      return;
    }
    const first = statement.identifier(start);
    if (first === null) {
      this.#at -= 1;
      return;
    }
    const parts = [first];
    while (statement.isSymbol(this.#index(1), DOT)) {
      const next = statement.identifier(this.#index(2));
      if (next === null) break;
      parts.push(next);
      this.#at += 2;
    }
    const name = parts.pop() ?? first;
    const following = this.#index(1);
    if (following !== undefined && statement.isSymbol(following, OPEN)) {
      const source: RelationSource = {
        kind: "relation",
        qualifier: parts,
        name,
        alias: null,
        from: first.from,
        to: name.to,
      };
      if (into) {
        const closeToken = statement.tokens[statement.closeOf(following)];
        const openToken = statement.tokens[following];
        this.#query.sources.push(source);
        this.#query.insert = {
          source,
          from: openToken?.to ?? name.to,
          to: closeToken?.from ?? Number.MAX_SAFE_INTEGER,
        };
        this.#at += 1;
        return;
      }
      // A table function such as `generate_series(…)`: its columns are unknown, but its alias still scopes.
      this.#at += 1;
    }
    const alias = this.#alias();
    this.#query.sources.push({
      kind: "relation",
      qualifier: parts,
      name,
      alias,
      from: first.from,
      to: alias?.to ?? name.to,
    });
  }

  /** `[AS] alias` after the cursor; advances past it when present. */
  #alias(): Identifier | null {
    const statement = this.#statement;
    const hasAs = statement.word(this.#index(1)) === AS;
    const alias = statement.identifier(this.#index(hasAs ? 2 : 1));
    if (alias !== null) this.#at += hasAs ? 2 : 1;
    else if (hasAs) this.#at += 1;
    return alias;
  }

  #selectItem(item: readonly number[]): void {
    const statement = this.#statement;
    const last = item.at(-1);
    if (last === undefined) return;
    if (statement.isSymbol(last, STAR)) {
      const qualified = item.length >= 3 && statement.isSymbol(item.at(-2), DOT);
      this.#query.select.push({ kind: "star", qualifier: qualified ? statement.identifier(item.at(-3)) : null });
      return;
    }
    const name = statement.identifier(last);
    if (name !== null) this.#query.select.push({ kind: "named", name });
  }
}

/** The statement around `offset` without its comments, and whether the caret sits in a string or comment. */
export function statementTokens(
  text: string,
  offset: number,
  dialect: SqlDialectOptions,
): { tokens: Token[]; literal: boolean } {
  const lexer = new Lexer(text, dialect);
  let tokens: Token[] = [];
  let literal = false;
  for (let token = lexer.next(); token !== null; token = lexer.next()) {
    if (insideLiteral(text, token, offset)) literal = true;
    if (token.kind === "comment") continue;
    if (token.kind === "delimiter") {
      if (token.to <= offset) tokens = [];
      else if (token.from >= offset) break;
      continue;
    }
    tokens.push(token);
  }
  return { tokens, literal };
}

type WordMode = "complete" | "resolve";

/** The name token the caret is in; completing needs a character before the caret, resolving does not. */
function wordIndexAt(tokens: readonly Token[], offset: number, mode: WordMode): number | null {
  const index = tokens.findIndex(
    (token) =>
      (token.kind === "word" || token.kind === "quoted") &&
      (mode === "complete" ? token.from < offset : token.from <= offset) &&
      offset <= token.to,
  );
  return index < 0 ? null : index;
}

/** `a.b.` written without spaces before the token at `index`, which starts at `end`. */
function qualifierBefore(statement: Statement, index: number, end: number): Identifier[] {
  const names: Identifier[] = [];
  let at = index;
  let reach = end;
  for (;;) {
    const dot = statement.tokens[at - 1];
    const before = statement.identifier(at - 2);
    if (dot === undefined || before === null || !statement.isSymbol(at - 1, DOT)) break;
    if (dot.to !== reach || before.to !== dot.from) break;
    names.unshift(before);
    reach = before.from;
    at -= 2;
  }
  return names;
}

function clauseOf(statement: Statement, queryOpen: number, group: number, anchor: number, query: Query): Clause {
  let clause: string | null = null;
  let fromList = false;
  let last: number | null = null;
  for (const index of statement.level(queryOpen)) {
    const token = statement.tokens[index];
    if (token === undefined || token.from >= anchor) break;
    const word = statement.word(index);
    if (word !== null && CLAUSE_WORDS.has(word)) {
      clause = word;
      if (RELATION_INTRODUCERS.has(word) && word !== "INTO") fromList = true;
      else if (FROM_LIST_ENDS.has(word)) fromList = false;
    }
    last = index;
  }
  if (group !== queryOpen) {
    const insert = query.insert;
    if (insert !== null && insert.from <= anchor && anchor <= insert.to) return "insertColumns";
    return clause !== null && EXPRESSION_CLAUSES.has(clause) ? "columns" : "keywords";
  }
  const lastWord = statement.word(last ?? undefined);
  if (lastWord !== null && (RELATION_INTRODUCERS.has(lastWord) || RELATION_MODIFIERS.has(lastWord))) {
    return lastWord === "JOIN" || lastWord === "STRAIGHT_JOIN" ? "join" : "relation";
  }
  if (fromList && last !== null && statement.isSymbol(last, COMMA)) return "relation";
  if (clause !== null && EXPRESSION_CLAUSES.has(clause)) return "columns";
  return "keywords";
}

/**
 * The statement around `offset` read as far as completion and navigation need (decision 028): the
 * clause the caret is in, the qualifier before it, and the query level whose sources are in scope.
 * It reads tokens, never a grammar, so it answers for half-typed SQL.
 */
export function scopeAt(
  text: string,
  offset: number,
  dialect: SqlDialectOptions,
  mode: WordMode = "complete",
): ScopeAt {
  const { tokens, literal } = statementTokens(text, offset, dialect);
  const statement = new Statement(text, tokens);
  const wordIndex = wordIndexAt(tokens, offset, mode);
  const wordToken = wordIndex === null ? undefined : tokens[wordIndex];
  let word: Identifier | null = null;
  if (wordToken !== undefined) {
    const raw = text.slice(wordToken.from, wordToken.to);
    word =
      wordToken.kind === "quoted"
        ? { name: unquote(raw), quoted: true, from: wordToken.from, to: wordToken.to }
        : { name: raw, quoted: false, from: wordToken.from, to: wordToken.to };
  }
  const prefixFrom = word?.from ?? offset;
  const following = tokens.findIndex((token) => token.from >= offset);
  const caretIndex = wordIndex ?? (following < 0 ? tokens.length : following);
  const qualifier = qualifierBefore(statement, caretIndex, prefixFrom);
  const anchor = qualifier[0]?.from ?? prefixFrom;
  const dotAfter =
    wordIndex !== null && statement.isSymbol(wordIndex + 1, DOT) && tokens[wordIndex + 1]?.from === word?.to;
  const group = statement.groupAt(anchor);
  const queryOpen = statement.enclosingQuery(group);
  const query = statement.query(queryOpen);
  const clause = literal ? "none" : clauseOf(statement, queryOpen, group, anchor, query);
  return { clause, qualifier, prefixFrom, word, dotAfter, query };
}
