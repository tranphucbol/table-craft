/**
 * The official plugins TableCraft can download (decision 108), compiled in so the Data Sources
 * dialog lists them offline. `test/desktop/pluginStore.test.ts` pins it to
 * `OPTIONAL_PLUGINS` and to each plugin's manifest; plan 054 adds Oracle, 055 SQL Server, 058 Redis.
 */
export interface CatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly packageName: string;
  /** The URL schemes its manifest reads, so the import can offer it for a foreign connection. */
  readonly schemes: readonly string[];
  /** The packed `.tgz` (`bun run plugins:pack` prints it), rounded up; what the download entry shows. */
  readonly approximateBytes: number;
}

/** Packages in this scope, installed through the app, are official: no confirmation (decision 110). */
export const OFFICIAL_SCOPE = "@tablecraft-app/";

export function officialPackage(id: string): string {
  return `${OFFICIAL_SCOPE}plugin-${id}`;
}

export const PLUGIN_CATALOG: readonly CatalogEntry[] = [
  {
    id: "postgres",
    name: "PostgreSQL",
    packageName: officialPackage("postgres"),
    schemes: ["postgresql", "postgres"],
    approximateBytes: 190_000,
  },
  {
    id: "redis",
    name: "Redis",
    packageName: officialPackage("redis"),
    schemes: ["redis", "rediss"],
    approximateBytes: 290_000,
  },
  {
    id: "oracle",
    name: "Oracle",
    packageName: officialPackage("oracle"),
    schemes: ["oracle"],
    approximateBytes: 360_000,
  },
];

export function catalogEntry(id: string): CatalogEntry | undefined {
  return PLUGIN_CATALOG.find((entry) => entry.id === id);
}

/** The downloadable plugin that reads `scheme:` URLs, for an import that finds no installed one. */
export function catalogEntryForScheme(scheme: string): CatalogEntry | undefined {
  return PLUGIN_CATALOG.find((entry) => entry.schemes.includes(scheme));
}
