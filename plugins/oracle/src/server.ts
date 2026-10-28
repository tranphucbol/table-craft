import type { ServerIdentity } from "@table-craft/plugin-api/sql";
import { ORACLE_FLAVOUR } from "./functions/ranges.js";

/** `oracleServerVersionString` reads like `23.26.3.0.0`; 26ai still reports major 23. */
const RELEASE = /^(\d+)\.(\d+)(?:\.(\d+))?/;

/** Which function list applies; null when the version is unreadable, which offers every function. */
export function serverIdentity(serverVersion: string): ServerIdentity | null {
  const match = RELEASE.exec(serverVersion);
  if (match === null) return null;
  return {
    flavour: ORACLE_FLAVOUR,
    version: match
      .slice(1)
      .filter((part): part is string => part !== undefined)
      .map(Number),
  };
}
