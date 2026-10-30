import { create } from "zustand";
import { EXTRACTOR_KINDS, type ExtractorKind } from "@table-craft/desktop/engine/protocol.js";
import { VALUE_FORMATS, type ValueFormat } from "@table-craft/desktop/renderer/model/valueFormats.js";
import type { EditorGroupId } from "@table-craft/desktop/renderer/state/tabs.js";

/**
 * Which tool windows are open and how big they are. Per-window UI memory in `localStorage`, not a
 * user preference: `settings.json` (decision 010) is for preferences.
 */
export const LAYOUT_STORAGE_KEY = "table-craft.layout.v1";

export const TOOL_WINDOWS = ["database", "services", "log", "watch"] as const;
export type ToolWindowId = (typeof TOOL_WINDOWS)[number];

export interface Layout {
  readonly visible: Readonly<Record<ToolWindowId, boolean>>;
  /** Percent of the window: the Database and Log windows' widths, the Services window's height. */
  readonly sizes: Readonly<Record<ToolWindowId, number>>;
  /** What `hideAll` closed, so pressing it again brings them back; `null` when nothing is hidden by it. */
  readonly hidden: Readonly<Record<ToolWindowId, boolean>> | null;
  /** Whether the Database pane lists system namespaces such as `pg_catalog` (plan 005). */
  readonly showSystemSchemas: boolean;
  /** Whether a key-value datasource lists its empty databases too (decision 113). */
  readonly showEmptyDatabases: boolean;
  /** The console tabs open at the last change, in tab order, reopened at launch (plan 006). */
  readonly openConsoles: readonly OpenConsole[];
  /** The table tabs open at the last change, reopened disconnected at launch (plan 008 decision 2). */
  readonly openTables: readonly OpenTable[];
  /** The grid's extractor, which both Copy and Export use (plan 007 decision 12). */
  readonly extractor: ExtractorKind;
  /** Whether result grids show the value panel beside their rows (plan 007 decision 15). */
  readonly valuePanel: boolean;
  /** The value panel's format per key pattern, such as `session:*` → gzip (plan 058 decision 15). */
  readonly valueFormats: Readonly<Record<string, ValueFormat>>;
  /** Percent of a console's height its SQL editor takes, the rest going to its results (plan 060). */
  readonly consoleEditor: number;
  readonly editorGroupWidth: number;
  /** Whether Settings › MCP Server shows the red data source warning; its (i) brings it back (plan 117). */
  readonly productionNote: boolean;
}

/**
 * A console tab as the layout remembers it; its text lives in its file (decision 16). A file
 * console (plan 041) carries its absolute `path`; its datasource may be empty, detached.
 */
export interface OpenConsole {
  readonly datasourceId: string;
  readonly name: string;
  readonly active: boolean;
  readonly path?: string;
  readonly pinned?: boolean;
  readonly groupId?: EditorGroupId;
  readonly groupActive?: boolean;
}

/** A table tab as the layout remembers it; its filter and edits are not kept. */
export interface OpenTable {
  readonly datasourceId: string;
  readonly path: readonly string[];
  readonly relation: string;
  readonly active: boolean;
  readonly groupId?: EditorGroupId;
  readonly groupActive?: boolean;
}

export const DEFAULT_CONSOLE_EDITOR_PERCENT = 50;
export const DEFAULT_EDITOR_GROUP_WIDTH = 50;
export const MIN_EDITOR_GROUP_PERCENT = 25;
const MAX_EDITOR_GROUP_PERCENT = 100 - MIN_EDITOR_GROUP_PERCENT;
/** The least of a console's height its editor, and its results, keep while the boundary is dragged. */
export const MIN_CONSOLE_PANE_PERCENT = 10;
const MAX_CONSOLE_EDITOR_PERCENT = 100 - MIN_CONSOLE_PANE_PERCENT;

export const DEFAULT_LAYOUT: Layout = {
  visible: { database: true, services: true, log: false, watch: false },
  sizes: { database: 22, services: 28, log: 30, watch: 30 },
  hidden: null,
  showSystemSchemas: false,
  showEmptyDatabases: false,
  openConsoles: [],
  openTables: [],
  extractor: "csv",
  valuePanel: false,
  valueFormats: {},
  consoleEditor: DEFAULT_CONSOLE_EDITOR_PERCENT,
  editorGroupWidth: DEFAULT_EDITOR_GROUP_WIDTH,
  productionNote: true,
};

const MIN_SIZE_PERCENT = 5;
const MAX_SIZE_PERCENT = 80;

export type LayoutStorage = Pick<Storage, "getItem" | "setItem">;

/**
 * The saved record with a tool window it does not mention taken from `fallback`, so a layout saved
 * before a window existed keeps everything else (plan 017); null when any entry is invalid.
 */
function recordOf<T>(
  value: unknown,
  check: (entry: unknown) => entry is T,
  fallback: Readonly<Record<ToolWindowId, T>>,
): Record<ToolWindowId, T> | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const read = {} as Record<ToolWindowId, T>;
  for (const id of TOOL_WINDOWS) {
    const entry = record[id] ?? fallback[id];
    if (!check(entry)) return null;
    read[id] = entry;
  }
  return read;
}

const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
const isSize = (value: unknown): value is number =>
  typeof value === "number" && value >= MIN_SIZE_PERCENT && value <= MAX_SIZE_PERCENT;

function isOpenConsole(value: unknown): value is OpenConsole {
  if (typeof value !== "object" || value === null) return false;
  const { datasourceId, name, active, path, pinned, groupId, groupActive } = value as Record<string, unknown>;
  return (
    typeof datasourceId === "string" &&
    typeof name === "string" &&
    typeof active === "boolean" &&
    (path === undefined || typeof path === "string") &&
    (pinned === undefined || typeof pinned === "boolean") &&
    isGroup(groupId) &&
    (groupActive === undefined || typeof groupActive === "boolean")
  );
}

function isOpenTable(value: unknown): value is OpenTable {
  if (typeof value !== "object" || value === null) return false;
  const { datasourceId, path, relation, active, groupId, groupActive } = value as Record<string, unknown>;
  return (
    typeof datasourceId === "string" &&
    Array.isArray(path) &&
    path.every((part) => typeof part === "string") &&
    typeof relation === "string" &&
    typeof active === "boolean" &&
    isGroup(groupId) &&
    (groupActive === undefined || typeof groupActive === "boolean")
  );
}

const isConsoleEditorSize = (value: unknown): value is number =>
  typeof value === "number" && value >= MIN_CONSOLE_PANE_PERCENT && value <= MAX_CONSOLE_EDITOR_PERCENT;

const isGroup = (value: unknown) => value === undefined || value === "left" || value === "right";
const isGroupSize = (value: unknown): value is number =>
  typeof value === "number" && value >= MIN_EDITOR_GROUP_PERCENT && value <= MAX_EDITOR_GROUP_PERCENT;

const isExtractor = (value: unknown): value is ExtractorKind =>
  typeof value === "string" && (EXTRACTOR_KINDS as readonly string[]).includes(value);

function valueFormatsOf(value: unknown): Readonly<Record<string, ValueFormat>> {
  if (typeof value !== "object" || value === null) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, ValueFormat] =>
      (VALUE_FORMATS as readonly unknown[]).includes(entry[1]),
    ),
  );
}

function openConsolesOf(value: unknown): readonly OpenConsole[] {
  return Array.isArray(value) ? value.filter(isOpenConsole) : [];
}

/** The saved layout, or the default when there is none or it no longer reads as one. */
export function loadLayout(storage: Pick<Storage, "getItem">): Layout {
  const text = storage.getItem(LAYOUT_STORAGE_KEY);
  if (text === null) return DEFAULT_LAYOUT;
  let saved: unknown;
  try {
    saved = JSON.parse(text);
  } catch {
    return DEFAULT_LAYOUT;
  }
  if (typeof saved !== "object" || saved === null) return DEFAULT_LAYOUT;
  const {
    visible,
    sizes,
    hidden,
    showSystemSchemas,
    showEmptyDatabases,
    openConsoles,
    openTables,
    extractor,
    valuePanel,
    valueFormats,
    consoleEditor,
    editorGroupWidth,
    productionNote,
  } = saved as Record<string, unknown>;
  const visibleRead = recordOf(visible, isBoolean, DEFAULT_LAYOUT.visible);
  const sizesRead = recordOf(sizes, isSize, DEFAULT_LAYOUT.sizes);
  if (visibleRead === null || sizesRead === null) return DEFAULT_LAYOUT;
  return {
    visible: visibleRead,
    sizes: sizesRead,
    hidden: recordOf(hidden, isBoolean, DEFAULT_LAYOUT.visible),
    showSystemSchemas: showSystemSchemas === true,
    showEmptyDatabases: showEmptyDatabases === true,
    openConsoles: openConsolesOf(openConsoles),
    openTables: Array.isArray(openTables) ? openTables.filter(isOpenTable) : [],
    extractor: isExtractor(extractor) ? extractor : DEFAULT_LAYOUT.extractor,
    valuePanel: valuePanel === true,
    valueFormats: valueFormatsOf(valueFormats),
    consoleEditor: isConsoleEditorSize(consoleEditor) ? consoleEditor : DEFAULT_CONSOLE_EDITOR_PERCENT,
    editorGroupWidth: isGroupSize(editorGroupWidth) ? editorGroupWidth : DEFAULT_EDITOR_GROUP_WIDTH,
    productionNote: productionNote !== false,
  };
}

export function saveLayout(storage: Pick<Storage, "setItem">, layout: Layout): void {
  storage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
}

export function toggled(layout: Layout, id: ToolWindowId): Layout {
  return { ...layout, visible: { ...layout.visible, [id]: !layout.visible[id] }, hidden: null };
}

/** DataGrip's Hide All Tool Windows: hides what is open, or restores what it last hid. */
export function hiddenAll(layout: Layout): Layout {
  const anyVisible = TOOL_WINDOWS.some((id) => layout.visible[id]);
  if (anyVisible)
    return {
      ...layout,
      visible: { database: false, services: false, log: false, watch: false },
      hidden: layout.visible,
    };
  if (layout.hidden !== null) return { ...layout, visible: layout.hidden, hidden: null };
  return layout;
}

export function shown(layout: Layout, id: ToolWindowId): Layout {
  return layout.visible[id] ? layout : { ...layout, visible: { ...layout.visible, [id]: true }, hidden: null };
}

export function resized(layout: Layout, id: ToolWindowId, percent: number): Layout {
  const size = Math.min(MAX_SIZE_PERCENT, Math.max(MIN_SIZE_PERCENT, percent));
  if (layout.sizes[id] === size) return layout;
  return { ...layout, sizes: { ...layout.sizes, [id]: size } };
}

export function consoleEditorResized(layout: Layout, percent: number): Layout {
  const size = Math.min(MAX_CONSOLE_EDITOR_PERCENT, Math.max(MIN_CONSOLE_PANE_PERCENT, percent));
  return layout.consoleEditor === size ? layout : { ...layout, consoleEditor: size };
}

export interface LayoutState {
  readonly layout: Layout;
  readonly toggle: (id: ToolWindowId) => void;
  readonly show: (id: ToolWindowId) => void;
  readonly hideAll: () => void;
  readonly resize: (id: ToolWindowId, percent: number) => void;
  readonly toggleSystemSchemas: () => void;
  readonly toggleEmptyDatabases: () => void;
  readonly setOpenConsoles: (openConsoles: readonly OpenConsole[]) => void;
  readonly setOpenTables: (openTables: readonly OpenTable[]) => void;
  readonly setExtractor: (extractor: ExtractorKind) => void;
  readonly toggleValuePanel: () => void;
  readonly setProductionNote: (shown: boolean) => void;
  readonly resizeConsoleEditor: (percent: number) => void;
  readonly resizeEditorGroups: (percent: number) => void;
  /** Remembers `format` for keys like `pattern`; Auto forgets it. */
  readonly setValueFormat: (pattern: string, format: ValueFormat) => void;
}

/** A layout store over `storage`; the app passes `localStorage`, tests a map. */
export function createLayoutStore(storage: LayoutStorage) {
  return create<LayoutState>()((set, get) => {
    function update(next: Layout): void {
      if (next === get().layout) return;
      set({ layout: next });
      saveLayout(storage, next);
    }
    return {
      layout: loadLayout(storage),
      toggle: (id) => update(toggled(get().layout, id)),
      show: (id) => update(shown(get().layout, id)),
      hideAll: () => update(hiddenAll(get().layout)),
      resize: (id, percent) => update(resized(get().layout, id, percent)),
      toggleSystemSchemas: () => update({ ...get().layout, showSystemSchemas: !get().layout.showSystemSchemas }),
      toggleEmptyDatabases: () => update({ ...get().layout, showEmptyDatabases: !get().layout.showEmptyDatabases }),
      setOpenConsoles(openConsoles) {
        if (JSON.stringify(openConsoles) === JSON.stringify(get().layout.openConsoles)) return;
        update({ ...get().layout, openConsoles });
      },
      setOpenTables(openTables) {
        if (JSON.stringify(openTables) === JSON.stringify(get().layout.openTables)) return;
        update({ ...get().layout, openTables });
      },
      setExtractor(extractor) {
        if (extractor !== get().layout.extractor) update({ ...get().layout, extractor });
      },
      toggleValuePanel: () => update({ ...get().layout, valuePanel: !get().layout.valuePanel }),
      setProductionNote(productionNote) {
        if (productionNote !== get().layout.productionNote) update({ ...get().layout, productionNote });
      },
      resizeConsoleEditor: (percent) => update(consoleEditorResized(get().layout, percent)),
      resizeEditorGroups: (percent) => {
        const editorGroupWidth = Math.min(MAX_EDITOR_GROUP_PERCENT, Math.max(MIN_EDITOR_GROUP_PERCENT, percent));
        if (Number.isFinite(editorGroupWidth) && editorGroupWidth !== get().layout.editorGroupWidth)
          update({ ...get().layout, editorGroupWidth });
      },
      setValueFormat(pattern, format) {
        const { [pattern]: current, ...rest } = get().layout.valueFormats;
        if ((current ?? "auto") === format) return;
        update({ ...get().layout, valueFormats: format === "auto" ? rest : { ...rest, [pattern]: format } });
      },
    };
  });
}

export type LayoutStore = ReturnType<typeof createLayoutStore>;

/** For a renderer without `localStorage`, such as a unit test importing the app's stores. */
export function memoryStorage(): LayoutStorage {
  const entries = new Map<string, string>();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, value),
  };
}

export const useLayout = createLayoutStore(
  typeof globalThis.localStorage === "undefined" ? memoryStorage() : globalThis.localStorage,
);
