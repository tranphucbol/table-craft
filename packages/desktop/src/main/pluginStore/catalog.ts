/**
 * The official plugins TableCraft can download (decision 108), compiled in so the Data Sources
 * dialog lists them offline. `test/desktop/pluginStore.test.ts` pins it to
 * `OPTIONAL_PLUGINS` and to each plugin's manifest.
 */
import type { Brand } from "@table-craft/plugin-api";

export interface CatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly packageName: string;
  /** The products its manifest declares, so the picker offers one row per product before the download. */
  readonly brands: readonly Brand[];
  /** The URL schemes its manifest reads, so the import can offer it for a foreign connection. */
  readonly schemes: readonly string[];
  /** The packed `.tgz` (`bun run plugins:pack` prints it), rounded up; what the download entry shows. */
  readonly approximateBytes: number;
  /**
   * Set for a plugin with a native driver, published as one `<packageName>-<platform>` package per
   * platform listed (decision 156); absent for a plugin that runs everywhere from one package.
   */
  readonly platforms?: readonly NativePlatform[];
}

/** The `<process.platform>-<process.arch>` pairs a native plugin is published for (decision 156). */
export const NATIVE_PLATFORMS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
  "win32-x64",
  "win32-arm64",
] as const;
export type NativePlatform = (typeof NATIVE_PLATFORMS)[number];

export function hostPlatform(): string {
  return `${process.platform}-${process.arch}`;
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
    brands: [{ id: "postgresql", name: "PostgreSQL" }],
    schemes: ["postgresql", "postgres"],
    approximateBytes: 190_000,
  },
  {
    id: "redis",
    name: "Redis",
    packageName: officialPackage("redis"),
    brands: [{ id: "redis", name: "Redis" }],
    schemes: ["redis", "rediss"],
    approximateBytes: 290_000,
  },
  {
    id: "oracle",
    name: "Oracle",
    packageName: officialPackage("oracle"),
    brands: [{ id: "oracle", name: "Oracle" }],
    schemes: ["oracle"],
    approximateBytes: 360_000,
  },
  {
    id: "mssql",
    name: "SQL Server",
    packageName: officialPackage("mssql"),
    brands: [{ id: "microsoftsqlserver", name: "SQL Server" }],
    schemes: ["sqlserver", "mssql"],
    approximateBytes: 760_000,
  },
  {
    id: "etcd",
    name: "etcd",
    packageName: officialPackage("etcd"),
    brands: [{ id: "etcd", name: "etcd" }],
    schemes: ["etcd", "etcds"],
    approximateBytes: 400_000,
  },
  {
    id: "duckdb",
    name: "DuckDB",
    packageName: officialPackage("duckdb"),
    brands: [{ id: "duckdb", name: "DuckDB" }],
    schemes: ["duckdb"],
    approximateBytes: 29_000_000,
    platforms: NATIVE_PLATFORMS,
  },
];

export function catalogEntry(id: string): CatalogEntry | undefined {
  return PLUGIN_CATALOG.find((entry) => entry.id === id);
}

/** The package `entry` downloads as on `platform`; null when none is published for it. */
export function packageFor(entry: CatalogEntry, platform: string): string | null {
  if (entry.platforms === undefined) return entry.packageName;
  return (entry.platforms as readonly string[]).includes(platform) ? `${entry.packageName}-${platform}` : null;
}

/** The downloadable plugin that reads `scheme:` URLs, for an import that finds no installed one. */
export function catalogEntryForScheme(scheme: string): CatalogEntry | undefined {
  return PLUGIN_CATALOG.find((entry) => entry.schemes.includes(scheme));
}
