import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPluginById, loadPlugins, type PluginLoadResult } from "@table-craft/core";
import { API_VERSION, MANIFEST_FILE, parseVersion } from "@table-craft/plugin-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ENTRY_FILE = "index.mjs";
const HOST = parseVersion(API_VERSION);
if (HOST === null) throw new Error(`API_VERSION ${API_VERSION} is not semver.`);
const { major, minor, patch } = HOST;
const NEWER_MINOR_API_VERSION = `${major}.${minor + 1}.0`;
const NEXT_MAJOR_API_VERSION = `${major + 1}.0.0`;
/** The last 0.x contract; 1.0 is another major (decision 106). */
const PREVIOUS_MAJOR_API_VERSION = "0.28.0";
const OLDER_MINOR_API_VERSION = "1.0.0";
const NEWER_HOST_API_VERSION = "1.3.0";
const CONNECTION = { fields: [{ key: "path", label: "Path", kind: "text" }] };

function pluginSource(id: string): string {
  return `export default {
  id: ${JSON.stringify(id)},
  capabilities: ["sql"],
  language: {
    split: () => [],
    classify: () => ({ kind: "other", destructive: null }),
    quoteIdentifier: (name) => name,
    literal: () => "NULL",
  },
  connectionSchema: { safeParse: (value) => ({ success: true, data: value }) },
  connect: async () => ({ execute: async () => { throw new Error("not used"); }, close: async () => {} }),
};
`;
}

interface PluginFiles {
  readonly id: string;
  readonly apiVersion?: string;
  readonly source?: string;
  readonly capabilities?: readonly string[];
}

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "table-craft-loader-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

async function writePlugin(root: string, directoryName: string, files: PluginFiles): Promise<string> {
  const directory = join(workspace, root, directoryName);
  await mkdir(directory, { recursive: true });
  const manifest = {
    id: files.id,
    name: files.id,
    version: "1.0.0",
    apiVersion: files.apiVersion ?? API_VERSION,
    entry: ENTRY_FILE,
    capabilities: files.capabilities ?? ["sql"],
    highlight: "sql",
    connection: CONNECTION,
  };
  await writeFile(join(directory, MANIFEST_FILE), JSON.stringify(manifest));
  await writeFile(join(directory, ENTRY_FILE), files.source ?? pluginSource(files.id));
  return directory;
}

function byStatus(results: readonly PluginLoadResult[], status: PluginLoadResult["status"]): string[] {
  return results.filter((result) => result.status === status).map((result) => result.manifest?.id ?? "?");
}

describe("loadPlugins", () => {
  it("givenValidPlugin_whenLoaded_thenPluginIsLoaded", async () => {
    await writePlugin("builtin", "alpha", { id: "alpha" });

    const results = await loadPlugins([join(workspace, "builtin")]);

    expect(byStatus(results, "loaded")).toEqual(["alpha"]);
  });

  it("givenPluginBuiltForOlderMinor_whenLoaded_thenAccepted", async () => {
    await writePlugin("builtin", "alpha", { id: "alpha", apiVersion: OLDER_MINOR_API_VERSION });

    const results = await loadPlugins([join(workspace, "builtin")], NEWER_HOST_API_VERSION);

    expect(byStatus(results, "loaded")).toEqual(["alpha"]);
  });

  it("givenPluginWithHigherPatch_sameMinor_whenLoaded_thenAccepted", async () => {
    await writePlugin("builtin", "alpha", { id: "alpha", apiVersion: `${major}.${minor}.${patch + 1}` });

    const results = await loadPlugins([join(workspace, "builtin")]);

    expect(byStatus(results, "loaded")).toEqual(["alpha"]);
  });

  it("givenPluginBuiltForNewerMinor_whenLoaded_thenRefusedNamingAppVersion", async () => {
    await writePlugin("builtin", "alpha", { id: "alpha", apiVersion: NEWER_MINOR_API_VERSION });

    const [result] = await loadPlugins([join(workspace, "builtin")]);

    expect(result).toMatchObject({ status: "unavailable", manifest: { id: "alpha" } });
    expect(result?.status === "unavailable" && result.reason).toBe(
      `Built for plugin API ${NEWER_MINOR_API_VERSION}: needs TableCraft with plugin API ${major}.${minor + 1} or later; this TableCraft provides ${API_VERSION}. Update the app.`,
    );
  });

  it("givenPluginOfOtherMajor_whenLoaded_thenRefused", async () => {
    await writePlugin("builtin", "older", { id: "older", apiVersion: PREVIOUS_MAJOR_API_VERSION });
    await writePlugin("builtin", "newer", { id: "newer", apiVersion: NEXT_MAJOR_API_VERSION });

    const results = await loadPlugins([join(workspace, "builtin")]);

    const reasons = new Map<string | undefined, string | null>(
      results.map((result) => [result.manifest?.id, result.status === "unavailable" ? result.reason : null]),
    );
    expect(reasons.get("older")).toBe(
      `Built for plugin API ${PREVIOUS_MAJOR_API_VERSION}, an older major than this TableCraft's ${API_VERSION}. Install a version of the plugin built for plugin API ${major}.x.`,
    );
    expect(reasons.get("newer")).toContain(`needs TableCraft with plugin API ${major + 1}.0 or later`);
  });

  it("givenDuplicatePluginId_whenLoaded_thenErrorNamesBothPaths", async () => {
    const first = await writePlugin("builtin", "alpha", { id: "alpha" });
    const second = await writePlugin("user", "alpha-copy", { id: "alpha" });

    const results = await loadPlugins([join(workspace, "builtin"), join(workspace, "user")]);

    expect(byStatus(results, "loaded")).toEqual(["alpha"]);
    const duplicate = results.find((result) => result.directory === second);
    expect(duplicate?.status).toBe("unavailable");
    expect(duplicate?.status === "unavailable" && duplicate.reason).toContain(first);
    expect(duplicate?.status === "unavailable" && duplicate.reason).toContain(second);
  });

  it("givenDirectoryRoot_whenLoaded_thenThatOnePluginIsReadAndEarlierRootsStillWin", async () => {
    await writePlugin("builtin", "alpha", { id: "alpha" });
    const managed = await writePlugin("managed", "beta", { id: "beta" });
    const clash = await writePlugin("managed", "alpha-again", { id: "alpha" });

    const results = await loadPlugins([join(workspace, "builtin"), { directory: managed }, { directory: clash }]);

    expect(byStatus(results, "loaded")).toEqual(["alpha", "beta"]);
    expect(results.find((result) => result.directory === clash)?.status).toBe("unavailable");
  });

  it("givenEntryThatThrowsOnImport_whenLoaded_thenOtherPluginsStillLoad", async () => {
    await writePlugin("builtin", "broken", { id: "broken", source: 'throw new Error("boom");\n' });
    await writePlugin("builtin", "working", { id: "working" });

    const results = await loadPlugins([join(workspace, "builtin")]);

    expect(byStatus(results, "loaded")).toEqual(["working"]);
    const broken = results.find((result) => result.manifest?.id === "broken");
    expect(broken?.status === "unavailable" && broken.reason).toContain("boom");
  });

  it("givenSqlPluginWithoutLanguage_whenLoaded_thenUnavailable", async () => {
    const source = pluginSource("mute").replace(/ {2}language: \{[\s\S]*?\n {2}\},\n/, "");
    await writePlugin("builtin", "mute", { id: "mute", source });

    const [result] = await loadPlugins([join(workspace, "builtin")]);

    expect(result?.status === "unavailable" && result.reason).toContain("language");
  });

  it("givenCommandsPluginWithoutCommandLanguage_whenLoaded_thenUnavailable", async () => {
    const source = pluginSource("mute").replace('capabilities: ["sql"]', 'capabilities: ["commands"]');
    await writePlugin("builtin", "mute", { id: "mute", source, capabilities: ["commands"] });

    const [result] = await loadPlugins([join(workspace, "builtin")]);

    expect(result?.status === "unavailable" && result.reason).toContain("commandLanguage");
  });

  it("givenCommandsPluginWithCommandLanguage_whenLoaded_thenLoaded", async () => {
    const source = pluginSource("kv")
      .replace('capabilities: ["sql"]', 'capabilities: ["commands"]')
      .replace("  language: {", "  commandLanguage: {\n    complete: async () => ({ from: 0, to: 0, items: [] }),");
    await writePlugin("builtin", "kv", { id: "kv", source, capabilities: ["commands"] });

    const [result] = await loadPlugins([join(workspace, "builtin")]);

    expect(result?.status).toBe("loaded");
  });

  it("givenDirectoryWithoutManifest_whenLoaded_thenUnavailableWithReason", async () => {
    await mkdir(join(workspace, "builtin", "stray"), { recursive: true });

    const [result] = await loadPlugins([join(workspace, "builtin")]);

    expect(result?.status === "unavailable" && result.reason).toContain(MANIFEST_FILE);
  });

  it("givenMissingRoot_whenLoaded_thenReturnsNothing", async () => {
    expect(await loadPlugins([join(workspace, "does-not-exist")])).toEqual([]);
  });

  it("givenEntryOutsidePluginDirectory_whenLoaded_thenUnavailable", async () => {
    const directory = await writePlugin("builtin", "escape", { id: "escape" });
    const manifest = { id: "escape", name: "escape", version: "1.0.0", apiVersion: API_VERSION };
    await writeFile(
      join(directory, MANIFEST_FILE),
      JSON.stringify({
        ...manifest,
        entry: "../index.mjs",
        capabilities: ["sql"],
        highlight: "sql",
        connection: CONNECTION,
      }),
    );

    const [result] = await loadPlugins([join(workspace, "builtin")]);

    expect(result?.status === "unavailable" && result.reason).toContain("outside");
  });
});

/** Set by a plugin's top-level code, so a test can tell whether its entry was ever imported. */
const IMPORTED_MARKER = "__tableCraftLoaderTestImported";

function markingSource(id: string): string {
  return `globalThis[${JSON.stringify(IMPORTED_MARKER)}] = ${JSON.stringify(id)};\n${pluginSource(id)}`;
}

function importedMarker(): unknown {
  return (globalThis as Record<string, unknown>)[IMPORTED_MARKER];
}

describe("loadPluginById", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, IMPORTED_MARKER);
  });

  it("givenSeveralPlugins_whenLoadedById_thenOnlyThatEntryIsImported", async () => {
    await writePlugin("builtin", "alpha", { id: "alpha" });
    await writePlugin("builtin", "beta", { id: "beta", source: markingSource("beta") });

    const results = await loadPluginById([join(workspace, "builtin")], "alpha");

    expect(results.map((result) => [result.manifest?.id, result.status])).toEqual([["alpha", "loaded"]]);
    expect(importedMarker()).toBeUndefined();
    await loadPluginById([join(workspace, "builtin")], "beta");
    expect(importedMarker()).toBe("beta");
  });

  it("givenOtherPluginThrowsOnImport_whenLoadedById_thenOwnPluginLoads", async () => {
    await writePlugin("builtin", "broken", { id: "broken", source: 'throw new Error("boom");\n' });
    await writePlugin("builtin", "working", { id: "working" });

    const results = await loadPluginById([join(workspace, "builtin")], "working");

    expect(results.map((result) => [result.manifest?.id, result.status])).toEqual([["working", "loaded"]]);
  });

  it("givenOwnPluginThrowsOnImport_whenLoadedById_thenUnavailableWithReason", async () => {
    await writePlugin("builtin", "broken", { id: "broken", source: 'throw new Error("boom");\n' });

    const [result, ...rest] = await loadPluginById([join(workspace, "builtin")], "broken");

    expect(rest).toEqual([]);
    expect(result).toMatchObject({ status: "unavailable", manifest: { id: "broken" } });
    expect(result?.status === "unavailable" && result.reason).toContain("boom");
  });

  it("givenIncompatibleOwnPlugin_whenLoadedById_thenUnavailableWithoutImport", async () => {
    await writePlugin("builtin", "newer", {
      id: "newer",
      apiVersion: NEXT_MAJOR_API_VERSION,
      source: markingSource("newer"),
    });

    const [result, ...rest] = await loadPluginById([join(workspace, "builtin")], "newer");

    expect(rest).toEqual([]);
    expect(result?.status === "unavailable" && result.reason).toContain(
      `needs TableCraft with plugin API ${major + 1}.0 or later`,
    );
    expect(importedMarker()).toBeUndefined();
  });

  it("givenSameIdInTwoRoots_whenLoadedById_thenEarlierRootLoadsAndLaterIsDuplicate", async () => {
    const first = await writePlugin("builtin", "alpha", { id: "alpha" });
    const second = await writePlugin("user", "alpha-copy", { id: "alpha", source: markingSource("alpha") });

    const results = await loadPluginById([join(workspace, "builtin"), join(workspace, "user")], "alpha");

    expect(results.map((result) => [result.directory, result.status])).toEqual([
      [first, "loaded"],
      [second, "unavailable"],
    ]);
    const duplicate = results[1];
    expect(duplicate?.status === "unavailable" && duplicate.reason).toContain("Duplicate plugin id");
    expect(importedMarker()).toBeUndefined();
  });

  it("givenUnknownId_whenLoadedById_thenEmpty", async () => {
    await writePlugin("builtin", "alpha", { id: "alpha", source: markingSource("alpha") });
    await mkdir(join(workspace, "builtin", "stray"), { recursive: true });

    expect(await loadPluginById([join(workspace, "builtin")], "missing")).toEqual([]);
    expect(importedMarker()).toBeUndefined();
  });
});
