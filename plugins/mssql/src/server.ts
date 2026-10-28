import type { ServerIdentity } from "@table-craft/plugin-api/sql";
import { AZURE_FLAVOUR, MSSQL_FLAVOUR } from "./functions/ranges.js";

/** `SERVERPROPERTY('EngineEdition')` of Azure SQL Database and of Azure SQL Managed Instance. */
const AZURE_EDITIONS = new Set([5, 8]);
/** What `serverVersion` starts with on Azure, whose `ProductVersion` (12.0…) names no release. */
const AZURE_PREFIX = "Azure SQL ";
const RELEASE = /(\d+)\.(\d+)(?:\.(\d+))?/;

/** `Session.serverVersion`: `ProductVersion`, such as `16.0.4135.4`, after `Azure SQL ` on Azure. */
export function serverVersionOf(productVersion: string, engineEdition: number): string {
  return AZURE_EDITIONS.has(engineEdition) ? `${AZURE_PREFIX}${productVersion}` : productVersion;
}

/**
 * Which function list applies: Azure, which has every release's functions, or SQL Server by its
 * major version (14 is 2017, 15 is 2019, 16 is 2022, 17 is 2025); null when unreadable.
 */
export function serverIdentity(serverVersion: string): ServerIdentity | null {
  const release = RELEASE.exec(serverVersion);
  if (release === null) return null;
  const version = release
    .slice(1)
    .filter((part): part is string => part !== undefined)
    .map(Number);
  return { flavour: serverVersion.startsWith(AZURE_PREFIX) ? AZURE_FLAVOUR : MSSQL_FLAVOUR, version };
}
