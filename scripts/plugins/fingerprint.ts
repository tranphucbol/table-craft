/**
 * What a plugin package holds, apart from its version (plan 124): two tarballs with the same
 * fingerprint ship the same plugin, so a release attaches the one already on npm instead of
 * publishing an identical copy under a new version.
 *
 * `bun scripts/plugins/fingerprint.ts --compare <dir> <dir>` fails when the same package packed into
 * both folders fingerprints differently: CI packs twice to prove the build is reproducible.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { MANIFEST_FILE } from "@table-craft/plugin-api";
import { readPackageTarball, type PackageFile } from "../../packages/desktop/src/main/pluginStore/tarball.js";

const PACKAGE_FILE = "package.json";
const TARBALL = ".tgz";
/** The files whose `version` is stamped from the release and so says nothing about the plugin. */
const VERSIONED_FILES = new Set([PACKAGE_FILE, MANIFEST_FILE]);
const SEPARATOR = "\0";

export class FingerprintError extends Error {
  override readonly name = "FingerprintError";
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
  );
}

function withoutVersion(file: PackageFile): Buffer {
  if (!VERSIONED_FILES.has(file.path)) return file.data;
  let json: unknown;
  try {
    json = JSON.parse(file.data.toString("utf8"));
  } catch {
    throw new FingerprintError(`${file.path} in the package is not JSON; repack it.`);
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new FingerprintError(`${file.path} in the package is not a JSON object; repack it.`);
  }
  const { version: _version, ...rest } = json as Record<string, unknown>;
  return Buffer.from(JSON.stringify(canonical(rest)));
}

/** sha256 over the package's files sorted by path, `version` dropped from package.json and the manifest. */
export function pluginFingerprint(files: readonly PackageFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((left, right) => (left.path < right.path ? -1 : 1))) {
    const data = withoutVersion(file);
    hash.update(`${file.path}${SEPARATOR}${String(data.length)}${SEPARATOR}`);
    hash.update(data);
  }
  return hash.digest("hex");
}

export function tarballFingerprint(bytes: Uint8Array): string {
  return pluginFingerprint(readPackageTarball(bytes));
}

function packageName(bytes: Uint8Array, file: string): string {
  const packageFile = readPackageTarball(bytes).find((entry) => entry.path === PACKAGE_FILE);
  const json = JSON.parse(packageFile?.data.toString("utf8") ?? "{}") as { name?: unknown };
  if (typeof json.name !== "string") throw new FingerprintError(`${file} has no package.json name; repack it.`);
  return json.name;
}

/** Package name → fingerprint for every `.tgz` in `directory`. */
export async function fingerprintFolder(directory: string): Promise<Map<string, string>> {
  const names = (await readdir(directory)).filter((name) => name.endsWith(TARBALL)).sort();
  if (names.length === 0)
    throw new FingerprintError(`No ${TARBALL} in ${directory}; run scripts/plugins/pack.ts first.`);
  const prints = new Map<string, string>();
  for (const name of names) {
    const file = join(directory, name);
    const bytes = await readFile(file);
    prints.set(packageName(bytes, file), tarballFingerprint(bytes));
  }
  return prints;
}

/** One line per package that is missing from either folder or fingerprints differently. */
export function fingerprintDifferences(left: Map<string, string>, right: Map<string, string>): string[] {
  const names = [...new Set([...left.keys(), ...right.keys()])].sort();
  return names.flatMap((name) => {
    const one = left.get(name);
    const other = right.get(name);
    if (one === undefined || other === undefined) return [`${name} was packed only once`];
    return one === other ? [] : [`${name} packs differently from the same source (${one} vs ${other})`];
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({ options: { compare: { type: "boolean" } }, allowPositionals: true });
  const [first, second] = positionals;
  if (values.compare !== true || first === undefined || second === undefined) {
    throw new FingerprintError("Usage: bun scripts/plugins/fingerprint.ts --compare <dir> <dir>");
  }
  const differences = fingerprintDifferences(
    await fingerprintFolder(resolve(first)),
    await fingerprintFolder(resolve(second)),
  );
  if (differences.length > 0) {
    throw new FingerprintError(
      `${differences.join("\n")}\nA build that is not reproducible republishes every plugin; find what differs between the two packs.`,
    );
  }
  console.log("every package packs the same twice");
}
