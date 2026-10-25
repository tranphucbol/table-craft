import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  API_VERSION,
  incompatibility,
  isCompatible,
  MANIFEST_FILE,
  parseVersion,
  pluginManifestSchema,
  type DatasourcePlugin,
  type PluginManifest,
} from "@table-craft/plugin-api";

export interface LoadedPlugin {
  readonly status: "loaded";
  readonly directory: string;
  readonly manifest: PluginManifest;
  readonly plugin: DatasourcePlugin;
}

export interface UnavailablePlugin {
  readonly status: "unavailable";
  readonly directory: string;
  /** Present when the manifest was valid, so the UI can still name the plugin. */
  readonly manifest: PluginManifest | null;
  readonly reason: string;
}

export type PluginLoadResult = LoadedPlugin | UnavailablePlugin;

/** A plugin whose manifest is valid and compatible; its code has not been run. */
export interface AvailablePlugin {
  readonly status: "available";
  readonly directory: string;
  readonly manifest: PluginManifest;
}

export type PluginDiscovery = AvailablePlugin | UnavailablePlugin;

const MISSING_FILE = "ENOENT";

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === MISSING_FILE;
}

async function pluginDirectories(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name))
      .sort();
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

function incompatibleReason(apiVersion: string, hostVersion: string): string {
  const why = incompatibility(apiVersion, hostVersion);
  const needed = parseVersion(apiVersion);
  const host = parseVersion(hostVersion);
  if (why === "newer" && needed !== null) {
    return `Built for plugin API ${apiVersion}: needs TableCraft with plugin API ${needed.major}.${needed.minor} or later; this TableCraft provides ${hostVersion}. Update the app.`;
  }
  if (why === "olderMajor" && host !== null) {
    return `Built for plugin API ${apiVersion}, an older major than this TableCraft's ${hostVersion}. Install a version of the plugin built for plugin API ${host.major}.x.`;
  }
  return `Built for plugin API ${apiVersion}, but this TableCraft provides ${hostVersion}. Install a compatible version of the plugin.`;
}

type ManifestRead = { ok: true; manifest: PluginManifest } | { ok: false; reason: string };

async function readManifest(directory: string, hostVersion: string): Promise<ManifestRead> {
  let text: string;
  try {
    text = await readFile(join(directory, MANIFEST_FILE), "utf8");
  } catch (error) {
    if (isMissing(error)) return { ok: false, reason: `No ${MANIFEST_FILE}; add one or remove the directory.` };
    return { ok: false, reason: `Cannot read ${MANIFEST_FILE}: ${describe(error)}` };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `${MANIFEST_FILE} is not valid JSON: ${describe(error)}` };
  }
  const parsed = pluginManifestSchema.safeParse(json);
  const apiVersion = (json as { apiVersion?: unknown } | null)?.apiVersion;
  if (!parsed.success && typeof apiVersion === "string" && !isCompatible(apiVersion, hostVersion)) {
    // An older plugin fails the schema for fields its contract never had; the version says why.
    return { ok: false, reason: incompatibleReason(apiVersion, hostVersion) };
  }
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    return { ok: false, reason: `${MANIFEST_FILE} is invalid: ${issues.join("; ")}` };
  }
  return { ok: true, manifest: parsed.data };
}

function isDatasourcePlugin(value: unknown): value is DatasourcePlugin {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const schema = candidate["connectionSchema"] as { safeParse?: unknown } | undefined;
  return (
    typeof candidate["id"] === "string" &&
    Array.isArray(candidate["capabilities"]) &&
    typeof candidate["connect"] === "function" &&
    typeof schema?.safeParse === "function"
  );
}

const LANGUAGE_METHODS = ["split", "classify", "quoteIdentifier", "literal"] as const;
type LanguageMethod = (typeof LANGUAGE_METHODS)[number];

/**
 * `language` is how the console splits and classifies and how Copy writes SQL (decision 008); a
 * SQL plugin cannot run without it.
 */
function hasLanguage(plugin: DatasourcePlugin): boolean {
  const language = plugin.language as Partial<Record<LanguageMethod, unknown>> | undefined;
  return LANGUAGE_METHODS.every((method) => typeof language?.[method] === "function");
}

function sameCapabilities(manifest: PluginManifest, plugin: DatasourcePlugin): boolean {
  const declared = new Set<string>(manifest.capabilities);
  return declared.size === plugin.capabilities.length && plugin.capabilities.every((name) => declared.has(name));
}

async function importPlugin(directory: string, manifest: PluginManifest): Promise<PluginLoadResult> {
  const unavailable = (reason: string): UnavailablePlugin => ({ status: "unavailable", directory, manifest, reason });
  const entry = resolve(directory, manifest.entry);
  const fromDirectory = relative(directory, entry);
  if (fromDirectory.startsWith("..") || isAbsolute(fromDirectory)) {
    return unavailable(`entry "${manifest.entry}" points outside the plugin directory.`);
  }
  let module: { default?: unknown };
  try {
    module = (await import(/* @vite-ignore */ pathToFileURL(entry).href)) as { default?: unknown };
  } catch (error) {
    return unavailable(`entry "${manifest.entry}" failed to load: ${describe(error)}`);
  }
  const plugin = module.default;
  if (!isDatasourcePlugin(plugin)) {
    return unavailable(`entry "${manifest.entry}" has no default export implementing DatasourcePlugin.`);
  }
  if (plugin.id !== manifest.id) {
    return unavailable(`entry exports plugin "${plugin.id}" but the manifest declares "${manifest.id}".`);
  }
  if (!sameCapabilities(manifest, plugin)) {
    return unavailable("capabilities in the manifest and the entry's export differ; make them match.");
  }
  if (plugin.capabilities.includes("sql") && !hasLanguage(plugin)) {
    return unavailable(
      "declares sql but exports no language with split, classify, quoteIdentifier and literal; add one (plugin-api/sql helps).",
    );
  }
  return { status: "loaded", directory, manifest, plugin };
}

/**
 * Reads every plugin directory under `roots`, in order, without running any plugin code
 * (decision 005), so main can list plugins and their connection forms (decision 019). Earlier
 * roots win an id clash, so pass the built-in root first. `hostVersion` is the plugin API the host
 * provides; only tests pass another.
 */
export async function discoverPlugins(
  roots: readonly string[],
  hostVersion: string = API_VERSION,
): Promise<PluginDiscovery[]> {
  const results: PluginDiscovery[] = [];
  const claimed = new Map<string, string>();
  for (const root of roots) {
    for (const directory of await pluginDirectories(root)) {
      const read = await readManifest(directory, hostVersion);
      if (!read.ok) {
        results.push({ status: "unavailable", directory, manifest: null, reason: read.reason });
        continue;
      }
      const { manifest } = read;
      const owner = claimed.get(manifest.id);
      if (owner !== undefined) {
        const reason = `Duplicate plugin id "${manifest.id}": ${directory} conflicts with ${owner}, which loaded first. Remove one.`;
        results.push({ status: "unavailable", directory, manifest, reason });
        continue;
      }
      claimed.set(manifest.id, directory);
      if (!isCompatible(manifest.apiVersion, hostVersion)) {
        const reason = incompatibleReason(manifest.apiVersion, hostVersion);
        results.push({ status: "unavailable", directory, manifest, reason });
        continue;
      }
      results.push({ status: "available", directory, manifest });
    }
  }
  return results;
}

/**
 * Loads every plugin `discoverPlugins` finds available. A broken plugin becomes an
 * `UnavailablePlugin` with a reason; it never stops the others.
 */
export async function loadPlugins(
  roots: readonly string[],
  hostVersion: string = API_VERSION,
): Promise<PluginLoadResult[]> {
  const results: PluginLoadResult[] = [];
  for (const found of await discoverPlugins(roots, hostVersion)) {
    results.push(found.status === "available" ? await importPlugin(found.directory, found.manifest) : found);
  }
  return results;
}
