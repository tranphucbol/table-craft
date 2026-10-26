import { describe, expect, it, vi } from "vitest";
import {
  BUILT_IN_THEMES,
  BUNDLED_THEMES,
  COMPACT_DENSITY,
  type Appearance,
  type ColorScheme,
  type UserThemeEntry,
} from "@table-craft/desktop/appearance/themes.js";
import type { InvokeResult, SettingsSnapshot } from "@table-craft/desktop/preload/bridge.js";
import { createSettingsStore, themeOf } from "@table-craft/desktop/renderer/state/settings.js";
import { installAppearance } from "@table-craft/desktop/renderer/state/wiring.js";
import { DEFAULT_SETTINGS, zoomEditorFont, type Settings } from "@table-craft/desktop/settings/settings.js";

const LIGHT: Settings = { ...DEFAULT_SETTINGS, appearance: { ...DEFAULT_SETTINGS.appearance, theme: "light" } };
const SOLAR: UserThemeEntry = {
  id: "user:solar",
  name: "Solar",
  base: "light",
  colors: { ...BUILT_IN_THEMES.light.colors, accent: "#b58900" },
};

function ok<T>(value: T): Promise<InvokeResult<T>> {
  return Promise.resolve({ ok: true, value });
}

function fakeBridge(snapshot: SettingsSnapshot = { settings: DEFAULT_SETTINGS, themes: [], warning: null }) {
  const written: Settings[] = [];
  let failNext = false;
  return {
    written,
    failNextWrite: () => {
      failNext = true;
    },
    bridge: {
      readSettings: () => ok(snapshot),
      writeSettings: (settings: Settings): Promise<InvokeResult<null>> => {
        if (failNext) {
          failNext = false;
          return Promise.resolve({ ok: false, error: { message: "Disk full.", hint: "Free some space." } });
        }
        written.push(settings);
        return ok(null);
      },
      reloadThemes: () => ok(null),
      openThemesFolder: () => ok(null),
    },
  };
}

function storeWith(fake = fakeBridge()) {
  return createSettingsStore({ bridge: () => fake.bridge, log: () => undefined });
}

function fakeMedia(matches: boolean) {
  const listeners = new Set<() => void>();
  return {
    matches,
    addEventListener: (_type: string, listener: () => void) => void listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => void listeners.delete(listener),
    flip(next: boolean) {
      this.matches = next;
      for (const listener of listeners) listener();
    },
  };
}

describe("settings store", () => {
  it("givenSetAsideFile_whenLoaded_thenSettingsAndNotice", async () => {
    const fake = fakeBridge({ settings: LIGHT, themes: [SOLAR], warning: "settings.json could not be read" });
    const store = storeWith(fake);

    await store.getState().load();

    expect(store.getState()).toMatchObject({
      settings: LIGHT,
      themes: [SOLAR],
      notice: "settings.json could not be read",
    });
  });

  it("givenUpdate_whenSaved_thenAppliedAtOnceAndWrittenThrough", async () => {
    const fake = fakeBridge();
    const store = storeWith(fake);

    const saving = store.getState().update((current) => zoomEditorFont(current, 2));
    expect(store.getState().settings.appearance.fonts.editor.sizePx).toBe(15);
    await saving;

    expect(fake.written).toEqual([zoomEditorFont(DEFAULT_SETTINGS, 2)]);
  });

  it("givenSaveFails_whenUpdated_thenPreviousSettingsBackWithNotice", async () => {
    const fake = fakeBridge();
    const store = storeWith(fake);
    fake.failNextWrite();

    await store.getState().update(() => LIGHT);

    expect(store.getState().settings).toBe(DEFAULT_SETTINGS);
    expect(store.getState().notice).toBe("Could not save the settings: Disk full. Free some space.");
  });

  it("givenBroadcastOfOlderWrite_whileNewerIsPending_thenLocalChangeKept", async () => {
    const store = storeWith();
    const pending = store.getState().update(() => LIGHT);

    store.getState().changed({ settings: DEFAULT_SETTINGS, themes: [SOLAR] });

    expect(store.getState().settings).toBe(LIGHT);
    expect(store.getState().themes).toEqual([SOLAR]);
    await pending;
    store.getState().changed({ settings: DEFAULT_SETTINGS, themes: [] });
    expect(store.getState().settings).toBe(DEFAULT_SETTINGS);
  });

  it("givenChosenUserTheme_whenItDisappears_thenDarkWithNotice", () => {
    const store = storeWith();
    const chosen = { ...DEFAULT_SETTINGS, appearance: { ...DEFAULT_SETTINGS.appearance, theme: SOLAR.id } };
    store.getState().changed({ settings: chosen, themes: [SOLAR] });
    expect(themeOf(store.getState()).theme.colors.accent).toBe("#b58900");

    store.getState().changed({ settings: chosen, themes: [] });

    expect(themeOf(store.getState()).theme.id).toBe("dark");
    expect(themeOf(store.getState()).notice).toContain("solar");
  });
});

describe("live appearance", () => {
  function installed(store = storeWith()) {
    const dark = fakeMedia(true);
    const contrast = fakeMedia(false);
    const reducedMotion = fakeMedia(false);
    const applied: { appearance: Appearance; scheme: ColorScheme }[] = [];
    const apply = vi.fn((appearance: Appearance, scheme: ColorScheme) => void applied.push({ appearance, scheme }));
    const stop = installAppearance(store, {
      matchMedia: (query) =>
        query.includes("contrast") ? contrast : query.includes("reduced-motion") ? reducedMotion : dark,
      apply,
    });
    return { store, dark, contrast, applied, stop };
  }

  it("givenFollowSystem_whenSchemeAndContrastChange_thenAppliedThemeFollows", () => {
    const { dark, contrast, applied } = installed();

    dark.flip(false);
    contrast.flip(true);

    expect(applied.map((entry) => entry.appearance.colors.canvas)).toEqual([
      BUILT_IN_THEMES.dark.colors.canvas,
      BUILT_IN_THEMES.light.colors.canvas,
      BUILT_IN_THEMES.highContrast.colors.canvas,
    ]);
    expect(applied.map((entry) => entry.scheme)).toEqual(["dark", "light", "dark"]);
  });

  it("givenPreviewTheme_whenEscape_thenCommittedThemeIsApplied", () => {
    const { store, applied, stop } = installed();

    store.getState().preview("gruvbox-light");
    store.getState().preview(null);
    stop();

    expect(applied.map((entry) => [entry.appearance.colors.canvas, entry.scheme])).toEqual([
      [BUILT_IN_THEMES.dark.colors.canvas, "dark"],
      [BUNDLED_THEMES["gruvbox-light"].colors.canvas, "light"],
      [BUILT_IN_THEMES.dark.colors.canvas, "dark"],
    ]);
    expect(store.getState().settings.appearance.theme).toBe("system");
  });

  it("givenDensityAndFontChange_whenSettingsUpdate_thenReappliedWithThem", async () => {
    const { store, applied, stop } = installed();

    await store.getState().update((current) => ({
      ...current,
      appearance: {
        ...current.appearance,
        density: "compact",
        fonts: { ...current.appearance.fonts, editor: { family: "Fira Code", sizePx: 16 } },
      },
    }));
    stop();
    await store.getState().update(() => LIGHT);

    expect(applied).toHaveLength(2);
    const last = applied.at(-1)?.appearance;
    expect(last?.density).toEqual(COMPACT_DENSITY);
    expect(last?.fonts.editor.family.startsWith('"Fira Code", ')).toBe(true);
    expect(last?.fonts.editor.sizePx).toBe(16);
  });
});
