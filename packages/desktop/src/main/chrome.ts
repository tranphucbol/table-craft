import type { BrowserWindowConstructorOptions, Point, TitleBarOverlayOptions } from "electron";
import {
  titleBarColor,
  type DensityTokens,
  type Theme,
  type WindowStyle,
} from "@table-craft/desktop/appearance/themes.js";

const MAC_PLATFORM = "darwin";
/** The traffic lights' left edge, AppKit's own margin for a titled window. */
const TRAFFIC_LIGHT_X = 12;
/** The traffic lights' height in points; measured off a `screencapture` of Electron 43 on macOS. */
const TRAFFIC_LIGHT_HEIGHT = 14;

export interface WindowChrome {
  readonly options: Pick<BrowserWindowConstructorOptions, "titleBarStyle" | "titleBarOverlay" | "trafficLightPosition">;
  /** What `setTitleBarOverlay` takes on Windows and Linux when the theme or density changes. */
  readonly overlay: TitleBarOverlayOptions | null;
  /** What `setWindowButtonPosition` takes on macOS when the density changes. */
  readonly trafficLights: Point | null;
}

export interface WindowChromeInput {
  readonly platform: NodeJS.Platform;
  readonly theme: Theme;
  readonly density: DensityTokens;
  readonly systemTitleBar: boolean;
  readonly windowStyle: WindowStyle;
}

/**
 * The window's frame (decision 034): the main toolbar is the title bar, with the macOS traffic
 * lights centred in it or the Windows and Linux caption buttons drawn over its right end in the
 * toolbar's own colours. `systemTitleBar` frames the window as the OS would.
 */
export function windowChrome({
  platform,
  theme,
  density,
  systemTitleBar,
  windowStyle,
}: WindowChromeInput): WindowChrome {
  if (systemTitleBar) return { options: {}, overlay: null, trafficLights: null };
  const height = density.titleBarHeightPx;
  if (platform === MAC_PLATFORM) {
    const trafficLights = { x: TRAFFIC_LIGHT_X, y: Math.round((height - TRAFFIC_LIGHT_HEIGHT) / 2) };
    return {
      options: { titleBarStyle: "hiddenInset", trafficLightPosition: trafficLights },
      overlay: null,
      trafficLights,
    };
  }
  const overlay = {
    color: titleBarColor(theme, windowStyle),
    symbolColor: theme.colors.ink,
    height,
  };
  return { options: { titleBarStyle: "hidden", titleBarOverlay: overlay }, overlay, trafficLights: null };
}
