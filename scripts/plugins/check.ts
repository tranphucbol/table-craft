/**
 * Load-checks every packed plugin (decision 109) the way the app will install it: unpacked with the
 * app's tarball reader, then loaded through core's `loadPlugins` against this host's plugin API.
 * A package that would not load fails the release before anything reaches npm.
 *
 * `bun scripts/plugins/check.ts [--from <dir>]`, `dist/plugin-packages/` by default.
 */
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadPlugins } from "../../packages/core/src/plugins/loader.js";
import { API_VERSION, MANIFEST_FILE, type DatasourcePlugin } from "@table-craft/plugin-api";
import {
  catalogEntry,
  hostPlatform,
  officialPackage,
  packageFor,
} from "../../packages/desktop/src/main/pluginStore/catalog.js";
import { PUBLISHED_NAME } from "../../packages/plugin-api/scripts/build.js";
import { readPackageTarball, writePackageFiles } from "../../packages/desktop/src/main/pluginStore/tarball.js";
import { manifestVersion, PACKAGES_DIRECTORY } from "./pack.js";
import { nativeFilesFor } from "./native.js";

const PACKAGE_FILE = "package.json";
const TARBALL = ".tgz";
/** What the host's own native package runs once, so CI opens the real binary (decision 156). */
const NATIVE_SMOKE: Readonly<
  Record<string, { readonly config: unknown; readonly sql: string; readonly answer: unknown }>
> = {
  duckdb: { config: { path: ":memory:" }, sql: "SELECT 42 AS answer", answer: 42 },
};

export class PackageCheckError extends Error {
  override readonly name = "PackageCheckError";
}

export interface CheckedPackage {
  readonly file: string;
  readonly name: string;
  readonly version: string;
  /** Null for plugin-api. */
  readonly pluginId: string | null;
}

interface PublishedJson {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly dependencies?: unknown;
  readonly scripts?: unknown;
  readonly tableCraft?: { readonly id?: unknown; readonly apiVersion?: unknown; readonly platform?: unknown };
}

function fail(file: string, why: string): never {
  throw new PackageCheckError(`${file}: ${why}`);
}

async function runNative(
  file: string,
  plugin: DatasourcePlugin,
  smoke: { readonly config: unknown; readonly sql: string; readonly answer: unknown },
): Promise<void> {
  let session: Awaited<ReturnType<DatasourcePlugin["connect"]>> | undefined;
  try {
    session = await plugin.connect(plugin.connectionSchema.parse(smoke.config), { readOnly: false });
    const result = await session.execute(smoke.sql);
    const rows: unknown[][] = [];
    for await (const row of result.rows) rows.push([...row]);
    if (rows[0]?.[0] !== smoke.answer) fail(file, `${smoke.sql} answered ${JSON.stringify(rows)}`);
  } catch (cause) {
    if (cause instanceof PackageCheckError) throw cause;
    fail(file, `does not run on this computer: ${cause instanceof Error ? cause.message : String(cause)}`);
  } finally {
    await session?.close();
  }
}

/** Checks one `.tgz`; throws `PackageCheckError` saying what is wrong. */
export async function checkPackage(file: string, hostVersion = API_VERSION): Promise<CheckedPackage> {
  const files = readPackageTarball(await readFile(file));
  const packageFile = files.find((entry) => entry.path === PACKAGE_FILE);
  if (packageFile === undefined) fail(file, "no package.json");
  const json = JSON.parse(packageFile.data.toString("utf8")) as PublishedJson;
  if (typeof json.name !== "string" || typeof json.version !== "string") fail(file, "no name or version");
  const { name, version } = json;
  if (name === PUBLISHED_NAME) {
    if (version !== hostVersion) fail(file, `plugin-api is ${version}, but this host's API_VERSION is ${hostVersion}`);
    return { file, name, version, pluginId: null };
  }
  const id = json.tableCraft?.id;
  if (typeof id !== "string") fail(file, "package.json has no tableCraft.id");
  const platform = json.tableCraft?.platform;
  if (platform !== undefined && typeof platform !== "string") fail(file, "tableCraft.platform is not a string");
  const entry = catalogEntry(id);
  const expected = platform === undefined || entry === undefined ? officialPackage(id) : packageFor(entry, platform);
  if (expected === null) fail(file, `plugin ${id} is not published for ${String(platform)}`);
  if (name !== expected) fail(file, `plugin ${id} must be published as ${expected}, not ${name}`);
  if (platform !== undefined) {
    const present = files.map((entry) => entry.path);
    const missing = nativeFilesFor(platform).filter((native) => !present.includes(native));
    if (missing.length > 0) fail(file, `the ${platform} package lacks ${missing.join(", ")}`);
  }
  if (json.dependencies !== undefined || json.scripts !== undefined) {
    fail(file, "a plugin package carries no dependencies and no scripts (decision 109)");
  }
  const directory = await mkdtemp(join(tmpdir(), "table-craft-plugin-check-"));
  try {
    await writePackageFiles(directory, files);
    const [loaded, ...extra] = await loadPlugins([{ directory }], hostVersion);
    if (loaded === undefined || extra.length > 0) fail(file, `expected one plugin, found ${extra.length + 1}`);
    if (loaded.status !== "loaded") fail(file, `does not load: ${loaded.reason}`);
    if (loaded.manifest.id !== id) fail(file, `${MANIFEST_FILE} says ${loaded.manifest.id}, package.json says ${id}`);
    if (loaded.manifest.version !== manifestVersion(version)) {
      fail(file, `${MANIFEST_FILE} is version ${loaded.manifest.version}, the package ${version}`);
    }
    if (json.tableCraft?.apiVersion !== loaded.manifest.apiVersion) {
      fail(file, `tableCraft.apiVersion differs from the manifest's ${loaded.manifest.apiVersion}`);
    }
    const smoke = NATIVE_SMOKE[id];
    if (platform === hostPlatform() && smoke !== undefined) await runNative(file, loaded.plugin, smoke);
    return { file, name, version, pluginId: id };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Checks every `.tgz` in `directory`; refuses an empty one. */
export async function checkPackages(directory: string, hostVersion = API_VERSION): Promise<CheckedPackage[]> {
  const tarballs = (await readdir(directory)).filter((name) => name.endsWith(TARBALL)).sort();
  if (tarballs.length === 0)
    throw new PackageCheckError(`No ${TARBALL} in ${directory}; run scripts/plugins/pack.ts first.`);
  const checked: CheckedPackage[] = [];
  for (const name of tarballs) checked.push(await checkPackage(join(directory, name), hostVersion));
  return checked;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { from: { type: "string" } } });
  const checked = await checkPackages(values.from === undefined ? PACKAGES_DIRECTORY : resolve(values.from));
  for (const entry of checked) {
    console.log(`ok ${entry.name}@${entry.version}${entry.pluginId === null ? "" : ` loads as ${entry.pluginId}`}`);
  }
}
