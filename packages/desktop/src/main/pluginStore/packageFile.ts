/** What a plugin package's `package.json` and manifest say, read from its unpacked files. */
import type { Brand } from "@table-craft/plugin-api";
import { PluginInstallError } from "@table-craft/desktop/main/pluginStore/errors.js";
import { readPackageTarball, type PackageFile } from "@table-craft/desktop/main/pluginStore/tarball.js";

const PACKAGE_JSON = "package.json";
const MANIFEST_FILE = "table-craft-plugin.json";

export interface PackageJson {
  readonly name: string;
  readonly version: string;
  readonly id: string;
  /** `tableCraft.apiVersion`; absent in a package built before it was published there. */
  readonly apiVersion?: string;
  /** The platform a native plugin's package is built for; absent for one that runs everywhere. */
  readonly platform?: string;
}

/** The manifest's own words for what the plugin adds, for a confirmation and the Available list. */
export interface ManifestSummary {
  readonly name: string;
  readonly apiVersion: string | null;
  readonly brands: readonly Brand[];
  readonly schemes: readonly string[];
}

/** The package a `.tgz` holds, read before the trust confirmation names it; throws when it is not a plugin. */
export function inspectPackage(bytes: Uint8Array): PackageJson {
  return readPackageJson(readPackageTarball(bytes));
}

function invalid(why: string): PluginInstallError {
  return new PluginInstallError(
    "invalid",
    `The file is not a TableCraft plugin package: ${why}.`,
    "Pick a plugin's .tgz.",
  );
}

function parsed<T>(file: PackageFile, why: string): T {
  try {
    return JSON.parse(file.data.toString("utf8")) as T;
  } catch {
    throw invalid(why);
  }
}

export function readPackageJson(files: readonly PackageFile[]): PackageJson {
  const file = files.find((entry) => entry.path === PACKAGE_JSON);
  if (file === undefined) throw invalid("it has no package.json");
  if (!files.some((entry) => entry.path === MANIFEST_FILE)) throw invalid(`it has no ${MANIFEST_FILE}`);
  const json = parsed<{
    name?: unknown;
    version?: unknown;
    tableCraft?: { id?: unknown; apiVersion?: unknown; platform?: unknown };
  }>(file, "its package.json is not JSON");
  const { name, version, tableCraft } = json;
  if (typeof name !== "string" || typeof version !== "string" || typeof tableCraft?.id !== "string") {
    throw invalid("its package.json has no name, version or tableCraft.id");
  }
  const { platform, apiVersion } = tableCraft;
  if (platform !== undefined && typeof platform !== "string") throw invalid("its tableCraft.platform is not a string");
  return {
    name,
    version,
    id: tableCraft.id,
    ...(typeof apiVersion === "string" ? { apiVersion } : {}),
    ...(platform === undefined ? {} : { platform }),
  };
}

function isBrand(value: unknown): value is Brand {
  const brand = value as { id?: unknown; name?: unknown } | null;
  return typeof brand?.id === "string" && typeof brand.name === "string";
}

/** Read loosely: the full check runs on the unpacked folder before anything is installed. */
export function readManifestSummary(files: readonly PackageFile[], fallbackName: string): ManifestSummary {
  const file = files.find((entry) => entry.path === MANIFEST_FILE);
  if (file === undefined) throw invalid(`it has no ${MANIFEST_FILE}`);
  const manifest = parsed<{
    name?: unknown;
    apiVersion?: unknown;
    brands?: unknown;
    connection?: { url?: { schemes?: unknown } };
  }>(file, `its ${MANIFEST_FILE} is not JSON`);
  const schemes = manifest.connection?.url?.schemes;
  return {
    name: typeof manifest.name === "string" ? manifest.name : fallbackName,
    apiVersion: typeof manifest.apiVersion === "string" ? manifest.apiVersion : null,
    brands: Array.isArray(manifest.brands) ? manifest.brands.filter(isBrand) : [],
    schemes: Array.isArray(schemes) ? schemes.filter((scheme): scheme is string => typeof scheme === "string") : [],
  };
}
