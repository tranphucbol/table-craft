import type { InspectionId, Problem, ProblemSeverity, QuickFix } from "@table-craft/plugin-api";
import type { CompleterOptions } from "./complete.js";
import { functionName } from "./functions.js";
import type { Lookup, NameRules } from "./resolution.js";
import {
  CLAUSE_WORDS,
  NO_GROUP,
  Statement,
  unquote,
  type Identifier,
  type Query,
  type RelationSource,
} from "./scope.js";
import type { Token } from "./tokens.js";
import { explainPrefix, mainVerb, words } from "./words.js";

/** What `sqlInspector` needs: the completer's dialect knowledge and the words a name must be quoted to spell. */
export interface InspectorOptions extends CompleterOptions {
  /** Upper case. A name spelling one of these is an error unless quoted. */
  readonly reservedWords: ReadonlySet<string>;
}

/**
 * What a relation source really is: a table read by the query, the target of an `INTO`, a table
 * function, or no relation at all (`FOR UPDATE NOWAIT` and `ON DUPLICATE KEY UPDATE col`, which the
 * scope reader takes for one).
 */
export type SourceRole = "relation" | "target" | "function" | "notRelation";

/** Where a token stands: its innermost parentheses, the query level that owns it, and the clause it is in. */
export interface Place {
  readonly group: number;
  readonly queryOpen: number;
  readonly query: Query;
  /** The clause keyword before it at its own level, `ORDER BY` for a `BY`; null before any. */
  readonly clause: string | null;
}

const OPEN = "(";
const CLOSE = ")";
const BY = "BY";
const BY_OWNERS = new Set(["ORDER", "GROUP", "PARTITION"]);
const ON = "ON";
/** `ON DUPLICATE KEY UPDATE` and `ON CONFLICT`: an `ON` that starts an action, not a join condition. */
const ON_ACTIONS = new Set(["DUPLICATE", "CONFLICT"]);
const WITH = "WITH";
const CREATE = "CREATE";
const AS = "AS";
/** Statements whose clauses the inspections understand; anything else gets only the lexical checks. */
const INSPECTED_VERBS = new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "REPLACE"]);
const CREATED_FROM_QUERY = new Set(["TABLE", "VIEW"]);
const QUERY_STARTS = new Set(["SELECT", WITH]);
/** Words an expression may hold that no built-in keyword list names, so they are never taken for columns. */
const EXPRESSION_WORDS = [
  "INTERVAL",
  "CURRENT_DATE",
  "CURRENT_TIME",
  "CURRENT_TIMESTAMP",
  "CURRENT_USER",
  "CURRENT_SCHEMA",
  "CURRENT_CATALOG",
  "CURRENT_ROLE",
  "SESSION_USER",
  "SYSTEM_USER",
  "USER",
  "LOCALTIME",
  "LOCALTIMESTAMP",
  "UNKNOWN",
  "ANY",
  "SOME",
  "ARRAY",
  "ROW",
  "DATE",
  "TIME",
  "TIMESTAMP",
  "BINARY",
  "COLLATE",
  "ESCAPE",
  "SIMILAR",
  "OVERLAPS",
  "ISNULL",
  "NOTNULL",
  "DIV",
  "MOD",
  "XOR",
  "REGEXP",
  "RLIKE",
  "GLOB",
  "MATCH",
  "AGAINST",
  "NULLS",
  "FIRST",
  "LAST",
  "ROWS",
  "RANGE",
  "GROUPS",
  "PRECEDING",
  "FOLLOWING",
  "UNBOUNDED",
  "CURRENT",
  "WITHIN",
  "FILTER",
  "OVER",
  "PARTITION",
  "SEPARATOR",
  "DEFAULT",
  "UNSIGNED",
  "SIGNED",
];
const INTO = "INTO";
const UPDATE = "UPDATE";
/** `ON DUPLICATE KEY UPDATE` and `FOR UPDATE`: an `UPDATE` after these introduces no table. */
const NOT_TABLE_UPDATES = new Set(["KEY", "FOR"]);

/** One statement's tokens read once, shared by every inspection that runs on it. */
export class StatementView {
  readonly statement: Statement;
  readonly places: Place[] = [];
  /** The `(` of each query level, `NO_GROUP` for the statement's own. */
  readonly queries = new Map<Query, number>();
  /** The statement's main verb, upper case, after any `WITH` or `EXPLAIN`. */
  readonly verb: string | null;
  /** Whether the statement is a query or DML the clause inspections understand. */
  readonly inspected: boolean;
  readonly #keywords: ReadonlySet<string>;
  readonly #quoteWorthy: ReadonlySet<string>;

  constructor(
    readonly text: string,
    readonly tokens: readonly Token[],
    readonly options: InspectorOptions,
    readonly rules: NameRules,
    readonly lookup: Lookup,
  ) {
    this.statement = new Statement(text, tokens);
    this.#quoteWorthy = new Set([
      ...options.keywords.map((keyword) => keyword.toUpperCase()),
      ...options.reservedWords,
    ]);
    this.#keywords = new Set([
      ...this.#quoteWorthy,
      ...EXPRESSION_WORDS,
      ...options.functions.map((spec) => functionName(spec).toUpperCase()),
    ]);
    this.#readPlaces();
    const list = words(text, tokens);
    const explained = explainPrefix(list);
    const rest = explained === null ? list : list.slice(explained.statementAt);
    const verb = rest[mainVerb(rest)]?.word ?? null;
    this.verb = verb;
    const startsWithQuery = this.isSymbol(0, OPEN) && QUERY_STARTS.has(this.word(1) ?? "");
    this.inspected =
      (verb !== null && INSPECTED_VERBS.has(verb)) ||
      startsWithQuery ||
      (verb === CREATE &&
        rest.some((entry) => CREATED_FROM_QUERY.has(entry.word)) &&
        rest.some((entry, at) => entry.depth === 0 && entry.word === AS && QUERY_STARTS.has(rest[at + 1]?.word ?? "")));
  }

  #readPlaces(): void {
    const statement = this.statement;
    const stack: number[] = [];
    const clauses = new Map<number, string | null>([[NO_GROUP, null]]);
    for (let index = 0; index < this.tokens.length; index += 1) {
      const group = stack.at(-1) ?? NO_GROUP;
      const word = this.word(index);
      if (word !== null && CLAUSE_WORDS.has(word)) {
        const owner = this.word(index - 1);
        const following = this.word(index + 1);
        const key =
          word === BY && owner !== null && BY_OWNERS.has(owner)
            ? `${owner} ${BY}`
            : word === ON && following !== null && ON_ACTIONS.has(following)
              ? `${ON} ${following}`
              : word;
        clauses.set(group, key);
      }
      const queryOpen = statement.enclosingQuery(group);
      const query = statement.query(queryOpen);
      this.queries.set(query, queryOpen);
      this.places.push({ group, queryOpen, query, clause: clauses.get(group) ?? null });
      if (this.isSymbol(index, OPEN)) {
        clauses.set(index, statement.isQuery(index) ? null : (clauses.get(group) ?? null));
        stack.push(index);
      } else if (this.isSymbol(index, CLOSE)) {
        stack.pop();
      }
    }
    for (const query of [...this.queries.keys()]) this.#collect(query);
  }

  /** CTEs and derived tables that hold no token of their own still need a level. */
  #collect(query: Query): void {
    for (const nested of [...query.ctes.map((cte) => cte.query), ...query.sources.flatMap(derivedQuery)]) {
      if (this.queries.has(nested)) continue;
      this.queries.set(nested, NO_GROUP);
      this.#collect(nested);
    }
  }

  token(index: number): Token | undefined {
    return this.tokens[index];
  }

  word(index: number): string | null {
    return this.statement.word(index);
  }

  isSymbol(index: number, symbol: string): boolean {
    return this.statement.isSymbol(index, symbol);
  }

  raw(index: number): string {
    const token = this.tokens[index];
    return token === undefined ? "" : this.text.slice(token.from, token.to);
  }

  /** The first token starting at or after `offset`; the token count when none does. */
  nextIndex(offset: number): number {
    let low = 0;
    let high = this.tokens.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((this.tokens[middle]?.from ?? 0) < offset) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  /** The token starting at `offset`, or -1. */
  indexAt(offset: number): number {
    const index = this.nextIndex(offset);
    return this.tokens[index]?.from === offset ? index : -1;
  }

  /** A name token: quoted, or an unquoted word that is no keyword, reserved word or function of the dialect. */
  name(index: number): Identifier | null {
    const token = this.tokens[index];
    if (token === undefined) return null;
    if (token.kind === "quoted")
      return { name: unquote(this.raw(index)), quoted: true, from: token.from, to: token.to };
    const identifier = this.statement.identifier(index);
    if (identifier === null || this.#keywords.has(identifier.name.toUpperCase())) return null;
    return identifier;
  }

  roleOf(source: RelationSource): SourceRole {
    const first = this.indexAt(source.from);
    const before = this.word(first - 1);
    if (before === INTO) return "target";
    if (before === UPDATE && NOT_TABLE_UPDATES.has(this.word(first - 2) ?? "")) return "notRelation";
    return this.isSymbol(this.indexAt(source.name.from) + 1, OPEN) ? "function" : "relation";
  }

  /** `name` as the dialect reads it back: bare when it can be, quoted otherwise. */
  quoted(name: string): string {
    return this.options.plainIdentifier.test(name) && !this.#quoteWorthy.has(name.toUpperCase())
      ? name
      : this.options.quoteIdentifier(name);
  }

  isKeyword(word: string): boolean {
    return this.#keywords.has(word.toUpperCase());
  }

  /** Where the statement's last token ends, so an insertion lands before its delimiter. */
  get end(): number {
    return this.tokens.at(-1)?.to ?? 0;
  }

  /** The text from the end of the token before `index` to the end of `last`: a span removed with its leading space. */
  withLeadingSpace(index: number, last = index): { from: number; to: number } {
    const before = this.tokens[index - 1];
    const own = this.tokens[index];
    return { from: before?.to ?? own?.from ?? 0, to: this.tokens[last]?.to ?? own?.to ?? 0 };
  }
}

function derivedQuery(source: Query["sources"][number]): Query[] {
  return source.kind === "derived" ? [source.query] : [];
}

export function problem(
  inspection: InspectionId,
  severity: ProblemSeverity,
  span: { readonly from: number; readonly to: number },
  message: string,
  fixes: readonly QuickFix[] = [],
): Problem {
  return { from: span.from, to: span.to, severity, inspection, message, fixes };
}

/** A fix that removes `span`. */
export function removal(title: string, span: { readonly from: number; readonly to: number }): QuickFix {
  return { title, edits: [{ from: span.from, to: span.to, insert: "" }] };
}

export function replacement(
  title: string,
  span: { readonly from: number; readonly to: number },
  insert: string,
): QuickFix {
  return { title, edits: [{ from: span.from, to: span.to, insert }] };
}

/** An inspection over one statement; it may read the catalog through the view's lookup. */
export type StatementInspection = (view: StatementView) => Problem[] | Promise<Problem[]>;
