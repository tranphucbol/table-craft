/**
 * Plan 057's profile fixtures: the optional plugins the development build leaves in
 * `dist/optional-plugins/`, seeded into a profile's managed folder or served by the loopback
 * registry, so no smoke scenario reaches registry.npmjs.org (decision 110).
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pluginPackageName, release, type RegistryRelease } from "../support/pluginRegistry.js";
import { logLines, type LoggedLine } from "./updateServer.js";

const OPTIONAL_PLUGINS = resolve(import.meta.dirname, "../../packages/desktop/dist/optional-plugins");
const MANAGED_PLUGINS_DIRECTORY = "managed-plugins";
const MANIFEST_FILE = "table-craft-plugin.json";
const ENTRY_FILE = "index.js";
const PLUGINS_SCOPE = "plugins";
/** A port nothing listens on: the registry is unreachable without any request leaving the machine. */
export const UNREACHABLE_REGISTRY = "http://127.0.0.1:9";

function builtFile(id: string, file: string): Buffer {
  const path = join(OPTIONAL_PLUGINS, id, file);
  if (!existsSync(path))
    throw new Error(`${path} is missing; build the desktop app first (bun run test:smoke builds it).`);
  return readFileSync(path);
}

/** A registry release of the optional plugin `id` as the development build bundled it. */
export function builtRelease(id: string, version: string, integrity?: string): RegistryRelease {
  return release({ id, version, indexJs: builtFile(id, ENTRY_FILE) }, integrity);
}

/**
 * Puts the built optional plugin `id` into `<userData>/managed-plugins/<id>/<version>/` as if it had
 * been installed from a file, so the background update check never asks a registry about it.
 */
export function seedManagedPlugin(userDataDir: string, id: string, version = "0.0.0"): void {
  const root = join(userDataDir, MANAGED_PLUGINS_DIRECTORY, id);
  const directory = join(root, version);
  mkdirSync(directory, { recursive: true });
  const manifest = JSON.parse(builtFile(id, MANIFEST_FILE).toString("utf8")) as Record<string, unknown>;
  writeFileSync(join(directory, MANIFEST_FILE), JSON.stringify({ ...manifest, version }, null, 2));
  cpSync(join(OPTIONAL_PLUGINS, id, ENTRY_FILE), join(directory, ENTRY_FILE));
  const current = { version, packageName: pluginPackageName(id), source: "file" };
  writeFileSync(join(root, "current.json"), JSON.stringify(current, null, 2));
}

/** Every path under the profile's managed folder, one per line, or a note that it does not exist. */
export function managedListing(userDataDir: string): string {
  const root = join(userDataDir, MANAGED_PLUGINS_DIRECTORY);
  if (!existsSync(root)) return `${MANAGED_PLUGINS_DIRECTORY}/ does not exist\n`;
  const paths: string[] = [];
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const isDirectory = statSync(path).isDirectory();
      paths.push(`${MANAGED_PLUGINS_DIRECTORY}/${relative(root, path)}${isDirectory ? "/" : ""}`);
      if (isDirectory) walk(path);
    }
  };
  walk(root);
  return `${paths.join("\n")}\n`;
}

export function pluginLines(userDataDir: string): readonly LoggedLine[] {
  return logLines(userDataDir).filter((line) => line.scope === PLUGINS_SCOPE);
}
