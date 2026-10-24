import {
  switchableTo,
  type CompletionCatalog,
  type CompletionItem,
  type CompletionKind,
  type CompletionRequest,
  type CompletionResult,
  type Declaration,
  type Namespace,
  type Relation,
  type ResolveRequest,
  type SelectSource,
  type SignatureHelp,
  type SqlLanguage,
} from "@table-craft/plugin-api";
import { functionItem, functionName, isAvailable, type FunctionSpec, type ServerIdentity } from "./functions.js";
import { callAt } from "./signature.js";
import { parseSimpleSelect, SELECT_READ_ONLY_REASONS, type SimpleSelect } from "./select.js";
import {
  scopeAt,
  type Cte,
  type Identifier,
  type Query,
  type RelationSource,
  type ScopeAt,
  type Source,
} from "./scope.js";
import { namespaceSlotAt, namespaceTarget, type NamespaceSlot, type NamespaceTarget } from "./namespace.js";
import { sqlSplitter } from "./splitter.js";
import type { SqlDialectOptions } from "./tokens.js";

/** How a dialect reads unquoted names: PostgreSQL folds them to lower case, MySQL and SQLite compare them as written. */
export type IdentifierFolding = "lower" | "upper" | "none";

/** What the shared completer needs to know about a dialect (decision 028). */
export interface CompleterOptions {
  readonly dialect: SqlDialectOptions;
  readonly identifierFolding: IdentifierFolding;
  /** A name the dialect reads back unchanged without quotes; any other is quoted when inserted. */
  readonly plainIdentifier: RegExp;
  readonly quoteIdentifier: (name: string) => string;
  /** Offered where a keyword fits; a name that spells one is quoted. Upper case. */
  readonly keywords: readonly string[];
  /** Built-in functions; a spec brings its signatures, summary and server range (decision 097). */
  readonly functions: readonly (string | FunctionSpec)[];
  /** Reads the catalog's server version into the flavour and version the specs' ranges name; null when it cannot. */
  readonly server?: (version: string) => ServerIdentity | null;
}

/** Reserved words every built-in dialect shares; a plugin adds its own. */
export const SQL_KEYWORDS: readonly string[] = [
  "ALL",
  "AND",
  "AS",
  "ASC",
  "BETWEEN",
  "BY",
  "CASE",
  "CREATE",
  "CROSS",
  "DELETE",
  "DESC",
  "DISTINCT",
  "DROP",
  "ELSE",
  "END",
  "EXISTS",
  "FALSE",
  "FROM",
  "FULL",
  "GROUP",
  "HAVING",
  "IN",
  "INNER",
  "INSERT",
  "INTO",
  "IS",
  "JOIN",
  "LEFT",
  "LIKE",
  "LIMIT",
  "NOT",
  "NULL",
  "OFFSET",
  "ON",
  "OR",
  "ORDER",
  "OUTER",
  "RIGHT",
  "SELECT",
  "SET",
  "TABLE",
  "THEN",
  "TRUE",
  "UNION",
  "UPDATE",
  "USING",
  "VALUES",
  "WHEN",
  "WHERE",
  "WITH",
];

/** Ranks items the typed prefix matches equally well (plan 009 decision 12). */
const BOOST: Readonly<Record<CompletionKind, number>> = {
  join: 50,
  column: 40,
  cte: 35,
  table: 30,
  view: 30,
  alias: 20,
  namespace: 10,
  function: 0,
  keyword: -10,
};
/** CTEs that read each other stop expanding here, so a recursive one cannot loop. */
const MAX_EXPANSION_DEPTH = 4;
const UNQUOTED_WORD = "^[A-Za-z0-9_$]*$";
const ALIAS_WORD_BREAK = /[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/;
const FALLBACK_ALIAS = "t";
const QUOTES = new Set(['"', "`"]);
/** Below every other namespace: `USE mysql` is legitimate but rarely meant. */
const SYSTEM_NAMESPACE_BOOST = -20;
const CURRENT_DETAIL = "current";

interface ColumnInfo {
  readonly name: string;
  readonly type: string | null;
}

interface FoundRelation {
  readonly path: readonly string[];
  readonly relation: Relation;
}

function samePath(left: readonly string[] | null, right: readonly string[] | null): boolean {
  return (
    left !== null && right !== null && left.length === right.length && left.every((part, at) => part === right[at])
  );
}

/** Whether `namespace` is one `target` can switch to (found live, plan 022). */
function targetable(target: NamespaceTarget, namespace: Namespace): boolean {
  return switchableTo(target.kind === "database" ? "topLevel" : "schema", namespace);
}

function relationKind(relation: Relation): CompletionKind {
  return relation.kind === "table" ? "table" : "view";
}

/** The shared completion and navigation every built-in plugin spreads into its `SqlLanguage` (decision 028). */
export function sqlCompleter(
  options: CompleterOptions,
): Pick<SqlLanguage, "complete" | "resolve"> & Required<Pick<SqlLanguage, "selectSource" | "signatureAt">> {
  const reserved = new Set(options.keywords.map((keyword) => keyword.toUpperCase()));
  const split = sqlSplitter(options.dialect);
  const specs = new Map<string, FunctionSpec[]>();
  for (const spec of options.functions) {
    if (typeof spec === "string") continue;
    const key = spec.name.toUpperCase();
    specs.set(key, [...(specs.get(key) ?? []), spec]);
  }

  function serverOf(catalog: CompletionCatalog): ServerIdentity | null {
    const version = catalog.server.version;
    return version === null || options.server === undefined ? null : options.server(version);
  }

  function specNamed(name: string, server: ServerIdentity | null): FunctionSpec | undefined {
    return specs.get(name.toUpperCase())?.find((spec) => isAvailable(spec, server));
  }

  function fold(name: string): string {
    switch (options.identifierFolding) {
      case "lower":
        return name.toLowerCase();
      case "upper":
        return name.toUpperCase();
      case "none":
        return name;
    }
  }

  /** Whether a name as written denotes `catalogName`: quoted exactly, unquoted folded, or case-blind where nothing folds. */
  function denotes(identifier: Identifier, catalogName: string): boolean {
    if (options.identifierFolding === "none") return identifier.name.toLowerCase() === catalogName.toLowerCase();
    return (identifier.quoted ? identifier.name : fold(identifier.name)) === catalogName;
  }

  function sameIdentifier(left: Identifier, right: Identifier): boolean {
    const key = (identifier: Identifier): string =>
      options.identifierFolding === "none"
        ? identifier.name.toLowerCase()
        : identifier.quoted
          ? identifier.name
          : fold(identifier.name);
    return key(left) === key(right);
  }

  function quoted(name: string): string {
    return options.plainIdentifier.test(name) && !reserved.has(name.toUpperCase())
      ? name
      : options.quoteIdentifier(name);
  }

  /** Every query level from the caret's outwards. */
  function levels(query: Query): Query[] {
    const found: Query[] = [];
    for (let level: Query | null = query; level !== null; level = level.parent) found.push(level);
    return found;
  }

  function visibleCtes(query: Query): Cte[] {
    return levels(query).flatMap((level) => level.ctes);
  }

  function cteNamed(query: Query, name: Identifier): Cte | undefined {
    return visibleCtes(query).find((cte) => sameIdentifier(cte.name, name));
  }

  /** The name a source is referred to by: its alias, else its relation's name. */
  function referenceName(source: Source): Identifier | null {
    return source.alias ?? (source.kind === "relation" ? source.name : null);
  }

  function sourceNamed(query: Query, name: Identifier): Source | undefined {
    for (const level of levels(query)) {
      const source = level.sources.find((candidate) => {
        const reference = referenceName(candidate);
        return reference !== null && sameIdentifier(reference, name);
      });
      if (source !== undefined) return source;
    }
    return undefined;
  }

  class Lookup {
    readonly #catalog: CompletionCatalog;
    #namespaces: Promise<readonly Namespace[]> | null = null;
    #current: readonly string[] | null;

    constructor(catalog: CompletionCatalog) {
      this.#catalog = catalog;
      this.#current = catalog.current;
    }

    get server(): ServerIdentity | null {
      return serverOf(this.#catalog);
    }

    get current(): readonly string[] | null {
      return this.#current;
    }

    /**
     * Makes the script's own namespace current: the nearest statement before `offset` that moves
     * the session's namespace, when one of its targets exists (plan 022 decision 7).
     */
    async follow(text: string, offset: number): Promise<void> {
      const preceding = split(text).filter((span) => span.to < offset);
      for (let at = preceding.length - 1; at >= 0; at -= 1) {
        const span = preceding[at];
        const target = span === undefined ? null : namespaceTarget(span.sql, options.dialect);
        if (target === null) continue;
        const namespaces = (await this.namespaces()).filter((namespace) => targetable(target, namespace));
        for (const candidate of target.candidates) {
          const found = namespaces.find((namespace) => denotes(candidate, namespace.path.at(-1) ?? ""));
          if (found !== undefined) {
            this.#current = found.path;
            return;
          }
        }
        return;
      }
    }

    namespaces(): Promise<readonly Namespace[]> {
      this.#namespaces ??= this.#catalog.namespaces().catch(() => []);
      return this.#namespaces;
    }

    relations(path: readonly string[]): Promise<readonly Relation[]> {
      return this.#catalog.relations(path).catch(() => []);
    }

    referencing(path: readonly string[], relation: string) {
      return this.#catalog.referencing(path, relation).catch(() => []);
    }

    /** The namespace a qualifier names: its trailing path parts, as written. */
    async namespace(qualifier: readonly Identifier[]): Promise<Namespace | undefined> {
      if (qualifier.length === 0) return undefined;
      const namespaces = await this.namespaces();
      const matches = (namespace: Namespace): boolean => {
        const tail = namespace.path.slice(-qualifier.length);
        return tail.length === qualifier.length && qualifier.every((part, at) => denotes(part, tail[at] ?? ""));
      };
      return namespaces.find((namespace) => matches(namespace) && !namespace.system) ?? namespaces.find(matches);
    }

    async relation(qualifier: readonly Identifier[], name: Identifier): Promise<FoundRelation | null> {
      const path = qualifier.length === 0 ? this.current : ((await this.namespace(qualifier))?.path ?? null);
      if (path === null) return null;
      const relations = await this.relations(path);
      const relation =
        relations.find((candidate) => candidate.name === name.name) ??
        relations.find((candidate) => denotes(name, candidate.name));
      return relation === undefined ? null : { path, relation };
    }

    async columnsOf(source: Source, query: Query, depth = 0): Promise<ColumnInfo[]> {
      if (source.kind === "derived") return this.selectColumns(source.query, depth + 1);
      if (source.qualifier.length === 0) {
        const cte = cteNamed(query, source.name);
        if (cte !== undefined) return this.cteColumns(cte, depth + 1);
      }
      const found = await this.relation(source.qualifier, source.name);
      return found?.relation.columns.map((column) => ({ name: column.name, type: column.type })) ?? [];
    }

    cteColumns(cte: Cte, depth: number): Promise<ColumnInfo[]> {
      if (cte.columns !== null)
        return Promise.resolve(cte.columns.map((column) => ({ name: column.name, type: null })));
      return this.selectColumns(cte.query, depth);
    }

    /** A subquery's select list, `*` expanded through its own sources. */
    async selectColumns(query: Query, depth: number): Promise<ColumnInfo[]> {
      if (depth > MAX_EXPANSION_DEPTH) return [];
      const columns: ColumnInfo[] = [];
      for (const item of query.select) {
        if (item.kind === "named") {
          columns.push({ name: item.name.name, type: null });
          continue;
        }
        const sources =
          item.qualifier === null
            ? query.sources
            : query.sources.filter((source) => {
                const reference = referenceName(source);
                return reference !== null && item.qualifier !== null && sameIdentifier(reference, item.qualifier);
              });
        for (const source of sources) columns.push(...(await this.columnsOf(source, query, depth)));
      }
      return columns;
    }
  }

  function item(kind: CompletionKind, label: string, apply: string, detail: string | null): CompletionItem {
    return { label, kind, detail, apply, boost: BOOST[kind], info: null, caret: null };
  }

  function relationItems(relations: readonly Relation[], namespace: string | null): CompletionItem[] {
    return relations.map((relation) => item(relationKind(relation), relation.name, quoted(relation.name), namespace));
  }

  function columnItems(columns: readonly ColumnInfo[]): CompletionItem[] {
    const seen = new Set<string>();
    return columns
      .filter((column) => !seen.has(column.name) && seen.add(column.name))
      .map((column) => item("column", column.name, quoted(column.name), column.type));
  }

  function keywordItems(except: ReadonlySet<string> = new Set()): CompletionItem[] {
    return options.keywords
      .filter((keyword) => !except.has(keyword.toUpperCase()))
      .map((keyword) => item("keyword", keyword, keyword, null));
  }

  function availableFunctions(server: ServerIdentity | null): (string | FunctionSpec)[] {
    return options.functions.filter((spec) => typeof spec === "string" || isAvailable(spec, server));
  }

  async function qualifiedItems(scope: ScopeAt, lookup: Lookup): Promise<CompletionItem[]> {
    const { qualifier, query, clause } = scope;
    const last = qualifier.at(-1);
    if (last === undefined) return [];
    const relational = clause === "relation" || clause === "join";
    if (qualifier.length === 1 && !relational) {
      const source = sourceNamed(query, last);
      if (source !== undefined) return columnItems(await lookup.columnsOf(source, query));
      const cte = cteNamed(query, last);
      if (cte !== undefined) return columnItems(await lookup.cteColumns(cte, 1));
    }
    const namespace = await lookup.namespace(qualifier);
    if (namespace !== undefined) return relationItems(await lookup.relations(namespace.path), null);
    if (relational) return [];
    const found = await lookup.relation(qualifier.slice(0, -1), last);
    return found === null ? [] : columnItems(found.relation.columns);
  }

  async function relationContextItems(scope: ScopeAt, lookup: Lookup): Promise<CompletionItem[]> {
    const current = lookup.current;
    const namespaces = await lookup.namespaces();
    const currentName = namespaces.find((namespace) => samePath(namespace.path, current))?.name ?? null;
    const relations = current === null ? [] : await lookup.relations(current);
    const items = [
      ...visibleCtes(scope.query).map((cte) => item("cte", cte.name.name, quoted(cte.name.name), null)),
      ...relationItems(relations, currentName),
      ...namespaces
        .filter((namespace) => !namespace.system && !samePath(namespace.path, current))
        .map((namespace) => item("namespace", namespace.name, quoted(namespace.name), namespace.kind)),
    ];
    if (scope.clause !== "join") return items;
    return [...(await joinItems(scope, lookup)), ...items];
  }

  function aliasFor(name: string, taken: Set<string>): string {
    const initials = name
      .split(ALIAS_WORD_BREAK)
      .filter((word) => word !== "")
      .map((word) => word.charAt(0).toLowerCase())
      .join("");
    const base = initials === "" || !options.plainIdentifier.test(initials) ? FALLBACK_ALIAS : initials;
    let alias = base;
    for (let suffix = 1; taken.has(alias) || reserved.has(alias.toUpperCase()); suffix += 1)
      alias = `${base}${String(suffix)}`;
    taken.add(alias);
    return alias;
  }

  function relationReference(path: readonly string[], name: string, current: readonly string[] | null): string {
    const namespace = path.at(-1);
    return samePath(path, current) || namespace === undefined ? quoted(name) : `${quoted(namespace)}.${quoted(name)}`;
  }

  /** `customers c ON c.id = o.customer_id` for each foreign key to or from a relation already in scope (plan 009 decision 7). */
  async function joinItems(scope: ScopeAt, lookup: Lookup): Promise<CompletionItem[]> {
    const before = scope.query.sources.filter(
      (source): source is RelationSource => source.kind === "relation" && source.to <= scope.prefixFrom,
    );
    const taken = new Set(
      scope.query.sources
        .map((source) => referenceName(source))
        .filter((name) => name !== null)
        .map((name) => name.name.toLowerCase()),
    );
    const items: CompletionItem[] = [];
    const seen = new Set<string>();
    const add = (label: string, detail: string): void => {
      if (seen.has(label)) return;
      seen.add(label);
      items.push(item("join", label, label, detail));
    };
    for (const source of before) {
      if (source.qualifier.length === 0 && cteNamed(scope.query, source.name) !== undefined) continue;
      const found = await lookup.relation(source.qualifier, source.name);
      if (found === null) continue;
      const near =
        source.alias === null
          ? relationReference(found.path, found.relation.name, lookup.current)
          : quoted(source.alias.name);
      for (const key of found.relation.foreignKeys) {
        const alias = aliasFor(key.target.relation, new Set(taken));
        const on = key.columns
          .map((column, at) => `${alias}.${quoted(key.target.columns[at] ?? column)} = ${near}.${quoted(column)}`)
          .join(" AND ");
        add(`${relationReference(key.target.path, key.target.relation, lookup.current)} ${alias} ON ${on}`, key.name);
      }
      for (const incoming of await lookup.referencing(found.path, found.relation.name)) {
        const key = incoming.foreignKey;
        const alias = aliasFor(incoming.relation, new Set(taken));
        const on = key.columns
          .map((column, at) => `${alias}.${quoted(column)} = ${near}.${quoted(key.target.columns[at] ?? column)}`)
          .join(" AND ");
        add(`${relationReference(incoming.path, incoming.relation, lookup.current)} ${alias} ON ${on}`, key.name);
      }
    }
    return items;
  }

  async function inScopeColumnItems(scope: ScopeAt, lookup: Lookup): Promise<CompletionItem[]> {
    const { query } = scope;
    const perSource = await Promise.all(query.sources.map((source) => lookup.columnsOf(source, query)));
    const owners = new Map<string, number>();
    for (const columns of perSource) {
      for (const name of new Set(columns.map((column) => column.name))) owners.set(name, (owners.get(name) ?? 0) + 1);
    }
    const items: CompletionItem[] = [];
    const seen = new Set<string>();
    query.sources.forEach((source, at) => {
      const reference = referenceName(source);
      for (const column of perSource[at] ?? []) {
        const shared = (owners.get(column.name) ?? 0) > 1 && reference !== null;
        const prefix = shared ? `${quoted(reference.name)}.` : "";
        const label = shared ? `${reference.name}.${column.name}` : column.name;
        if (seen.has(label)) continue;
        seen.add(label);
        items.push(item("column", label, `${prefix}${quoted(column.name)}`, column.type));
      }
    });
    const aliases = query.sources
      .filter((source) => source.alias !== null)
      .map((source) =>
        item(
          "alias",
          source.alias?.name ?? "",
          quoted(source.alias?.name ?? ""),
          source.kind === "relation" ? source.name.name : null,
        ),
      );
    const functions = availableFunctions(lookup.server);
    const functionNames = new Set(functions.map((spec) => functionName(spec).toUpperCase()));
    return [
      ...items,
      ...aliases,
      ...functions.map((spec) => functionItem(spec, BOOST.function)),
      ...keywordItems(functionNames),
    ];
  }

  async function itemsFor(scope: ScopeAt, lookup: Lookup): Promise<CompletionItem[]> {
    if (scope.clause === "none") return [];
    if (scope.qualifier.length > 0) return qualifiedItems(scope, lookup);
    switch (scope.clause) {
      case "relation":
      case "join":
        return relationContextItems(scope, lookup);
      case "columns":
        return inScopeColumnItems(scope, lookup);
      case "insertColumns": {
        const target = scope.query.insert?.source;
        const found = target === undefined ? null : await lookup.relation(target.qualifier, target.name);
        return found === null ? [] : columnItems(found.relation.columns);
      }
      case "keywords":
        return keywordItems();
    }
  }

  /** Inside a quoted name every name is offered quoted, since the editor filters on what was typed. */
  function quotedLabels(items: readonly CompletionItem[]): CompletionItem[] {
    return items.map((entry) =>
      entry.kind === "keyword" || entry.kind === "function" || entry.kind === "join"
        ? entry
        : { ...entry, label: options.quoteIdentifier(entry.label) },
    );
  }

  /** A clause body with `scope.relation` in scope reads as the WHERE of a `SELECT` from it. */
  function wrap(request: CompletionRequest): { text: string; offset: number; shift: number } {
    if (request.scope === undefined) return { text: request.text, offset: request.offset, shift: 0 };
    const { path, relation } = request.scope;
    const namespace = path.at(-1);
    const table =
      namespace === undefined
        ? options.quoteIdentifier(relation)
        : `${options.quoteIdentifier(namespace)}.${options.quoteIdentifier(relation)}`;
    const head = `SELECT * FROM ${table} WHERE `;
    return { text: head + request.text, offset: request.offset + head.length, shift: head.length };
  }

  /** Decision 2 and 3 of plan 029: what a `USE` or search path element can name, as the caret's quote needs it. */
  async function namespaceItems(slot: NamespaceSlot, lookup: Lookup): Promise<CompletionItem[]> {
    const target: NamespaceTarget = { kind: slot.kind, candidates: [] };
    const namespaces = (await lookup.namespaces()).filter(
      (namespace) =>
        targetable(target, namespace) &&
        !slot.listed.some((listed) => denotes(listed, namespace.path.at(-1) ?? namespace.name)),
    );
    const ordered = [
      ...namespaces.filter((namespace) => !namespace.system),
      ...namespaces.filter((namespace) => namespace.system),
    ];
    const quote = slot.quote;
    return ordered.map((namespace) => {
      const name = namespace.path.at(-1) ?? namespace.name;
      const apply =
        quote === null
          ? quoted(name)
          : name.replaceAll(quote.char, quote.char + quote.char) + (quote.closed ? "" : quote.char);
      const detail = samePath(namespace.path, lookup.current) ? CURRENT_DETAIL : null;
      const entry = item("namespace", name, apply, detail);
      return namespace.system ? { ...entry, boost: SYSTEM_NAMESPACE_BOOST } : entry;
    });
  }

  async function complete(request: CompletionRequest, catalog: CompletionCatalog): Promise<CompletionResult> {
    if (request.scope === undefined) {
      const slot = namespaceSlotAt(request.text, request.offset, options.dialect);
      if (slot !== null) {
        const lookup = new Lookup(catalog);
        await lookup.follow(request.text, request.offset);
        const items = await namespaceItems(slot, lookup);
        return { from: slot.from, to: slot.to, items, validFor: slot.quote === null ? UNQUOTED_WORD : null };
      }
    }
    const { text, offset, shift } = wrap(request);
    const scope = scopeAt(text, offset, options.dialect);
    const lookup = new Lookup(catalog);
    if (request.scope === undefined) await lookup.follow(text, offset);
    const items = await itemsFor(scope, lookup);
    const typedQuote = QUOTES.has(text.charAt(scope.prefixFrom)) && scope.prefixFrom < offset;
    return {
      from: scope.prefixFrom - shift,
      to: offset - shift,
      items: typedQuote ? quotedLabels(items) : items,
      validFor: typedQuote ? null : UNQUOTED_WORD,
    };
  }

  function sourceDeclaring(query: Query, word: Identifier): RelationSource | undefined {
    for (const level of levels(query)) {
      for (const source of level.sources) {
        if (source.kind === "relation" && (source.name.from === word.from || source.alias?.from === word.from))
          return source;
      }
    }
    return undefined;
  }

  async function relationDeclaration(
    lookup: Lookup,
    qualifier: readonly Identifier[],
    name: Identifier,
  ): Promise<Declaration | null> {
    const found = await lookup.relation(qualifier, name);
    return found === null ? null : { kind: "relation", path: found.path, relation: found.relation.name };
  }

  async function columnDeclaration(
    lookup: Lookup,
    source: Source,
    query: Query,
    column: Identifier,
  ): Promise<Declaration | null> {
    if (source.kind !== "relation") return null;
    if (source.qualifier.length === 0 && cteNamed(query, source.name) !== undefined) return null;
    const found = await lookup.relation(source.qualifier, source.name);
    const meta = found?.relation.columns.find((candidate) => denotes(column, candidate.name));
    return found === null || meta === undefined
      ? null
      : { kind: "column", path: found.path, relation: found.relation.name, column: meta.name };
  }

  async function resolve(request: ResolveRequest, catalog: CompletionCatalog): Promise<Declaration | null> {
    const scope = scopeAt(request.text, request.offset, options.dialect, "resolve");
    const { word, qualifier, query } = scope;
    if (word === null || scope.clause === "none") return null;
    const lookup = new Lookup(catalog);
    await lookup.follow(request.text, request.offset);
    const cte = visibleCtes(query).find((candidate) => candidate.name.from === word.from);
    if (cte !== undefined) return { kind: "cte", from: cte.name.from, to: cte.name.to };
    const declaring = sourceDeclaring(query, word);
    if (declaring !== undefined) {
      if (declaring.alias?.from === word.from) return { kind: "alias", from: declaring.from, to: declaring.to };
      if (declaring.qualifier.length === 0) {
        const named = cteNamed(query, word);
        if (named !== undefined) return { kind: "cte", from: named.name.from, to: named.name.to };
      }
      return relationDeclaration(lookup, declaring.qualifier, declaring.name);
    }
    if (qualifier.length === 0) {
      const source = sourceNamed(query, word);
      if (source !== undefined && (scope.dotAfter || source.alias !== null)) {
        if (source.alias !== null) return { kind: "alias", from: source.from, to: source.to };
        if (source.kind === "relation") return relationDeclaration(lookup, source.qualifier, source.name);
      }
      const named = cteNamed(query, word);
      if (named !== undefined) return { kind: "cte", from: named.name.from, to: named.name.to };
      if (!scope.dotAfter && scope.clause === "columns") {
        for (const candidate of query.sources) {
          const declaration = await columnDeclaration(lookup, candidate, query, word);
          if (declaration !== null) return declaration;
        }
      }
      return relationDeclaration(lookup, [], word);
    }
    if (qualifier.length === 1 && qualifier[0] !== undefined) {
      const source = sourceNamed(query, qualifier[0]);
      if (source !== undefined) return columnDeclaration(lookup, source, query, word);
    }
    const asRelation = await relationDeclaration(lookup, qualifier, word);
    if (asRelation !== null) return asRelation;
    const owner = qualifier.at(-1);
    if (owner === undefined) return null;
    const found = await lookup.relation(qualifier.slice(0, -1), owner);
    const meta = found?.relation.columns.find((candidate) => denotes(word, candidate.name));
    return found === null || meta === undefined
      ? null
      : { kind: "column", path: found.path, relation: found.relation.name, column: meta.name };
  }

  /** Whether a qualifier written before a column or `*` names the one table the SELECT reads. */
  function namesTable(qualifier: readonly Identifier[], select: SimpleSelect): boolean {
    const last = qualifier.at(-1);
    if (last === undefined) return true;
    if (select.alias !== null) return qualifier.length === 1 && sameIdentifier(last, select.alias);
    const written = [...select.qualifier, select.name];
    const tail = written.slice(-qualifier.length);
    return (
      tail.length === qualifier.length &&
      qualifier.every((part, at) => {
        const other = tail[at];
        return other !== undefined && sameIdentifier(part, other);
      })
    );
  }

  async function selectSource(sql: string, catalog: CompletionCatalog): Promise<SelectSource> {
    const select = parseSimpleSelect(sql, options.dialect);
    if ("readOnly" in select) return { kind: "readOnly", reason: select.readOnly };
    const found = await new Lookup(catalog).relation(select.qualifier, select.name);
    if (found === null) return { kind: "readOnly", reason: `the catalog does not know ${select.name.name}` };
    const tableColumns = found.relation.columns.map((column) => column.name);
    const columns: (string | null)[] = [];
    for (const item of select.items) {
      if (item.kind === "expression") {
        columns.push(null);
        continue;
      }
      const qualifier = item.kind === "star" ? (item.qualifier === null ? [] : [item.qualifier]) : item.qualifier;
      if (!namesTable(qualifier, select)) return { kind: "readOnly", reason: SELECT_READ_ONLY_REASONS.notSelect };
      if (item.kind === "star") {
        columns.push(...tableColumns);
        continue;
      }
      columns.push(tableColumns.find((name) => denotes(item.name, name)) ?? null);
    }
    return { kind: "table", path: found.path, relation: found.relation.name, columns };
  }

  function signatureAt(request: CompletionRequest, catalog: CompletionCatalog): Promise<SignatureHelp | null> {
    const { text, offset, shift } = wrap(request);
    const server = serverOf(catalog);
    const call = callAt(text, offset, options.dialect, reserved, (name) => specNamed(name, server) !== undefined);
    const spec = call === null ? undefined : specNamed(call.name, server);
    if (call === null || spec === undefined) return Promise.resolve(null);
    return Promise.resolve({
      name: spec.name.toLowerCase(),
      summary: spec.summary,
      signatures: spec.signatures,
      argument: call.argument,
      from: call.from - shift,
      to: call.to - shift,
    });
  }

  return { complete, resolve, selectSource, signatureAt };
}
