import { describe, expect, it } from "vitest";
import type { ImportSource, PluginInfo } from "@table-craft/desktop/preload/bridge.js";
import { ALL_ACTIONS } from "@table-craft/desktop/renderer/actions/allActions.js";
import {
  IMPORT_ACTION_ID,
  NOTICES_STORAGE_KEY,
  RELEASE_NOTES_ACTION_ID,
  SETTINGS_ACTION_ID,
  deriveNotices,
  firstMemory,
  loadNoticeMemory,
  markRead,
  reconcileMemory,
  settleNotice,
  unreadIds,
  type FeatureNotice,
  type NoticeInput,
  type NoticeMemory,
} from "@table-craft/desktop/renderer/model/notices.js";
import { FEATURE_NOTICES } from "@table-craft/desktop/renderer/notices/features.js";
import { createNoticesStore } from "@table-craft/desktop/renderer/state/notices.js";
import { memoryStorage } from "@table-craft/desktop/renderer/state/layout.js";
import { POSTGRES_PLUGIN, view } from "./datasourceViews.js";

const DATAGRIP: ImportSource = {
  app: "datagrip",
  label: "DataGrip",
  found: true,
  count: 12,
  locations: ["/home/me/.config/JetBrains"],
  passwords: "macOS Keychain",
};
const MANAGED_POSTGRES: PluginInfo = { ...POSTGRES_PLUGIN, source: "managed", version: "1.4.0" };
const FEATURE: FeatureNotice = { id: "watch", title: "Watch keys", body: "Follow keys as they change." };

function input(overrides: Partial<NoticeInput> = {}): NoticeInput {
  return { appVersion: "1.9.0", importSources: [], datasources: [], plugins: [], features: [], ...overrides };
}

function memory(overrides: Partial<NoticeMemory> = {}): NoticeMemory {
  return { version: "1.9.0", features: [], plugins: {}, dismissed: [], read: [], ...overrides };
}

function ids(given: NoticeInput, remembered: NoticeMemory): readonly string[] {
  return deriveNotices(given, remembered).map((notice) => notice.id);
}

describe("notice model", () => {
  it("givenNoMemory_whenDerive_thenOnlyImportNoticesAndMemoryFilled", () => {
    const given = input({
      importSources: [DATAGRIP],
      plugins: [MANAGED_POSTGRES],
      features: [FEATURE],
    });

    const first = firstMemory(given);

    expect(first).toEqual({
      version: "1.9.0",
      features: ["watch"],
      plugins: { postgres: "1.4.0" },
      dismissed: [],
      read: [],
    });
    expect(ids(given, first)).toEqual(["import:datagrip"]);
  });

  it("givenStoredOlderVersion_whenDerive_thenUpdateNotice", () => {
    const [notice] = deriveNotices(input(), memory({ version: "1.8.0" }));

    expect(notice).toMatchObject({
      id: "update:1.9.0",
      title: "Updated to TableCraft 1.9.0",
      action: { actionId: RELEASE_NOTES_ACTION_ID, args: { version: "1.9.0" } },
    });
  });

  it("givenDevelopmentVersion_whenDerive_thenNoUpdateNotice", () => {
    const given = input({ appVersion: "0.0.0" });
    const remembered = memory({ version: "1.8.0" });

    expect(ids(given, remembered)).toEqual([]);
    expect(reconcileMemory(given, remembered)).toBe(remembered);
    expect(firstMemory(given).version).toBeNull();
  });

  it("givenNewerStoredVersion_whenReconcile_thenRecordedWithoutNotice", () => {
    const reconciled = reconcileMemory(input({ appVersion: "1.7.0" }), memory({ version: "1.9.0" }));

    expect(reconciled.version).toBe("1.7.0");
    expect(ids(input({ appVersion: "1.7.0" }), reconciled)).toEqual([]);
  });

  it("givenSourceFoundAndNoOrigin_whenDerive_thenImportNotice", () => {
    const [notice] = deriveNotices(input({ importSources: [DATAGRIP] }), memory());

    expect(notice).toMatchObject({
      id: "import:datagrip",
      title: "12 connections found in DataGrip",
      action: { label: "Import…", actionId: IMPORT_ACTION_ID, args: { app: "datagrip" } },
      sticky: true,
    });
  });

  it("givenDatasourceWithOrigin_whenDerive_thenImportResolved", () => {
    const imported = view({ id: "a", name: "orders", origin: { app: "datagrip", id: "uuid-1" } });

    expect(ids(input({ importSources: [DATAGRIP], datasources: [imported] }), memory())).toEqual([]);
  });

  it("givenSourceNotFoundOrEmpty_whenDerive_thenNoImportNotice", () => {
    const sources = [
      { ...DATAGRIP, found: false, count: 0 },
      { ...DATAGRIP, app: "tablepro" as const, label: "TablePro", count: 0 },
    ];

    expect(ids(input({ importSources: sources }), memory())).toEqual([]);
  });

  it("givenImportDismissed_whenScanAgain_thenStaysHidden", () => {
    const given = input({ importSources: [DATAGRIP] });
    const [notice] = deriveNotices(given, memory());
    if (notice === undefined) throw new Error("expected the import notice");

    const settled = settleNotice(memory(), notice, given);

    expect(ids(given, settled)).toEqual([]);
    expect(ids(input({ importSources: [{ ...DATAGRIP, count: 13 }] }), settled)).toEqual([]);
  });

  it("givenScanFailed_whenDerive_thenNoImportNotices", () => {
    expect(ids(input({ importSources: null }), memory())).toEqual([]);
  });

  it("givenUnseenCatalogEntry_whenDerive_thenFeatureNotice", () => {
    expect(ids(input({ features: [FEATURE] }), memory())).toEqual(["feature:watch"]);
  });

  it("givenPluginNewerThanMemory_whenDerive_thenPluginNotice", () => {
    const [notice] = deriveNotices(input({ plugins: [MANAGED_POSTGRES] }), memory({ plugins: { postgres: "1.3.2" } }));

    expect(notice).toMatchObject({
      id: "plugin:postgres:1.4.0",
      title: "PostgreSQL plugin updated to 1.4.0",
      action: { actionId: SETTINGS_ACTION_ID, args: { page: "plugins" } },
    });
  });

  it("givenBuiltInPluginNewer_whenDerive_thenNoPluginNotice", () => {
    const builtIn = { ...MANAGED_POSTGRES, source: "builtIn" as const };

    expect(ids(input({ plugins: [builtIn] }), memory({ plugins: { postgres: "1.3.2" } }))).toEqual([]);
  });

  it("givenPluginNewlyInstalled_whenReconcile_thenRecordedSilently", () => {
    const given = input({ plugins: [MANAGED_POSTGRES] });

    const reconciled = reconcileMemory(given, memory());

    expect(reconciled.plugins).toEqual({ postgres: "1.4.0" });
    expect(ids(given, reconciled)).toEqual([]);
  });

  it("givenFeatureActionRan_whenDerive_thenGone", () => {
    const given = input({ features: [FEATURE], plugins: [MANAGED_POSTGRES] });
    let remembered = memory({ version: "1.8.0", plugins: { postgres: "1.0.0" } });
    for (const notice of deriveNotices(given, remembered)) remembered = settleNotice(remembered, notice, given);

    expect(ids(given, remembered)).toEqual([]);
    expect(remembered).toMatchObject({ version: "1.9.0", features: ["watch"], plugins: { postgres: "1.4.0" } });
  });

  it("givenSeveralKinds_whenDerive_thenUpdateImportPluginFeature", () => {
    const given = input({ importSources: [DATAGRIP], plugins: [MANAGED_POSTGRES], features: [FEATURE] });

    expect(ids(given, memory({ version: "1.8.0", plugins: { postgres: "1.0.0" } }))).toEqual([
      "update:1.9.0",
      "import:datagrip",
      "plugin:postgres:1.4.0",
      "feature:watch",
    ]);
  });

  it("givenOpened_whenMarkRead_thenUnreadZero", () => {
    const given = input({ features: [FEATURE] });
    const notices = deriveNotices(given, memory());

    expect(unreadIds(notices, memory())).toEqual(["feature:watch"]);
    expect(unreadIds(notices, markRead(memory(), notices))).toEqual([]);
  });

  it("givenCorruptStorage_whenLoad_thenNull", () => {
    const storage = memoryStorage();
    expect(loadNoticeMemory(storage)).toBeNull();
    storage.setItem(NOTICES_STORAGE_KEY, "{not json");
    expect(loadNoticeMemory(storage)).toBeNull();
    storage.setItem(NOTICES_STORAGE_KEY, JSON.stringify({ version: 3, features: [] }));
    expect(loadNoticeMemory(storage)).toBeNull();
    storage.setItem(NOTICES_STORAGE_KEY, JSON.stringify(memory()));
    expect(loadNoticeMemory(storage)).toEqual(memory());
  });

  it("givenCatalog_whenActionsRegistered_thenEveryNoticeActionExists", () => {
    const registered = new Set(ALL_ACTIONS.map((action) => action.id));
    const actionIds = [
      IMPORT_ACTION_ID,
      RELEASE_NOTES_ACTION_ID,
      SETTINGS_ACTION_ID,
      ...FEATURE_NOTICES.flatMap((feature) => (feature.action === undefined ? [] : [feature.action.actionId])),
    ];

    expect(actionIds.filter((id) => !registered.has(id))).toEqual([]);
  });
});

describe("notices store", () => {
  it("givenCorruptStorage_whenRefresh_thenFirstMemory", () => {
    const storage = memoryStorage();
    storage.setItem(NOTICES_STORAGE_KEY, "[]");
    const store = createNoticesStore(storage);

    store.getState().refresh(input({ features: [FEATURE] }));

    expect(store.getState().notices).toEqual([]);
    expect(loadNoticeMemory(storage)).toMatchObject({ version: "1.9.0", features: ["watch"] });
  });

  it("givenNewUnreadId_whenRefresh_thenArrivalRaised", () => {
    const storage = memoryStorage();
    storage.setItem(NOTICES_STORAGE_KEY, JSON.stringify(memory()));
    const store = createNoticesStore(storage);

    store.getState().refresh(input());
    expect(store.getState().arrival).toBe(0);
    store.getState().refresh(input({ importSources: [DATAGRIP] }));

    expect(store.getState().arrival).toBe(1);
    expect(store.getState().unread).toEqual(["import:datagrip"]);
  });

  it("givenSameUnreadIds_whenRefresh_thenArrivalUnchanged", () => {
    const storage = memoryStorage();
    storage.setItem(NOTICES_STORAGE_KEY, JSON.stringify(memory()));
    const store = createNoticesStore(storage);
    const given = input({ importSources: [DATAGRIP] });

    store.getState().refresh(given);
    store.getState().refresh(given);

    expect(store.getState().arrival).toBe(1);
  });

  it("givenOpen_whenNoticeArrives_thenReadAtOnce", () => {
    const storage = memoryStorage();
    storage.setItem(NOTICES_STORAGE_KEY, JSON.stringify(memory()));
    const store = createNoticesStore(storage);
    store.getState().refresh(input());

    store.getState().setOpen(true);
    store.getState().refresh(input({ importSources: [DATAGRIP] }));

    expect(store.getState().unread).toEqual([]);
    expect(store.getState().arrival).toBe(0);
  });

  it("givenImportActionRan_whenDerive_thenStillListed", () => {
    const storage = memoryStorage();
    storage.setItem(NOTICES_STORAGE_KEY, JSON.stringify(memory({ version: "1.8.0" })));
    const store = createNoticesStore(storage);
    store.getState().refresh(input({ importSources: [DATAGRIP] }));

    store.getState().ran("import:datagrip");
    store.getState().ran("update:1.9.0");

    expect(store.getState().notices.map((notice) => notice.id)).toEqual(["import:datagrip"]);
  });

  it("givenNotices_whenDismissAll_thenEmptyAndRemembered", () => {
    const storage = memoryStorage();
    storage.setItem(NOTICES_STORAGE_KEY, JSON.stringify(memory({ version: "1.8.0" })));
    const store = createNoticesStore(storage);
    const given = input({ importSources: [DATAGRIP], features: [FEATURE] });
    store.getState().refresh(given);

    store.getState().dismissAll();

    expect(store.getState().notices).toEqual([]);
    const relaunched = createNoticesStore(storage);
    relaunched.getState().refresh(given);
    expect(relaunched.getState().notices).toEqual([]);
  });
});
