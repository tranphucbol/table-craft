import { describe, expect, it } from "vitest";
import {
  BUILT_IN_THEMES,
  COMFORTABLE_DENSITY,
  frameColors,
  COMPACT_DENSITY,
  type Theme,
} from "@table-craft/desktop/appearance/themes.js";
import { windowChrome } from "@table-craft/desktop/main/chrome.js";

const DARK = BUILT_IN_THEMES.dark;
const SOLAR: Theme = {
  id: "user:solar",
  name: "Solar",
  colorScheme: "light",
  contrast: "aa",
  colors: { ...BUILT_IN_THEMES.light.colors, panel: "#fdf6e3", ink: "#586e75" },
};

describe("window chrome", () => {
  it("givenMac_whenChromeBuilt_thenHiddenInsetWithCentredLights", () => {
    const chrome = windowChrome({
      platform: "darwin",
      theme: DARK,
      density: COMFORTABLE_DENSITY,
      systemTitleBar: false,
      windowStyle: "classic",
    });

    expect(chrome.options).toEqual({ titleBarStyle: "hiddenInset", trafficLightPosition: { x: 12, y: 13 } });
    expect(chrome.trafficLights).toEqual({ x: 12, y: 13 });
    expect(chrome.overlay).toBeNull();
    expect(
      windowChrome({
        platform: "darwin",
        theme: DARK,
        density: COMPACT_DENSITY,
        systemTitleBar: false,
        windowStyle: "classic",
      }).trafficLights,
    ).toEqual({ x: 12, y: 9 });
  });

  it("givenWindows_whenChromeBuilt_thenOverlayUsesPanelAndInk", () => {
    for (const platform of ["win32", "linux"] as const) {
      const chrome = windowChrome({
        platform,
        theme: DARK,
        density: COMFORTABLE_DENSITY,
        systemTitleBar: false,
        windowStyle: "classic",
      });

      const overlay = { color: DARK.colors.panel, symbolColor: DARK.colors.ink, height: 40 };
      expect(chrome.options).toEqual({ titleBarStyle: "hidden", titleBarOverlay: overlay });
      expect(chrome.overlay).toEqual(overlay);
      expect(chrome.trafficLights).toBeNull();
    }
  });

  it("givenCompactDensity_whenChromeBuilt_thenOverlayIs32High", () => {
    const chrome = windowChrome({
      platform: "win32",
      theme: DARK,
      density: COMPACT_DENSITY,
      systemTitleBar: false,
      windowStyle: "classic",
    });

    expect(chrome.overlay?.height).toBe(32);
  });

  it("givenSystemTitleBar_whenChromeBuilt_thenNoChromeOptions", () => {
    for (const platform of ["darwin", "win32", "linux"] as const) {
      expect(
        windowChrome({
          platform,
          theme: DARK,
          density: COMFORTABLE_DENSITY,
          systemTitleBar: true,
          windowStyle: "classic",
        }),
      ).toEqual({
        options: {},
        overlay: null,
        trafficLights: null,
      });
    }
  });

  it("givenUserTheme_whenChromeBuilt_thenOverlayTakesItsPanel", () => {
    const chrome = windowChrome({
      platform: "linux",
      theme: SOLAR,
      density: COMFORTABLE_DENSITY,
      systemTitleBar: false,
      windowStyle: "classic",
    });

    expect(chrome.overlay).toEqual({ color: "#fdf6e3", symbolColor: "#586e75", height: 40 });
  });

  it("givenIslands_whenChromeBuilt_thenOverlayUsesFrame", () => {
    for (const theme of [DARK, BUILT_IN_THEMES.light]) {
      const chrome = windowChrome({
        platform: "win32",
        theme,
        density: COMFORTABLE_DENSITY,
        systemTitleBar: false,
        windowStyle: "islands",
      });

      expect(chrome.overlay?.color).toBe(frameColors(theme).frame);
    }
  });
});
