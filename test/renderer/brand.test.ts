import { describe, expect, it } from "vitest";
import type { PluginInfo } from "@table-craft/desktop/preload/bridge.js";
import type { ActionContext } from "@table-craft/desktop/renderer/actions/context.js";
import { SETTINGS_ACTION_IDS, SETTINGS_ACTIONS } from "@table-craft/desktop/renderer/actions/settingsActions.js";
import { datasourceBrand } from "@table-craft/desktop/renderer/model/brand.js";
import { newDraft, toSaveRequest } from "@table-craft/desktop/renderer/model/datasourceForm.js";
import { entryName, pickerEntries } from "@table-craft/desktop/renderer/model/pluginCatalog.js";
import { useSettings } from "@table-craft/desktop/renderer/state/settings.js";
import { MYSQL_MANIFEST } from "../support/manifests.js";
import { SQLITE_PLUGIN } from "./datasourceViews.js";

const MYSQL_BRANDS = MYSQL_MANIFEST.brands ?? [];
const [MYSQL, MARIADB, TIDB] = MYSQL_BRANDS;
const MYSQL_PLUGIN: PluginInfo = { ...SQLITE_PLUGIN, id: "mysql", name: "MySQL", brands: MYSQL_BRANDS };

describe("datasource brand", () => {
  it("givenLiveBrand_whenResolved_thenWinsOverStored", () => {
    expect(datasourceBrand({ connectionBrand: "tidb", storedBrand: "mariadb", brands: MYSQL_BRANDS })).toEqual(TIDB);
  });

  it("givenStoredBrand_whenNotConnected_thenStored", () => {
    expect(datasourceBrand({ connectionBrand: null, storedBrand: "mariadb", brands: MYSQL_BRANDS })).toEqual(MARIADB);
  });

  it("givenNothingStored_whenResolved_thenPluginDefault", () => {
    expect(datasourceBrand({ connectionBrand: null, storedBrand: undefined, brands: MYSQL_BRANDS })).toEqual(MYSQL);
  });

  it("givenStaleStoredBrand_whenResolved_thenPluginDefault", () => {
    expect(datasourceBrand({ connectionBrand: "oracle", storedBrand: "gone", brands: MYSQL_BRANDS })).toEqual(MYSQL);
  });

  it("givenNoBrands_whenResolved_thenNull", () => {
    expect(datasourceBrand({ connectionBrand: "tidb", storedBrand: "tidb", brands: [] })).toBeNull();
    expect(datasourceBrand({ connectionBrand: "tidb", storedBrand: "tidb", brands: undefined })).toBeNull();
  });

  it("givenMysqlPlugin_whenPickerEntries_thenMysqlMariadbTidbRows", () => {
    const entries = pickerEntries([SQLITE_PLUGIN, MYSQL_PLUGIN], []);

    expect(entries.map(entryName)).toEqual(["MariaDB", "MySQL", "SQLite", "TiDB"]);
    expect(entries.map((item) => (item.kind === "plugin" ? item.plugin.id : null))).toEqual([
      "mysql",
      "mysql",
      "sqlite",
      "mysql",
    ]);
  });

  it("givenPluginWithoutBrands_whenPickerEntries_thenOneRowByPluginName", () => {
    const entries = pickerEntries([{ ...MYSQL_PLUGIN, brands: [] }], []);

    expect(entries).toEqual([{ kind: "plugin", plugin: { ...MYSQL_PLUGIN, brands: [] }, brand: null }]);
    expect(entries.map(entryName)).toEqual(["MySQL"]);
  });

  it("givenTidbPicked_whenNewDraft_thenNamedAfterItAndSavedWithBrand", () => {
    const first = newDraft("new-0", MYSQL_PLUGIN, [], "forever", "", TIDB ?? null);
    const second = newDraft("new-1", MYSQL_PLUGIN, ["TiDB"], "forever", "", TIDB ?? null);

    expect(first.name).toBe("TiDB");
    expect(second.name).toBe("TiDB (2)");
    expect(toSaveRequest(first, MYSQL_PLUGIN).datasource.brand).toBe("tidb");
    expect(toSaveRequest(newDraft("new-2", MYSQL_PLUGIN, [], "forever"), MYSQL_PLUGIN).datasource).not.toHaveProperty(
      "brand",
    );
  });

  it("givenToggleBrandIcons_whenInvoked_thenSettingFlips", () => {
    const before = useSettings.getState().settings;

    try {
      void SETTINGS_ACTIONS.find((action) => action.id === SETTINGS_ACTION_IDS.toggleBrandIcons)?.run(
        {} as ActionContext,
        undefined as never,
      );

      expect(useSettings.getState().settings.appearance.brandIcons).toBe(!before.appearance.brandIcons);
    } finally {
      useSettings.setState({ settings: before });
    }
  });
});
