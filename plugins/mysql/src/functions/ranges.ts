import type { ServerRange } from "@table-craft/plugin-api/sql";

/** The flavours `serverIdentity` names. */
export const MYSQL_FLAVOUR = "mysql";
export const TIDB_FLAVOUR = "tidb";

/**
 * TiDB's current manual lists the function and its v4.0 manual does not, and the release between
 * that added it is not pinned, so it is offered from 5.0 on.
 */
export const TIDB_AFTER_4 = "5.0";

type From = string | false | null;

function from(version: From): string | false | undefined {
  if (version === null) return undefined;
  return version === false ? false : `>=${version}`;
}

/**
 * In MySQL from `mysql` on and in TiDB from `tidb` on; `null` means every version of that flavour and
 * `false` none.
 */
export function since(mysql: From, tidb: From = null): ServerRange {
  const range: Record<string, string | false> = {};
  const inMysql = from(mysql);
  const inTidb = from(tidb);
  if (inMysql !== undefined) range[MYSQL_FLAVOUR] = inMysql;
  if (inTidb !== undefined) range[TIDB_FLAVOUR] = inTidb;
  return range;
}

/** In MySQL before `mysql`, where it was removed, and in TiDB as `tidb` says. */
export function removedIn(mysql: string, tidb: From = null): ServerRange {
  return { ...since(null, tidb), [MYSQL_FLAVOUR]: `<${mysql}` };
}

/** Every MySQL, no TiDB. */
export const MYSQL_ONLY: ServerRange = since(null, false);

/** Every MySQL, TiDB after 4. */
export const TIDB_LATER: ServerRange = since(null, TIDB_AFTER_4);

/** TiDB only, from `tidb` on. */
export function tidbOnly(tidb: string | null = null): ServerRange {
  return since(false, tidb);
}
