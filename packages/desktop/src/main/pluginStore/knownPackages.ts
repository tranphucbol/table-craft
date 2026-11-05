/**
 * `<userData>/plugin-packages.json` (decision 158): what each package installed from a private
 * registry holds, written at each install. A package that settings name maps to its plugin id here
 * without a download, so a missing datasource plugin can be offered and Available can name it.
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import type { Brand } from "@table-craft/plugin-api";

export const PLUGIN_PACKAGES_FILE = "plugin-packages.json";
const TEMPORARY_SUFFIX = ".tmp";
const JSON_INDENT = 2;

export interface KnownPackage {
  readonly id: string;
  readonly name: string;
  readonly brands: readonly Brand[];
  readonly schemes: readonly string[];
  /** The last downloaded tarball's size, what the Available row shows before the next download. */
  readonly bytes: number;
}

function knownPackage(value: unknown): KnownPackage | null {
  const entry = value as Partial<Record<keyof KnownPackage, unknown>> | null;
  if (typeof entry?.id !== "string" || typeof entry.name !== "string") return null;
  return {
    id: entry.id,
    name: entry.name,
    brands: Array.isArray(entry.brands) ? (entry.brands as Brand[]) : [],
    schemes: Array.isArray(entry.schemes) ? (entry.schemes as string[]) : [],
    bytes: typeof entry.bytes === "number" ? entry.bytes : 0,
  };
}

/** Every readable entry by package name; a missing or unreadable file knows none. */
export async function readKnownPackages(path: string): Promise<ReadonlyMap<string, KnownPackage>> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return new Map();
  }
  const known = new Map<string, KnownPackage>();
  if (typeof json !== "object" || json === null || Array.isArray(json)) return known;
  for (const [packageName, value] of Object.entries(json)) {
    const entry = knownPackage(value);
    if (entry !== null) known.set(packageName, entry);
  }
  return known;
}

export async function rememberPackage(path: string, packageName: string, entry: KnownPackage): Promise<void> {
  const known = Object.fromEntries(await readKnownPackages(path));
  known[packageName] = entry;
  await writeFile(`${path}${TEMPORARY_SUFFIX}`, `${JSON.stringify(known, null, JSON_INDENT)}\n`);
  await rename(`${path}${TEMPORARY_SUFFIX}`, path);
}
