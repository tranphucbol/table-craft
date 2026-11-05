import { describe, expect, it } from "vitest";
import type { CatalogPlugin, PluginInstallState } from "@table-craft/desktop/preload/bridge.js";
import {
  downloadLabel,
  installText,
  missingPlugin,
  missingText,
  needsNewerApp,
  pickerEntries,
  pluginVersionText,
  unavailableText,
} from "@table-craft/desktop/renderer/model/pluginCatalog.js";
import { createDatasourcesStore } from "@table-craft/desktop/renderer/state/datasources.js";
import { POSTGRES_PLUGIN, SQLITE_PLUGIN } from "./datasourceViews.js";

const OUTDATED_POSTGRES = {
  ...POSTGRES_PLUGIN,
  needs: "pluginUpdate",
  unavailableReason: "Built for an older TableCraft. Updating…",
} as const;
const NEWER_POSTGRES = {
  ...POSTGRES_PLUGIN,
  needs: "appUpdate",
  unavailableReason: "Built for plugin API 3.0.0: needs TableCraft with plugin API 3.0 or later.",
} as const;

const MYSQL_PLUGIN = { ...SQLITE_PLUGIN, id: "mysql", name: "MySQL", brands: [{ id: "mysql", name: "MySQL" }] };

function entry(install: PluginInstallState = { status: "idle" }): CatalogPlugin {
  return {
    id: "postgres",
    name: "PostgreSQL",
    packageName: "@tablecraft-app/plugin-postgres",
    schemes: ["postgresql", "postgres"],
    brands: [{ id: "postgresql", name: "PostgreSQL" }],
    approximateBytes: 800_000,
    installedVersion: null,
    install,
  };
}

describe("plugin catalog", () => {
  it("givenPostgresNotInstalled_whenPicked_thenDownloadEntrySortedAmongInstalled", () => {
    const entries = pickerEntries([SQLITE_PLUGIN, MYSQL_PLUGIN], [entry()]);

    expect(entries.map((item) => (item.kind === "plugin" ? item.plugin.name : `↓ ${item.entry.name}`))).toEqual([
      "MySQL",
      "↓ PostgreSQL",
      "SQLite",
    ]);
  });

  it("givenPostgresInstalled_whenPicked_thenNoDownloadEntry", () => {
    const entries = pickerEntries([SQLITE_PLUGIN, POSTGRES_PLUGIN], [entry()]);

    expect(entries.every((item) => item.kind === "plugin")).toBe(true);
  });

  it("givenDatasourceOnMissingCatalogPlugin_whenAsked_thenTheEntry", () => {
    expect(missingPlugin([entry()], [SQLITE_PLUGIN], "postgres")?.name).toBe("PostgreSQL");
    expect(missingPlugin([entry()], [POSTGRES_PLUGIN], "postgres")).toBeUndefined();
    expect(missingPlugin([entry()], [SQLITE_PLUGIN], "mongodb")).toBeUndefined();
  });

  it("givenPluginNeedingUpdate_whenMissingPlugin_thenCatalogEntry", () => {
    expect(missingPlugin([entry()], [OUTDATED_POSTGRES], "postgres")?.name).toBe("PostgreSQL");
    expect(missingPlugin([entry()], [OUTDATED_POSTGRES, POSTGRES_PLUGIN], "postgres")).toBeUndefined();
  });

  it("givenPluginNeedingApp_whenMissingPlugin_thenUndefined", () => {
    expect(missingPlugin([entry()], [NEWER_POSTGRES], "postgres")).toBeUndefined();
    expect(needsNewerApp([NEWER_POSTGRES], "postgres")).toBe(true);
    expect(needsNewerApp([OUTDATED_POSTGRES], "postgres")).toBe(false);
    expect(unavailableText(NEWER_POSTGRES)).toBe("Needs a newer TableCraft.");
    expect(unavailableText(OUTDATED_POSTGRES)).toBe("Built for an older TableCraft. Updating…");
  });

  it("givenOutdatedPluginInEachInstallState_whenShown_thenWordedAsAnUpdate", () => {
    expect(missingText(entry(), true).text).toBe("Update needed");
    expect(missingText(entry({ status: "installing", received: 400, total: 1000 }), true)).toEqual({
      text: "Updating… 40%",
      title: "Updating PostgreSQL… 40%",
    });
    expect(missingText(entry({ status: "failed", message: "No connection.", hint: "Retry." }), true)).toEqual({
      text: "Update failed",
      title: "No connection. Retry.",
    });
  });

  it("givenEachInstallState_whenDescribed_thenProgressOrFailure", () => {
    expect(installText(entry())).toBeNull();
    expect(installText(entry({ status: "installing", received: 0, total: null }))).toBe("Installing PostgreSQL…");
    expect(installText(entry({ status: "installing", received: 400, total: 1000 }))).toBe("Installing PostgreSQL… 40%");
    expect(installText(entry({ status: "failed", message: "No connection.", hint: "Retry." }))).toBe("No connection.");
  });

  it("givenEachInstallState_whenShownInTheDatabasePane_thenShortTextAndTheWholeStoryAsTooltip", () => {
    expect(missingText(entry())).toEqual({
      text: "Plugin missing",
      title: "The PostgreSQL plugin is not installed. Install downloads it; Settings → Plugins manages plugins.",
    });
    expect(missingText(entry({ status: "installing", received: 400, total: 1000 }))).toEqual({
      text: "Installing… 40%",
      title: "Installing PostgreSQL… 40%",
    });
    expect(missingText(entry({ status: "failed", message: "No connection.", hint: "Retry." }))).toEqual({
      text: "Install failed",
      title: "No connection. Retry.",
    });
  });

  it("givenApproximateSize_whenLabelled_thenAboutThatMuch", () => {
    expect(downloadLabel(entry())).toBe("Download (about 781.3 KB)");
  });

  it("givenDownloadedPlugin_whenLabelled_thenVersionAndSource", () => {
    expect(pluginVersionText(POSTGRES_PLUGIN)).toBe("PostgreSQL 1.0.0 · Downloaded");
    expect(pluginVersionText(SQLITE_PLUGIN)).toBe("SQLite 1.0.0 · Built in");
  });

  it("givenPluginsState_whenApplied_thenPluginsAndCatalogTogether", () => {
    const store = createDatasourcesStore({
      connectEngine: () => Promise.reject(new Error("unused")),
      authorizeEngine: () => Promise.resolve({ status: "authorized" }),
      disconnectEngine: () => Promise.resolve(),
      promptSecrets: () => Promise.resolve(null),
      rememberServer: () => Promise.resolve(),
    });

    store.getState().applyPlugins({
      plugins: [SQLITE_PLUGIN],
      catalog: [entry()],
      registries: [],
      registryRemoved: [],
      packageInstalls: [],
    });

    expect(store.getState().plugins).toEqual([SQLITE_PLUGIN]);
    expect(store.getState().catalog.map((item) => item.id)).toEqual(["postgres"]);
  });
});
