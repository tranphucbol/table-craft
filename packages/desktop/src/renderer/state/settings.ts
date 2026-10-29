import { create } from "zustand";
import {
  DENSITIES,
  resolveTheme,
  type ResolvedTheme,
  type SystemAppearance,
  type UserThemeEntry,
} from "@table-craft/desktop/appearance/themes.js";
import type { FormatOptions, ResultPaging, StatementLimit } from "@table-craft/desktop/engine/protocol.js";
import type {
  InvokeResult,
  SettingsChanged,
  SettingsSnapshot,
  TableCraftBridge,
} from "@table-craft/desktop/preload/bridge.js";
import { bridge } from "@table-craft/desktop/renderer/bridge.js";
import { rendererLog } from "@table-craft/desktop/renderer/log/log.js";
import type { CellFormats } from "@table-craft/desktop/renderer/grid/format.js";
import {
  DEFAULT_SETTINGS,
  type RunAllOnError,
  type Settings,
  type ThemeChoice,
} from "@table-craft/desktop/settings/settings.js";

type SettingsBridge = Pick<TableCraftBridge, "readSettings" | "writeSettings" | "reloadThemes" | "openThemesFolder">;

export interface SettingsState {
  readonly settings: Settings;
  readonly themes: readonly UserThemeEntry[];
  /** What the OS's media queries say; a `"system"` theme and a `"system"` motion follow it. */
  readonly system: SystemPreferences;
  /** Why `settings.json` was set aside, or why a save failed; shown once, until dismissed. */
  readonly notice: string | null;
  /**
   * The theme the picker has highlighted, drawn instead of the chosen one until it is chosen or the
   * picker closes (decision 065). Never saved, and not seen by main or other windows.
   */
  readonly previewTheme: ThemeChoice | null;
  /** Reads main's copy; `main.tsx` awaits it before the first render (plan 013 decision 5). */
  readonly load: () => Promise<void>;
  /** Main saved settings or reread the themes, in this window or another. */
  readonly changed: (changed: SettingsChanged) => void;
  readonly setSystem: (system: SystemPreferences) => void;
  /** Draws `choice` without choosing it; `null` goes back to the chosen theme. */
  readonly preview: (choice: ThemeChoice | null) => void;
  /**
   * The one way settings change: applied here at once, then saved through main. A save that fails
   * puts the previous settings back and says why.
   */
  readonly update: (patch: (current: Settings) => Settings) => Promise<void>;
  readonly reloadThemes: () => Promise<void>;
  readonly openThemesFolder: () => Promise<void>;
  readonly dismissNotice: () => void;
}

export interface SettingsStoreOptions {
  readonly bridge: () => SettingsBridge;
  readonly log: (message: string, cause: unknown) => void;
}

/**
 * The theme's system appearance plus `prefers-reduced-motion`, which only the renderer reads
 * (plan 109 decision 11), so main's `SystemAppearance` stays as it is.
 */
export interface SystemPreferences extends SystemAppearance {
  readonly prefersReducedMotion: boolean;
}

const DARK_SYSTEM: SystemPreferences = { prefersDark: true, prefersMoreContrast: false, prefersReducedMotion: false };

function failureText(answer: InvokeResult<unknown>): string | null {
  return answer.ok ? null : `${answer.error.message} ${answer.error.hint}`;
}

export function createSettingsStore(options: SettingsStoreOptions) {
  return create<SettingsState>()((set, get) => {
    /** Writes not yet answered; an echo of an older one must not undo a newer local change. */
    let pendingWrites = 0;

    async function call(run: () => Promise<InvokeResult<unknown>>, what: string): Promise<boolean> {
      try {
        const failure = failureText(await run());
        if (failure === null) return true;
        set({ notice: `Could not ${what}: ${failure}` });
      } catch (cause) {
        options.log(`could not ${what}`, cause);
        set({ notice: `Could not ${what}. Restart TableCraft and try again.` });
      }
      return false;
    }

    return {
      settings: DEFAULT_SETTINGS,
      themes: [],
      system: DARK_SYSTEM,
      notice: null,
      previewTheme: null,
      async load() {
        let snapshot: SettingsSnapshot | null = null;
        await call(async () => {
          const answer = await options.bridge().readSettings();
          if (answer.ok) snapshot = answer.value;
          return answer;
        }, "read the settings");
        if (snapshot === null) return;
        const { settings, themes, warning } = snapshot;
        set({ settings, themes, notice: warning ?? get().notice });
      },
      changed({ settings, themes }) {
        set(pendingWrites > 0 ? { themes } : { settings, themes });
      },
      setSystem(system) {
        const current = get().system;
        if (
          current.prefersDark === system.prefersDark &&
          current.prefersMoreContrast === system.prefersMoreContrast &&
          current.prefersReducedMotion === system.prefersReducedMotion
        ) {
          return;
        }
        set({ system });
      },
      preview(choice) {
        if (get().previewTheme !== choice) set({ previewTheme: choice });
      },
      async update(patch) {
        const previous = get().settings;
        const next = patch(previous);
        if (next === previous) return;
        set({ settings: next });
        pendingWrites += 1;
        const saved = await call(() => options.bridge().writeSettings(next), "save the settings");
        pendingWrites -= 1;
        if (!saved && get().settings === next) set({ settings: previous });
      },
      async reloadThemes() {
        await call(() => options.bridge().reloadThemes(), "reload the themes");
      },
      async openThemesFolder() {
        await call(() => options.bridge().openThemesFolder(), "open the themes folder");
      },
      dismissNotice: () => set({ notice: null }),
    };
  });
}

export type SettingsStore = ReturnType<typeof createSettingsStore>;

export const useSettings = createSettingsStore({
  bridge,
  log: (message, cause) => rendererLog("settings").warn(message, { err: cause }),
});

/**
 * The theme to draw: the one being previewed, else the one the settings choose, made concrete for
 * the system appearance and the user themes.
 */
export function themeOf(
  state: Pick<SettingsState, "settings" | "system" | "themes"> & Partial<Pick<SettingsState, "previewTheme">>,
): ResolvedTheme {
  return resolveTheme(state.previewTheme ?? state.settings.appearance.theme, state.system, state.themes);
}

/**
 * The row height the density draws; virtualised lists read it here rather than once at import,
 * so their row positions and the DOM's `--tc-row-height` agree after a density change.
 */
export function useRowHeightPx(): number {
  return useSettings((state) => DENSITIES[state.settings.appearance.density].rowHeightPx);
}

/** How the grid draws and measures cells; the same object until a Data Editor setting changes. */
export function useCellFormats(): CellFormats {
  return useSettings((state) => state.settings.data);
}

export function currentFormats(): CellFormats {
  return useSettings.getState().settings.data;
}

/** What every call that reads rows carries (decision 032). */
export function pagingOf(settings: Settings): ResultPaging {
  return { pageRows: settings.data.pageRows, fetchAllCap: settings.data.fetchAllCap };
}

/** The paging to send now; a change applies to the next statement, not to open results. */
export function currentPaging(): ResultPaging {
  return pagingOf(useSettings.getState().settings);
}

/** What Reformat Code sends with the text (plan 019 decision 3). */
export function currentFormatOptions(): FormatOptions {
  return useSettings.getState().settings.editor.format;
}

/**
 * The seconds a console statement may run before the engine cancels it: the datasource's own
 * limit, else Settings → Editor → Running; 0 is none (decision 054).
 */
export function statementTimeoutOf(
  datasource: { readonly statementTimeoutSeconds?: number | undefined } | undefined,
): number {
  return datasource?.statementTimeoutSeconds ?? useSettings.getState().settings.console.statementTimeoutSeconds;
}

/** Whether the datasource has the database stop its console and grid statements at that limit too (decision 129). */
export function serverEnforcedOf(
  datasource: { readonly enforceTimeoutOnServer?: true | undefined } | undefined,
): boolean {
  return datasource?.enforceTimeoutOnServer === true;
}

/** The limit a request carries: nothing at 0, and the database asked only for a real limit. */
export function statementLimit(seconds: number, serverEnforced: boolean): StatementLimit {
  if (seconds <= 0) return {};
  return serverEnforced ? { timeoutSeconds: seconds, serverEnforced: true } : { timeoutSeconds: seconds };
}

/** Whether a run looks for `:name`, `?` and `$1` and asks for their values (plan 019 decision 8). */
export function detectsParameters(): boolean {
  return useSettings.getState().settings.console.parameters;
}

/** What a run of more than one statement does when one fails (decision 083). */
export function runAllOnError(): RunAllOnError {
  return useSettings.getState().settings.console.runAllOnError;
}
