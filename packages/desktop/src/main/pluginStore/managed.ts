/**
 * Downloaded plugins on disk (decision 110): `<userData>/managed-plugins/<id>/<version>/` holds the
 * package, and `<id>/current.json` names the version the engines load. `current.json` is written
 * only after the unpacked version passed its check, so a failed install never replaces a working one.
 */
import { randomUUID } from "node:crypto";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PluginInstallError } from "@table-craft/desktop/main/pluginStore/errors.js";
import { writePackageFiles, type PackageFile } from "@table-craft/desktop/main/pluginStore/tarball.js";

export const MANAGED_PLUGINS_DIRECTORY = "managed-plugins";
const CURRENT_FILE = "current.json";
const STAGING_PREFIX = ".staging-";
const TEMPORARY_SUFFIX = ".tmp";
const MISSING_FILE = "ENOENT";
const DISK_FULL = "ENOSPC";
/** Plugin ids are manifest ids; this keeps one from naming a path. */
const SAFE_ID = /^[a-z0-9][a-z0-9._-]*$/;

export type ManagedSource = "registry" | "file";

export interface ManagedPlugin {
  readonly id: string;
  readonly version: string;
  readonly packageName: string;
  readonly source: ManagedSource;
  readonly directory: string;
}

function codeOf(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

function isManagedSource(value: unknown): value is ManagedSource {
  return value === "registry" || value === "file";
}

export function safeSegment(value: string): boolean {
  return SAFE_ID.test(value) && value !== "." && value !== "..";
}

async function readCurrent(root: string, id: string): Promise<ManagedPlugin | null> {
  let text: string;
  try {
    text = await readFile(join(root, id, CURRENT_FILE), "utf8");
  } catch (error) {
    if (codeOf(error) === MISSING_FILE) return null;
    throw error;
  }
  let json: { version?: unknown; packageName?: unknown; source?: unknown };
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    return null;
  }
  const { version, packageName, source } = json;
  if (typeof version !== "string" || !safeSegment(version) || typeof packageName !== "string") return null;
  if (!isManagedSource(source)) return null;
  return { id, version, packageName, source, directory: join(root, id, version) };
}

async function names(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((e) => e.name);
  } catch (error) {
    if (codeOf(error) === MISSING_FILE) return [];
    throw error;
  }
}

/** Every downloaded plugin with a readable `current.json`, by id. */
export async function listManaged(root: string): Promise<ManagedPlugin[]> {
  const found: ManagedPlugin[] = [];
  for (const id of (await names(root)).sort()) {
    if (!safeSegment(id)) continue;
    const current = await readCurrent(root, id);
    if (current !== null) found.push(current);
  }
  return found;
}

function diskFull(cause: unknown): PluginInstallError | null {
  if (codeOf(cause) !== DISK_FULL) return null;
  return new PluginInstallError(
    "diskFull",
    "The disk is full; the plugin was not installed.",
    "Free some space and try again.",
  );
}

export interface StageRequest {
  readonly id: string;
  readonly version: string;
  readonly packageName: string;
  readonly source: ManagedSource;
  readonly files: readonly PackageFile[];
  /** Null when the unpacked folder may be loaded; otherwise why not. Main reads manifests only (decision 006). */
  readonly check: (directory: string) => Promise<string | null>;
}

/**
 * Unpacks into a staging folder, checks it, moves it to `<id>/<version>/` and only then points
 * `current.json` at it. Anything that fails leaves the previous version current and no folder behind.
 */
export async function installManaged(root: string, request: StageRequest): Promise<ManagedPlugin> {
  const { id, version } = request;
  if (!safeSegment(id) || !safeSegment(version)) {
    throw new PluginInstallError(
      "invalid",
      `The plugin package names an unusable id or version ("${id}", "${version}").`,
      "Ask the plugin's author for a fixed package.",
    );
  }
  const pluginRoot = join(root, id);
  const staging = join(pluginRoot, `${STAGING_PREFIX}${randomUUID()}`);
  const target = join(pluginRoot, version);
  try {
    await writePackageFiles(staging, request.files);
    const problem = await request.check(staging);
    if (problem !== null) {
      throw new PluginInstallError(
        "invalid",
        `The plugin package cannot be loaded: ${problem}`,
        "Nothing was installed.",
      );
    }
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
    const current = { version, packageName: request.packageName, source: request.source };
    const currentPath = join(pluginRoot, CURRENT_FILE);
    await writeFile(`${currentPath}${TEMPORARY_SUFFIX}`, JSON.stringify(current, null, 2));
    await rename(`${currentPath}${TEMPORARY_SUFFIX}`, currentPath);
  } catch (cause) {
    await rm(staging, { recursive: true, force: true });
    if ((await readCurrent(root, id)) === null) await rm(pluginRoot, { recursive: true, force: true });
    throw diskFull(cause) ?? cause;
  }
  return { id, version, packageName: request.packageName, source: request.source, directory: target };
}

export async function removeManaged(root: string, id: string): Promise<void> {
  if (!safeSegment(id)) return;
  await rm(join(root, id), { recursive: true, force: true });
}

/**
 * Removes every version but the current one, and staging leftovers. Run at start, before any
 * engine has imported a plugin, so no running session loses its files.
 */
export async function pruneManaged(root: string): Promise<string[]> {
  const removed: string[] = [];
  for (const id of await names(root)) {
    const current = safeSegment(id) ? await readCurrent(root, id) : null;
    if (current === null) {
      await rm(join(root, id), { recursive: true, force: true });
      removed.push(join(root, id));
      continue;
    }
    for (const version of await names(join(root, id))) {
      if (version === current.version) continue;
      await rm(join(root, id, version), { recursive: true, force: true });
      removed.push(join(root, id, version));
    }
  }
  return removed;
}
