import { basename } from "node:path";
import { discoverPlugins } from "@table-craft/core";
import type { PluginInfo } from "@table-craft/desktop/preload/bridge.js";

/**
 * Every installed plugin, from manifests alone (decision 019): main never runs plugin code
 * (decision 006). A broken plugin is listed with its reason so the dialog can say why it is
 * greyed out; the engine's loader may still reject an available one when it imports the entry.
 */
export async function listPlugins(roots: readonly string[]): Promise<PluginInfo[]> {
  return (await discoverInstalled(roots)).plugins;
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

export async function discoverInstalled(roots: readonly string[]): Promise<InstalledPlugins> {
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
      unavailableReason: entry.status === "unavailable" ? entry.reason : null,
      capabilities: manifest?.capabilities ?? [],
      fields: manifest?.connection.fields ?? [],
      highlight: manifest?.highlight ?? null,
      url: manifest?.connection.url ?? null,
      network: manifest?.connection.network ?? null,
      tls: manifest?.connection.tls ?? null,
    };
  });
  return { plugins, report };
}
