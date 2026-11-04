import type { Namespace } from "@table-craft/desktop/engine/protocol.js";

/** Engines may report a path as one dotted segment, so landings compare as joined text. */
const NAMESPACE_SEPARATOR = ".";

function startsWith(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length > 0 && prefix.length <= path.length && prefix.every((segment, index) => segment === path[index]);
}

/**
 * Whether a switch to `target` landed in it: SQL Server's `USE db` lands in `db.dbo`, inside the
 * target, which is no miss.
 */
export function landedIn(landed: readonly string[], target: readonly string[]): boolean {
  const at = landed.join(NAMESPACE_SEPARATOR);
  const wanted = target.join(NAMESPACE_SEPARATOR);
  return at === wanted || (wanted !== "" && at.startsWith(`${wanted}${NAMESPACE_SEPARATOR}`));
}

/**
 * Where a console opened on an explorer node starts (plan 153): the deepest switch target whose
 * path leads to `path`, so a SQL Server schema opens its database and a PostgreSQL table its
 * schema; null when no target holds the node, and the console stays in the default namespace.
 */
export function consoleNamespaceFor(path: readonly string[], targets: readonly Namespace[]): readonly string[] | null {
  let found: readonly string[] | null = null;
  for (const { path: candidate } of targets) {
    if (startsWith(path, candidate) && (found === null || candidate.length > found.length)) found = candidate;
  }
  return found;
}
