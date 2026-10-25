import { switchableTo, type CompletionCatalog, type Namespace, type Relation } from "@table-craft/plugin-api";
import type { ServerIdentity } from "./functions.js";
import { namespaceTarget, type NamespaceTarget } from "./namespace.js";
import type { Cte, Identifier, Query, Source } from "./scope.js";
import { sqlSplitter } from "./splitter.js";
import type { SqlDialectOptions } from "./tokens.js";

/** How a dialect reads unquoted names: PostgreSQL folds them to lower case, MySQL and SQLite compare them as written. */
export type IdentifierFolding = "lower" | "upper" | "none";

/** What name resolution needs to know about a dialect; a subset of `CompleterOptions`. */
export interface NameOptions {
  readonly dialect: SqlDialectOptions;
  readonly identifierFolding: IdentifierFolding;
  /** Reads the catalog's server version into the flavour and version the specs' ranges name; null when it cannot. */
  readonly server?: (version: string) => ServerIdentity | null;
}

/** CTEs that read each other stop expanding here, so a recursive one cannot loop. */
export const MAX_EXPANSION_DEPTH = 4;

export interface ColumnInfo {
  readonly name: string;
  readonly type: string | null;
}

export interface FoundRelation {
  readonly path: readonly string[];
  readonly relation: Relation;
}

export function samePath(left: readonly string[] | null, right: readonly string[] | null): boolean {
  return (
    left !== null && right !== null && left.length === right.length && left.every((part, at) => part === right[at])
  );
}

/** Whether `namespace` is one `target` can switch to (found live, plan 022). */
export function targetable(target: NamespaceTarget, namespace: Namespace): boolean {
  return switchableTo(target.kind === "database" ? "topLevel" : "schema", namespace);
}

/** Every query level from `query` outwards. */
export function levels(query: Query): Query[] {
  const found: Query[] = [];
  for (let level: Query | null = query; level !== null; level = level.parent) found.push(level);
  return found;
}

export function visibleCtes(query: Query): Cte[] {
  return levels(query).flatMap((level) => level.ctes);
}

/** The name a source is referred to by: its alias, else its relation's name. */
export function referenceName(source: Source): Identifier | null {
  return source.alias ?? (source.kind === "relation" ? source.name : null);
}

/**
 * The dialect's name rules and a catalog reader over them, shared by completion, navigation and
 * inspections (decision 028, plan 108) so all three agree on what a name denotes.
 */
export function nameRules(options: NameOptions) {
  const split = sqlSplitter(options.dialect);

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

  function cteNamed(query: Query, name: Identifier): Cte | undefined {
    return visibleCtes(query).find((cte) => sameIdentifier(cte.name, name));
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

  function serverOf(catalog: CompletionCatalog): ServerIdentity | null {
    const version = catalog.server.version;
    return version === null || options.server === undefined ? null : options.server(version);
  }

  /** One request's view of the catalog: every read is caught, and each namespace is asked once. */
  class Lookup {
    readonly #catalog: CompletionCatalog;
    #namespaces: Promise<readonly Namespace[]> | null = null;
    readonly #relations = new Map<string, Promise<readonly Relation[]>>();
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
        await this.switchTo(target);
        return;
      }
    }

    /** Moves `current` to the namespace `target` names, when the catalog has one. */
    async switchTo(target: NamespaceTarget): Promise<void> {
      const namespaces = (await this.namespaces()).filter((namespace) => targetable(target, namespace));
      for (const candidate of target.candidates) {
        const found = namespaces.find((namespace) => denotes(candidate, namespace.path.at(-1) ?? ""));
        if (found !== undefined) {
          this.#current = found.path;
          return;
        }
      }
    }

    namespaces(): Promise<readonly Namespace[]> {
      this.#namespaces ??= this.#catalog.namespaces().catch(() => []);
      return this.#namespaces;
    }

    relations(path: readonly string[]): Promise<readonly Relation[]> {
      const key = JSON.stringify(path);
      let found = this.#relations.get(key);
      if (found === undefined) {
        found = this.#catalog.relations(path).catch(() => []);
        this.#relations.set(key, found);
      }
      return found;
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

  return { fold, denotes, sameIdentifier, cteNamed, sourceNamed, serverOf, Lookup };
}

export type NameRules = ReturnType<typeof nameRules>;
export type Lookup = InstanceType<NameRules["Lookup"]>;
