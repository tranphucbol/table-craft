import { create } from "zustand";
import type { PluginInfo } from "@table-craft/desktop/preload/bridge.js";
import type { SnippetScope, TextSnippet } from "@table-craft/desktop/snippets/snippets.js";

export function snippetScopeValue(scope: SnippetScope): string {
  if (scope.kind === "plugin") return `plugin:${scope.pluginId}`;
  if (scope.kind === "sql" && scope.highlight !== undefined) return `legacy-sql:${scope.highlight}`;
  return scope.kind;
}

export function eligibleSnippetPlugins(plugins: readonly PluginInfo[]): readonly PluginInfo[] {
  return plugins.filter((plugin) => plugin.capabilities.includes("sql") || plugin.capabilities.includes("commands"));
}

export function snippetScopeLabel(scope: SnippetScope, plugins: readonly PluginInfo[]): string {
  if (scope.kind === "all") return "All text consoles";
  if (scope.kind === "sql")
    return scope.highlight === undefined ? "All SQL consoles" : `SQL dialect: ${scope.highlight} (legacy)`;
  return (
    eligibleSnippetPlugins(plugins).find((plugin) => plugin.id === scope.pluginId)?.name ??
    `Datasource type: ${scope.pluginId} (not installed)`
  );
}

export function snippetScopeOptions(plugins: readonly PluginInfo[], selected: SnippetScope) {
  const scopes: SnippetScope[] = [
    { kind: "all" },
    { kind: "sql" },
    ...eligibleSnippetPlugins(plugins).map((plugin): SnippetScope => ({ kind: "plugin", pluginId: plugin.id })),
  ];
  if (!scopes.some((scope) => snippetScopeValue(scope) === snippetScopeValue(selected))) scopes.push(selected);
  return scopes.map((scope) => ({ value: snippetScopeValue(scope), label: snippetScopeLabel(scope, plugins), scope }));
}

export interface SnippetsDialogState {
  readonly open: boolean;
  readonly draft: TextSnippet | null;
  readonly original: TextSnippet | null;
  readonly defaultScope: SnippetScope;
  readonly query: string;
  readonly working: boolean;
  readonly problem: string | null;
  readonly returnFocus: HTMLElement | null;
  readonly show: (snippet: TextSnippet | null, returnFocus: HTMLElement | null, defaultScope?: SnippetScope) => void;
  readonly hide: () => void;
  readonly select: (snippet: TextSnippet | null, original: TextSnippet | null) => void;
  readonly change: (patch: Partial<Pick<TextSnippet, "name" | "prefix" | "scope" | "body">>) => void;
  readonly search: (query: string) => void;
  readonly setWorking: (working: boolean) => void;
  readonly setProblem: (problem: string | null) => void;
}

/** New drafts count as unsaved even before their first edit. */
export function snippetDraftDirty(state: Pick<SnippetsDialogState, "draft" | "original">): boolean {
  const { draft, original } = state;
  return (
    draft !== null &&
    (original === null ||
      draft.name !== original.name ||
      draft.prefix !== original.prefix ||
      snippetScopeValue(draft.scope) !== snippetScopeValue(original.scope) ||
      draft.body !== original.body)
  );
}

export const useSnippetsDialog = create<SnippetsDialogState>()((set, get) => ({
  open: false,
  draft: null,
  original: null,
  defaultScope: { kind: "all" },
  query: "",
  working: false,
  problem: null,
  returnFocus: null,
  show: (snippet, returnFocus, defaultScope = { kind: "all" }) =>
    set({ open: true, draft: snippet, original: snippet, query: "", problem: null, returnFocus, defaultScope }),
  hide: () => set({ open: false, draft: null, original: null, problem: null }),
  select: (draft, original) => set({ draft, original, problem: null }),
  change: (patch) => {
    const draft = get().draft;
    if (draft !== null) set({ draft: { ...draft, ...patch }, problem: null });
  },
  search: (query) => set({ query }),
  setWorking: (working) => set({ working }),
  setProblem: (problem) => set({ problem }),
}));
