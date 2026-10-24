import type { CompletionCatalog, IncomingForeignKey, Namespace, Relation } from "@table-craft/plugin-api";
import type { CatalogCache } from "./cache.js";

/** How long completion waits for a namespace it has not described yet (decision 028). */
export const COMPLETION_DESCRIBE_DEADLINE_MS = 1_500;

export interface CompletionCatalogOptions {
  readonly deadlineMs?: number;
  /**
   * The namespace the console's session is in (decision 048), which wins over the one the cached
   * listing marks: that listing is the catalog session's, which no `USE` in a console moves.
   */
  readonly current?: readonly string[];
  /** What the catalog's session reports, so the plugin offers the functions that server has (decision 097). */
  readonly serverVersion?: string | null;
}

const TIMED_OUT = Symbol("timedOut");

/** `work`, or TIMED_OUT once `ms` pass first. A late answer still lands in the cache for next time. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The catalog cache as completion reads it: undescribed namespaces are described on demand, but a
 * keystroke never waits longer than the deadline, and a failure answers with what is cached.
 */
export async function completionCatalog(
  cache: CatalogCache,
  options: CompletionCatalogOptions = {},
): Promise<CompletionCatalog> {
  const deadlineMs = options.deadlineMs ?? COMPLETION_DESCRIBE_DEADLINE_MS;

  async function namespaces(): Promise<readonly Namespace[]> {
    const listing = cache.namespaces();
    listing.catch(() => undefined);
    const listed = await within(listing, deadlineMs).catch((): typeof TIMED_OUT => TIMED_OUT);
    return listed === TIMED_OUT ? [] : listed;
  }

  const current = options.current ?? (await namespaces()).find((namespace) => namespace.current)?.path ?? null;

  async function relations(path: readonly string[]): Promise<readonly Relation[]> {
    const fallback = (): readonly Relation[] => cache.cached(path)?.catalog.relations ?? [];
    if (cache.cached(path) !== undefined) return fallback();
    const describing = cache.describe(path);
    describing.catch(() => undefined);
    const described = await within(describing, deadlineMs).catch((): typeof TIMED_OUT => TIMED_OUT);
    return described === TIMED_OUT ? fallback() : described.catalog.relations;
  }

  function referencing(path: readonly string[], relation: string): Promise<readonly IncomingForeignKey[]> {
    const target = JSON.stringify(path);
    return Promise.resolve(
      cache
        .described()
        .flatMap(({ catalog }) =>
          catalog.relations.flatMap((source) =>
            source.foreignKeys
              .filter((key) => key.target.relation === relation && JSON.stringify(key.target.path) === target)
              .map((foreignKey) => ({ path: catalog.path, relation: source.name, foreignKey })),
          ),
        ),
    );
  }

  return { current, server: { version: options.serverVersion ?? null }, namespaces, relations, referencing };
}
