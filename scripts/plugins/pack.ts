/**
 * Wraps each optional plugin as the npm package the app downloads (decision 109): the same
 * `index.js` the app would load, its manifest stamped with the release version, a README, the
 * repository's LICENSE and a `package.json` with no dependencies or scripts. Also stages and packs
 * the publishable `@tablecraft-app/plugin-api` (decision 107). Built-in plugins are never packed.
 *
 * `bun scripts/plugins/pack.ts [--out <dir>] [--version <x.y.z>] [--no-build] [--reuse-published
 * [--offline-ok]]` writes the `.tgz` files to `dist/plugin-packages/` by default;
 * `scripts/plugins/check.ts` load-checks them and `scripts/plugins/publish.ts` publishes them.
 * `--reuse-published` puts the package already on npm (`npm_config_registry`) in place of a plugin
 * that did not change since, so publishing skips it (plan 124).
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { MANIFEST_FILE } from "@table-craft/plugin-api";
import { officialPackage } from "../../packages/desktop/src/main/pluginStore/catalog.js";
import { PluginInstallError } from "../../packages/desktop/src/main/pluginStore/errors.js";
import type { RegistryFetch } from "../../packages/desktop/src/main/pluginStore/registry.js";
import { readPackageTarball } from "../../packages/desktop/src/main/pluginStore/tarball.js";
import { channelOf, type ReleaseChannel } from "../../packages/desktop/src/settings/channel.js";
import { appVersion, systemGit } from "../../packages/desktop/scripts/version.js";
import { stagePackage } from "../../packages/plugin-api/scripts/build.js";
import { OPTIONAL_OUT_DIR, OPTIONAL_PLUGINS } from "../../packages/desktop/vite.plugins.config.js";
import { baselineFor, DEFAULT_REGISTRY, type Baseline } from "./baseline.js";
import { tarballFingerprint } from "./fingerprint.js";

const ROOT = resolve(import.meta.dirname, "..", "..");
const DESKTOP = join(ROOT, "packages", "desktop");
const PLUGIN_API_PACKAGE = join(ROOT, "packages", "plugin-api", "package.json");
const LICENSE_FILE = "LICENSE";
const README_FILE = "README.md";
const PACKAGE_FILE = "package.json";
const ENTRY_FILE = "index.js";
const STAGE_DIRECTORY = "stage";
const TARBALL = ".tgz";
const REGISTRY_ENV = "npm_config_registry";
const JSON_INDENT = 2;
/** The keyword that marks a TableCraft plugin on npm (decision 109). */
export const PLUGIN_KEYWORD = "table-craft-plugin";
export const PACKAGES_DIRECTORY = join(ROOT, "dist", "plugin-packages");
/** Vite's trailing source map comment; the package ships no map, so the comment would point nowhere. */
const SOURCE_MAP_COMMENT = /\n?\/\/# sourceMappingURL=\S*\s*$/;

/** Runs `npm <args>` in `cwd` and returns its stdout. */
export type NpmPack = (args: readonly string[], cwd: string) => string;

export const systemNpm: NpmPack = (args, cwd) =>
  execFileSync("npm", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

export class PackError extends Error {
  override readonly name = "PackError";
}

export interface PackedPackage {
  readonly name: string;
  readonly version: string;
  /** Null for plugin-api. */
  readonly pluginId: string | null;
  readonly file: string;
  readonly files: readonly string[];
  readonly bytes: number;
  readonly integrity: string;
  /** True when this is the package already on npm, put in place of an identical new one. */
  readonly reused: boolean;
}

interface BuiltManifest {
  readonly id: string;
  readonly name: string;
  readonly apiVersion: string;
  readonly [field: string]: unknown;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, JSON_INDENT)}\n`);
}

function repositoryUrl(): string {
  const { repository } = readJson<{ repository?: { url?: string } }>(PLUGIN_API_PACKAGE);
  if (repository?.url === undefined) throw new PackError(`${PLUGIN_API_PACKAGE} names no repository.url.`);
  return repository.url;
}

/**
 * The manifest's `version` for package `version`: the manifest takes `major.minor.patch` only, so a
 * branch build's `0.0.0-dev.<sha>` stamps `0.0.0` and a beta's `1.16.0-beta.1` stamps `1.16.0`.
 */
export function manifestVersion(version: string): string {
  return version.replace(/-.*$/, "");
}

/** The published `package.json` of plugin `manifest` at `version`. */
export function pluginPackageJson(manifest: BuiltManifest, version: string): Record<string, unknown> {
  return {
    name: officialPackage(manifest.id),
    version,
    description: `The ${manifest.name} datasource plugin for TableCraft, downloaded by the app when a data source needs it.`,
    license: "MIT",
    type: "module",
    main: ENTRY_FILE,
    files: [ENTRY_FILE, MANIFEST_FILE],
    keywords: [PLUGIN_KEYWORD, "tablecraft", manifest.id],
    repository: { type: "git", url: repositoryUrl(), directory: `plugins/${manifest.id}` },
    publishConfig: { access: "public" },
    tableCraft: { id: manifest.id, apiVersion: manifest.apiVersion },
  };
}

function pluginReadme(manifest: BuiltManifest, packageName: string): string {
  return [
    `# ${packageName}`,
    "",
    `The ${manifest.name} datasource plugin for [TableCraft](https://github.com/tranphucbol/table-craft).`,
    "",
    `TableCraft downloads and installs this package itself when you add a ${manifest.name} data source,`,
    "so there is nothing to install by hand. Offline, download the `.tgz` from the TableCraft release",
    "and use **Settings → Plugins → Install from File…**.",
    "",
    `The package holds the bundled plugin (\`${ENTRY_FILE}\`, its driver included) and its manifest`,
    `(\`${MANIFEST_FILE}\`). It has no dependencies and is not meant to be imported by other code.`,
    "",
  ].join("\n");
}

/**
 * Stages plugin `id` from its build output in `built/<id>/` into `stage/<id>/`, ready for
 * `npm pack`, and returns that directory.
 */
export function stagePlugin(id: string, version: string, built: string, stage: string): string {
  const source = join(built, id);
  const manifest = readJson<BuiltManifest>(join(source, MANIFEST_FILE));
  if (manifest.id !== id) throw new PackError(`${source} holds plugin ${manifest.id}, not ${id}.`);
  const directory = join(stage, id);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const packageJson = pluginPackageJson(manifest, version);
  writeJson(join(directory, PACKAGE_FILE), packageJson);
  writeJson(join(directory, MANIFEST_FILE), { ...manifest, version: manifestVersion(version) });
  writeFileSync(
    join(directory, ENTRY_FILE),
    readFileSync(join(source, ENTRY_FILE), "utf8").replace(SOURCE_MAP_COMMENT, "\n"),
  );
  writeFileSync(join(directory, README_FILE), pluginReadme(manifest, packageJson.name as string));
  copyFileSync(join(ROOT, LICENSE_FILE), join(directory, LICENSE_FILE));
  return directory;
}

interface NpmPackReport {
  readonly name: string;
  readonly version: string;
  readonly filename: string;
  readonly size: number;
  readonly integrity: string;
  readonly files: readonly { readonly path: string }[];
}

/** `npm pack`s `directory` into `out` and describes the tarball. */
export function npmPack(
  directory: string,
  out: string,
  pluginId: string | null,
  npm: NpmPack = systemNpm,
): PackedPackage {
  const [report] = JSON.parse(npm(["pack", "--json", "--pack-destination", out], directory)) as NpmPackReport[];
  if (report === undefined) throw new PackError(`npm pack wrote nothing for ${directory}.`);
  return {
    name: report.name,
    version: report.version,
    pluginId,
    file: join(out, report.filename),
    files: report.files.map((file) => file.path).sort(),
    bytes: report.size,
    integrity: report.integrity,
    reused: false,
  };
}

function buildOptionalPlugins(ids: readonly string[]): void {
  for (const id of ids) {
    execFileSync("bunx", ["vite", "build", "--config", "vite.plugins.config.ts", "--mode", id], {
      cwd: DESKTOP,
      stdio: "inherit",
    });
  }
}

export interface ReuseOptions {
  readonly registry: string;
  readonly fetch: RegistryFetch;
  /** On a branch build an unreachable registry only warns and packs fresh; a tag build must know. */
  readonly offlineOk?: boolean;
  readonly warn?: (line: string) => void;
}

export interface PackOptions {
  readonly version: string;
  readonly out?: string;
  readonly build?: boolean;
  readonly built?: string;
  readonly ids?: readonly string[];
  readonly npm?: NpmPack;
  /** Attach the published package instead of a new one when nothing but the version differs. */
  readonly reuse?: ReuseOptions;
}

/** The file name `npm pack` gives `name@version`. */
export function tarballFileName(name: string, version: string): string {
  return `${name.replace(/^@/, "").replace("/", "-")}-${version}${TARBALL}`;
}

async function publishedBaseline(name: string, channel: ReleaseChannel, reuse: ReuseOptions): Promise<Baseline | null> {
  try {
    return await baselineFor(name, channel, reuse.fetch, reuse.registry);
  } catch (cause) {
    if (!(reuse.offlineOk === true && cause instanceof PluginInstallError && cause.failure === "offline")) throw cause;
    reuse.warn?.(`${name}: the registry could not be reached (${cause.message}); packed fresh.`);
    return null;
  }
}

/** `fresh`, or the published `baseline` written in its place when the two hold the same plugin. */
function reuseUnchanged(fresh: PackedPackage, out: string, baseline: Baseline | null): PackedPackage {
  if (baseline === null) return fresh;
  if (tarballFingerprint(baseline.bytes) !== tarballFingerprint(readFileSync(fresh.file))) return fresh;
  rmSync(fresh.file);
  const file = join(out, tarballFileName(fresh.name, baseline.version));
  writeFileSync(file, baseline.bytes);
  return {
    ...fresh,
    version: baseline.version,
    file,
    files: readPackageTarball(baseline.bytes)
      .map((entry) => entry.path)
      .sort(),
    bytes: baseline.bytes.length,
    integrity: baseline.integrity,
    reused: true,
  };
}

/**
 * Packs every optional plugin, and plugin-api unless `version` is a beta (plan 124: betas never
 * publish the contract), into `out`, emptied first.
 */
export async function packAll(options: PackOptions): Promise<PackedPackage[]> {
  const out = options.out ?? PACKAGES_DIRECTORY;
  const ids = options.ids ?? OPTIONAL_PLUGINS;
  const channel = channelOf(options.version);
  const stage = join(out, STAGE_DIRECTORY);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  if (options.build ?? true) buildOptionalPlugins(ids);
  const packed = channel === "beta" ? [] : [npmPack(stagePackage(), out, null, options.npm)];
  for (const id of ids) {
    const fresh = npmPack(
      stagePlugin(id, options.version, options.built ?? OPTIONAL_OUT_DIR, stage),
      out,
      id,
      options.npm,
    );
    const reuse = options.reuse;
    packed.push(
      reuse === undefined ? fresh : reuseUnchanged(fresh, out, await publishedBaseline(fresh.name, channel, reuse)),
    );
  }
  rmSync(stage, { recursive: true, force: true });
  return packed;
}

/** One line per package, then its files: what `pack.txt` records. */
export function describePacked(packed: readonly PackedPackage[]): string {
  return packed
    .map((entry) =>
      [
        `${entry.name}@${entry.version}  ${entry.reused ? "reused" : "new"}  ${entry.file.slice(entry.file.lastIndexOf("/") + 1)}  ${entry.bytes} bytes`,
        `  ${entry.integrity}`,
        ...entry.files.map((file) => `  ${file}`),
      ].join("\n"),
    )
    .join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      version: { type: "string" },
      "no-build": { type: "boolean" },
      "reuse-published": { type: "boolean" },
      "offline-ok": { type: "boolean" },
    },
  });
  const packed = await packAll({
    version: values.version ?? appVersion(systemGit),
    out: values.out === undefined ? undefined : resolve(values.out),
    build: values["no-build"] !== true,
    ...(values["reuse-published"] === true
      ? {
          reuse: {
            registry: process.env[REGISTRY_ENV] ?? DEFAULT_REGISTRY,
            fetch: globalThis.fetch,
            offlineOk: values["offline-ok"] === true,
            warn: (line: string) => console.warn(line),
          },
        }
      : {}),
  });
  console.log(describePacked(packed));
}
