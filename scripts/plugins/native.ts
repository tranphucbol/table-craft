/**
 * The native files of a plugin whose driver is a binary (decision 156): one npm package per
 * platform, each holding the same platform-neutral `index.js` beside that platform's binding. The
 * binding comes from the driver's own per-platform package on npm, pinned by the sha512 `bun.lock`
 * records, and is kept in `dist/native-cache/` so a second pack downloads nothing.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  checkIntegrity,
  downloadTarball,
  officialRegistry,
  type RegistryFetch,
} from "../../packages/desktop/src/main/pluginStore/registry.js";
import { readPackageTarball, type PackageFile } from "../../packages/desktop/src/main/pluginStore/tarball.js";
import { NATIVE_FILES } from "../../packages/desktop/vite.plugins.config.js";

const ROOT = resolve(import.meta.dirname, "..", "..");
const LOCK_FILE = join(ROOT, "bun.lock");
export const NATIVE_CACHE = join(ROOT, "dist", "native-cache");
const LICENSE_FILE = "LICENSE";

/** The npm package whose `-<platform>` packages hold each plugin's binding. */
const BINDING_PACKAGES: Readonly<Record<string, string>> = { duckdb: "@duckdb/node-bindings" };

export class NativeBindingError extends Error {
  override readonly name = "NativeBindingError";
}

export interface NativeBinding {
  readonly packageName: string;
  readonly version: string;
  /** The binding's files a plugin package carries, by name. */
  readonly files: readonly PackageFile[];
  /** The binding package's license, for the plugin's `THIRD-PARTY-NOTICES`. */
  readonly license: string;
}

/** Fetches the binding of plugin `id` for `platform`; injected in tests so none reaches npm. */
export type FetchBinding = (id: string, platform: string) => Promise<NativeBinding>;

export interface LockedPackage {
  readonly version: string;
  readonly integrity: string;
}

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** `name`'s version and sha512 as `bun.lock` records them; throws when it is not locked. */
export function lockedPackage(lock: string, name: string): LockedPackage {
  const quoted = escaped(name);
  const entry = new RegExp(`"${quoted}": \\["${quoted}@([^"]+)", "[^"]*", \\{[^}]*\\}, "(sha512-[^"]+)"\\]`).exec(lock);
  const [, version, integrity] = entry ?? [];
  if (version === undefined || integrity === undefined) {
    throw new NativeBindingError(`${name} is not in bun.lock; run bun install so the lockfile pins it.`);
  }
  return { version, integrity };
}

export function bindingPackage(id: string, platform: string): string {
  const base = BINDING_PACKAGES[id];
  if (base === undefined) throw new NativeBindingError(`Plugin ${id} has no native binding package.`);
  return `${base}-${platform}`;
}

function tarballUrl(registry: string, name: string, version: string): string {
  const bare = name.slice(name.indexOf("/") + 1);
  return `${registry.replace(/\/$/, "")}/${name}/-/${bare}-${version}.tgz`;
}

/** The binding files and license out of a binding package's tarball. */
export function bindingFiles(packageName: string, version: string, bytes: Uint8Array): NativeBinding {
  const entries = readPackageTarball(bytes);
  const files = entries.filter((entry) => (NATIVE_FILES as readonly string[]).includes(entry.path));
  if (files.length === 0)
    throw new NativeBindingError(`${packageName}@${version} holds none of ${NATIVE_FILES.join(", ")}.`);
  const license = entries.find((entry) => entry.path === LICENSE_FILE)?.data.toString("utf8");
  if (license === undefined) throw new NativeBindingError(`${packageName}@${version} carries no ${LICENSE_FILE}.`);
  return { packageName, version, files, license };
}

export interface FetchOptions {
  readonly registry: string;
  readonly fetch: RegistryFetch;
  readonly cache?: string;
  readonly lock?: string;
}

/** Downloads (or reads from the cache) the binding of plugin `id` for `platform`, checked against `bun.lock`. */
export async function fetchBinding(id: string, platform: string, options: FetchOptions): Promise<NativeBinding> {
  const name = bindingPackage(id, platform);
  const locked = lockedPackage(options.lock ?? readFileSync(LOCK_FILE, "utf8"), name);
  const cache = options.cache ?? NATIVE_CACHE;
  const cached = join(cache, `${name.replace(/^@/, "").replace("/", "-")}-${locked.version}.tgz`);
  if (existsSync(cached)) {
    const bytes = readFileSync(cached);
    checkIntegrity(bytes, { integrity: locked.integrity }, name, false);
    return bindingFiles(name, locked.version, bytes);
  }
  const bytes = await downloadTarball(
    options.fetch,
    officialRegistry(options.registry),
    tarballUrl(options.registry, name, locked.version),
    () => undefined,
  );
  checkIntegrity(bytes, { integrity: locked.integrity }, name, false);
  mkdirSync(cache, { recursive: true });
  writeFileSync(cached, bytes);
  return bindingFiles(name, locked.version, bytes);
}

/** The library beside `duckdb.node` on each platform (decision 156). */
const NATIVE_LIBRARY: Readonly<Record<string, string>> = {
  darwin: "libduckdb.dylib",
  linux: "libduckdb.so",
  win32: "duckdb.dll",
};

/** The native files a package for `platform` must carry. */
export function nativeFilesFor(platform: string): readonly string[] {
  const library = NATIVE_LIBRARY[platform.split("-")[0] ?? ""];
  return library === undefined ? ["duckdb.node"] : ["duckdb.node", library];
}
