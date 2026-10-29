import { describe, expect, it } from "vitest";
import {
  createSettingsService,
  createSettingsStore,
  SETTINGS_FILE,
  settingsSchema,
} from "@table-craft/desktop/main/settings.js";
import type { ThemeFolder } from "@table-craft/desktop/main/themes.js";
import type { SettingsChanged } from "@table-craft/desktop/preload/bridge.js";
import {
  DEFAULT_SETTINGS,
  readSettings,
  withInspection,
  type Settings,
} from "@table-craft/desktop/settings/settings.js";
import { memoryFiles } from "../support/memoryFiles.js";

const DIRECTORY = "/profile";
const PATH = `${DIRECTORY}/${SETTINGS_FILE}`;
const NOW = 1_700_000_000_000;

const CHOSEN: Settings = {
  version: 1,
  appearance: {
    theme: "light",
    density: "compact",
    fonts: {
      ui: { family: null, sizePx: 14 },
      editor: { family: "Fira Code", sizePx: 15 },
      grid: { family: "Menlo", sizePx: 11 },
    },
    motion: "reduced",
    systemTitleBar: true,
  },
  editor: {
    format: { style: "standard", keywordCase: "lower", indentWidth: 4, linesBetweenStatements: 0, alignAliases: false },
    inspections: { enabled: false, disabled: ["SqlRedundantAlias", "AcmeOwnCheck"] },
  },
  console: { parameters: false, statementTimeoutSeconds: 45, sessionsRefreshSeconds: 30, runAllOnError: "continue" },
  data: {
    nullText: "∅",
    groupDigits: true,
    pageRows: 100,
    fetchAllCap: 2_000,
    exportStallSeconds: 300,
    aggregates: ["sum", "avg"],
    blobLimitMb: 64,
  },
  log: { level: "debug" },
  updates: { checkAutomatically: false },
  plugins: { registryUrl: "http://127.0.0.1:4873" },
  mcp: { enabled: true, port: 48_000, rowCap: 250, clients: [{ name: "Claude Code", allowed: true }] },
};

function store(files = memoryFiles()) {
  return { files, store: createSettingsStore({ directory: DIRECTORY, files, now: () => NOW }) };
}

const NO_THEMES: ThemeFolder = { path: `${DIRECTORY}/themes`, list: () => Promise.resolve([]) };

describe("settings store", () => {
  it("givenNoFile_whenLoaded_thenDefaultsWithoutWarning", async () => {
    expect(await store().store.load()).toEqual({ settings: DEFAULT_SETTINGS, warning: null });
  });

  it("givenSettingsFileV1_whenSavedAndLoaded_thenRoundTrips", async () => {
    const { files, store: first } = store();
    await first.save(CHOSEN);

    const reloaded = await createSettingsStore({ directory: DIRECTORY, files }).load();

    expect(JSON.parse(files.contents.get(PATH) ?? "")).toMatchObject({ version: 1 });
    expect(reloaded).toEqual({ settings: CHOSEN, warning: null });
  });

  it("givenCorruptFile_whenLoaded_thenSetAsideWithWarningAndDefaults", async () => {
    const { files, store: corrupt } = store(memoryFiles({ [PATH]: "{ not json" }));

    const loaded = await corrupt.load();

    const backup = `${PATH}.corrupt-${String(NOW)}`;
    expect(loaded.settings).toEqual(DEFAULT_SETTINGS);
    expect(loaded.warning).toContain(backup);
    expect(files.contents.get(backup)).toBe("{ not json");
    expect(files.contents.has(PATH)).toBe(false);
  });

  it("givenFileFromNewerVersion_whenLoaded_thenSetAsideRatherThanMisread", async () => {
    const newer = JSON.stringify({ ...CHOSEN, version: 2 });
    const { files, store: newerStore } = store(memoryFiles({ [PATH]: newer }));

    const loaded = await newerStore.load();

    expect(loaded.settings).toEqual(DEFAULT_SETTINGS);
    expect(loaded.warning).toContain("version");
    expect(files.contents.get(`${PATH}.corrupt-${String(NOW)}`)).toBe(newer);
  });

  it("givenUnknownLogLevel_whenLoaded_thenInfo", async () => {
    const file = { ...CHOSEN, log: { level: "trace" } };
    const { store: loading } = store(memoryFiles({ [PATH]: JSON.stringify(file) }));

    expect((await loading.load()).settings.log).toEqual({ level: "info" });
  });

  it("givenOneOutOfRangeField_whenLoaded_thenOnlyThatFieldFallsBack", async () => {
    const file = { ...CHOSEN, data: { ...CHOSEN.data, pageRows: 5 } };
    const { files, store: loading } = store(memoryFiles({ [PATH]: JSON.stringify(file) }));

    const loaded = await loading.load();

    expect(loaded.warning).toBeNull();
    expect(loaded.settings).toEqual({ ...CHOSEN, data: { ...CHOSEN.data, pageRows: DEFAULT_SETTINGS.data.pageRows } });
    expect(files.contents.has(PATH)).toBe(true);
  });

  it("givenSaveWrite_whenProcessDiesMidWrite_thenPreviousFileIntact", async () => {
    const { files, store: saving } = store();
    await saving.save(CHOSEN);
    const before = files.contents.get(PATH);
    files.dieDuringNextWrite();

    await expect(saving.save(DEFAULT_SETTINGS)).rejects.toThrow("killed mid-write");

    expect(files.contents.get(PATH)).toBe(before);
    expect((await saving.load()).settings).toEqual(CHOSEN);
  });
});

describe("settings document", () => {
  it("givenFieldsOfWrongTypeOrRange_whenRead_thenEachFallsBackAlone", () => {
    const read = readSettings({
      version: 1,
      appearance: { theme: "neon", density: "compact", fonts: { editor: { family: "a;b", sizePx: 99 } } },
      data: {
        nullText: "",
        groupDigits: "yes",
        pageRows: 200,
        fetchAllCap: 100,
        exportStallSeconds: 5,
        aggregates: ["max", "median", "count"],
        blobLimitMb: 0,
      },
    });

    expect(read.appearance.theme).toBe("system");
    expect(read.appearance.density).toBe("compact");
    expect(read.appearance.fonts.editor).toEqual({ family: null, sizePx: 13 });
    expect(read.data).toEqual({
      nullText: "<null>",
      groupDigits: false,
      pageRows: 200,
      fetchAllCap: 100_000,
      exportStallSeconds: 120,
      aggregates: ["count", "max"],
      blobLimitMb: 16,
    });
  });

  it("givenSettingsWithGruvboxDark_whenRead_thenThemeIsKept", () => {
    expect(readSettings({ version: 1, appearance: { theme: "gruvbox-dark" } }).appearance.theme).toBe("gruvbox-dark");
  });

  it("givenSettingsWithUnknownThemeId_whenRead_thenSystemIsUsed", () => {
    expect(readSettings({ version: 1, appearance: { theme: "gruvbox-sepia" } }).appearance.theme).toBe("system");
  });

  it("givenFormatStyleUnknownOrAlignAliasesNotBoolean_whenRead_thenEachFallsBackAlone", () => {
    const read = readSettings({
      ...CHOSEN,
      editor: { format: { ...CHOSEN.editor.format, style: "tabular", alignAliases: "yes" } },
    });

    expect(read.editor.format).toEqual({ ...CHOSEN.editor.format, style: "aligned", alignAliases: true });
    expect(readSettings({ ...CHOSEN, editor: {} }).editor.format).toEqual(DEFAULT_SETTINGS.editor.format);
  });

  it("givenInspectionsMissingOrMalformed_whenRead_thenOnByDefaultAndOnlyIdsKept", () => {
    const read = (inspections: unknown) => readSettings({ ...CHOSEN, editor: { inspections } }).editor.inspections;

    expect(readSettings({ ...CHOSEN, editor: {} }).editor.inspections).toEqual({ enabled: true, disabled: [] });
    expect(read({ enabled: "no", disabled: "SqlResolve" })).toEqual({ enabled: true, disabled: [] });
    expect(
      read({ enabled: false, disabled: ["SqlResolve", 7, "", "not an id", "SqlResolve", "AcmeOwnCheck"] }),
    ).toEqual({ enabled: false, disabled: ["SqlResolve", "AcmeOwnCheck"] });
  });

  it("givenInspectionToggled_whenWritten_thenListedOnceOrRemovedAndAcceptedByTheWriteSchema", () => {
    const off = withInspection(DEFAULT_SETTINGS, "SqlRedundantAlias", false);
    const twice = withInspection(off, "SqlRedundantAlias", false);

    expect(twice.editor.inspections).toEqual({ enabled: true, disabled: ["SqlRedundantAlias"] });
    expect(withInspection(twice, "SqlRedundantAlias", true).editor.inspections.disabled).toEqual([]);
    expect(settingsSchema.safeParse(twice).success).toBe(true);
    expect(
      settingsSchema.safeParse({
        ...twice,
        editor: { ...twice.editor, inspections: { enabled: true, disabled: ["SqlResolve", "SqlResolve"] } },
      }).success,
    ).toBe(false);
  });

  it("givenNoSystemTitleBarField_whenRead_thenFalse", () => {
    const { systemTitleBar: _omitted, ...appearance } = CHOSEN.appearance;

    expect(readSettings({ ...CHOSEN, appearance }).appearance.systemTitleBar).toBe(false);
    expect(
      readSettings({ ...CHOSEN, appearance: { ...appearance, systemTitleBar: "yes" } }).appearance.systemTitleBar,
    ).toBe(false);
    expect(readSettings(CHOSEN).appearance.systemTitleBar).toBe(true);
  });

  it("givenMotionMissing_whenRead_thenSystem", () => {
    const { motion: _omitted, ...appearance } = CHOSEN.appearance;

    expect(readSettings({ ...CHOSEN, appearance }).appearance.motion).toBe("system");
  });

  it("givenMotionUnknown_whenRead_thenSystemAndOtherFieldsKept", () => {
    const read = readSettings({ ...CHOSEN, appearance: { ...CHOSEN.appearance, motion: "minimal" } });

    expect(read.appearance).toEqual({ ...CHOSEN.appearance, motion: "system" });
    expect(read.data).toEqual(CHOSEN.data);
  });

  it("givenMotionOff_whenRead_thenOff", () => {
    const read = readSettings({ ...CHOSEN, appearance: { ...CHOSEN.appearance, motion: "off" } });

    expect(read.appearance.motion).toBe("off");
    expect(settingsSchema.safeParse(read).success).toBe(true);
  });

  it("givenRunAllOnErrorMissingOrUnknown_whenRead_thenAsk", () => {
    expect(readSettings(CHOSEN).console.runAllOnError).toBe("continue");
    expect(readSettings({ ...CHOSEN, console: { parameters: false } }).console.runAllOnError).toBe("ask");
    expect(
      readSettings({ ...CHOSEN, console: { ...CHOSEN.console, runAllOnError: "ignore" } }).console.runAllOnError,
    ).toBe("ask");
  });

  it("givenWriteRequest_whenAnyValueOutOfRange_thenRefused", () => {
    expect(settingsSchema.safeParse(CHOSEN).success).toBe(true);
    expect(settingsSchema.safeParse({ ...CHOSEN, data: { ...CHOSEN.data, fetchAllCap: 50 } }).success).toBe(false);
    expect(settingsSchema.safeParse({ ...CHOSEN, extra: true }).success).toBe(false);
  });

  it("givenMcpPortBelowRange_whenRead_thenDefaultPortAndOtherMcpFieldsKept", () => {
    const read = readSettings({ ...CHOSEN, mcp: { ...CHOSEN.mcp, port: 80 } });

    expect(read.mcp).toEqual({ ...CHOSEN.mcp, port: DEFAULT_SETTINGS.mcp.port });
  });

  it("givenNoMcpSection_whenRead_thenServerOff", () => {
    const { mcp: _mcp, ...older } = CHOSEN;

    expect(readSettings(older).mcp).toEqual({ enabled: false, port: 47_820, rowCap: 100, clients: [] });
  });
});

describe("settings service", () => {
  it("givenTwoWritesAtOnce_whenSaved_thenOneAfterTheOtherAndTheLastWins", async () => {
    const { files, store: saving } = store();
    const changes: SettingsChanged[] = [];
    const service = await createSettingsService({
      store: saving,
      themes: NO_THEMES,
      onChanged: (c) => changes.push(c),
    });
    const second = { ...CHOSEN, appearance: { ...CHOSEN.appearance, theme: "dark" as const } };

    await Promise.all([service.write(CHOSEN), service.write(second)]);

    expect(changes.map((change) => change.settings)).toEqual([CHOSEN, second]);
    expect(JSON.parse(files.contents.get(PATH) ?? "")).toEqual(second);
    expect(service.snapshot().settings).toEqual(second);
  });

  it("givenFailedWrite_whenNextWriteQueued_thenItStillRuns", async () => {
    const { files, store: saving } = store();
    const service = await createSettingsService({ store: saving, themes: NO_THEMES, onChanged: () => undefined });
    files.dieDuringNextWrite();

    const results = await Promise.allSettled([service.write(DEFAULT_SETTINGS), service.write(CHOSEN)]);

    expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
    expect(service.snapshot().settings).toEqual(CHOSEN);
  });
});
