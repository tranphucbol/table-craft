import { basename } from "node:path";
import { discoverPlugins, type PluginRoot } from "@table-craft/core";
import type { PluginInfo, PluginSource } from "@table-craft/desktop/preload/bridge.js";

/**
 * Every installed plugin, from manifests alone (decision 019): main never runs plugin code
 * (decision 006). A broken plugin is listed with its reason so the dialog can say why it is
 * greyed out; the engine's loader may still reject an available one when it imports the entry.
 */
export async function listPlugins(
  roots: readonly PluginRoot[],
  sourceOf: (directory: string) => PluginSource = () => "builtIn",
): Promise<PluginInfo[]> {
  return (await discoverInstalled(roots, sourceOf)).plugins;
}

/** What the log and `about.json` say about one installed plugin (plan 017 decisions 7 and 10). */
export interface PluginReport {
  readonly id: string;
  readonly version: string | null;
  readonly apiVersion: string | null;
  readonly directory: string;
  readonly status: "available" | "unavailable";
  readonly reason: string | null;
}

export interface InstalledPlugins {
  readonly plugins: PluginInfo[];
  readonly report: PluginReport[];
}

/** Why the folder cannot be loaded as plugin `id`, from its manifest alone; null when it can. */
export async function manifestProblem(directory: string, id: string, hostVersion?: string): Promise<string | null> {
  const [entry] = await discoverPlugins([{ directory }], hostVersion);
  if (entry === undefined) return "it holds no table-craft-plugin.json.";
  if (entry.status === "unavailable") return entry.reason;
  if (entry.manifest.id !== id) return `its manifest names "${entry.manifest.id}", not "${id}".`;
  return null;
}

export async function discoverInstalled(
  roots: readonly PluginRoot[],
  sourceOf: (directory: string) => PluginSource,
): Promise<InstalledPlugins> {
  const found = await discoverPlugins(roots);
  const report = found.map((entry): PluginReport => ({
    id: entry.manifest?.id ?? basename(entry.directory),
    version: entry.manifest?.version ?? null,
    apiVersion: entry.manifest?.apiVersion ?? null,
    directory: entry.directory,
    status: entry.status === "unavailable" ? "unavailable" : "available",
    reason: entry.status === "unavailable" ? entry.reason : null,
  }));
  const plugins = found.map((entry) => {
    const manifest = entry.manifest;
    return {
      id: manifest?.id ?? basename(entry.directory),
      name: manifest?.name ?? basename(entry.directory),
      source: sourceOf(entry.directory),
      version: manifest?.version ?? null,
      unavailableReason: entry.status === "unavailable" ? entry.reason : null,
      capabilities: manifest?.capabilities ?? [],
      fields: manifest?.connection.fields ?? [],
      highlight: manifest?.highlight ?? null,
      brands: manifest?.brands ?? [],
      url: manifest?.connection.url ?? null,
      network: manifest?.connection.network ?? null,
      tls: manifest?.connection.tls ?? null,
    };
  });
  return { plugins, report };
}
