import { create } from "zustand";
import type { PluginInfo } from "@table-craft/desktop/preload/bridge.js";
import {
  snippetProblem,
  snippetScopeKey,
  type SnippetScope,
  type TextSnippet,
} from "@table-craft/desktop/snippets/snippets.js";

const SUGGESTED_NAME_LENGTH = 60;
const SUGGESTED_PREFIX_LENGTH = 20;
const VALID_SAMPLE: TextSnippet = {
  id: "sample",
  name: "Sample",
  prefix: "sample",
  body: "text",
  scope: { kind: "all" },
};
export type SnippetField = "name" | "prefix" | "body" | "scope";

export function snippetFieldProblems(
  draft: TextSnippet,
  snippets: readonly TextSnippet[],
): Partial<Record<SnippetField, string>> {
  const problems: Partial<Record<SnippetField, string>> = {};
  for (const field of ["name", "prefix", "body", "scope"] as const) {
    const problem = snippetProblem({ ...VALID_SAMPLE, [field]: draft[field] });
    if (problem !== null) problems[field] = problem;
  }
  if (
    snippets.some(
      (item) =>
        item.id !== draft.id &&
        item.prefix.toLowerCase() === draft.prefix.toLowerCase() &&
        snippetScopeKey(item.scope) === snippetScopeKey(draft.scope),
    )
  ) {
    problems.prefix = "This prefix is already used in this scope. Choose another prefix or scope.";
  }
  return problems;
}

export function snippetSuggestions(text: string): { name: string; prefix: string } {
  const name =
    text
      .split("\n")
      .find((line) => line.trim() !== "")
      ?.trim()
      .slice(0, SUGGESTED_NAME_LENGTH) || "Untitled snippet";
  const words = name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  const prefix = (/^[a-z_]/.test(words) ? words : `snippet_${words}`).slice(0, SUGGESTED_PREFIX_LENGTH);
  return { name, prefix: prefix || "snippet" };
}

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
  readonly validated: boolean;
  readonly errorDismissed: boolean;
  readonly importConsoleId: string | null;
  readonly notice: { readonly consoleId: string; readonly snippet: TextSnippet } | null;
  readonly returnFocus: HTMLElement | null;
  readonly show: (snippet: TextSnippet | null, returnFocus: HTMLElement | null, defaultScope?: SnippetScope) => void;
  readonly hide: () => void;
  readonly select: (snippet: TextSnippet | null, original: TextSnippet | null) => void;
  readonly change: (patch: Partial<Pick<TextSnippet, "name" | "prefix" | "scope" | "body">>) => void;
  readonly search: (query: string) => void;
  readonly setWorking: (working: boolean) => void;
  readonly setProblem: (problem: string | null) => void;
  readonly beginImport: (consoleId: string) => void;
  readonly created: (consoleId: string, snippet: TextSnippet) => void;
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
  validated: false,
  errorDismissed: false,
  importConsoleId: null,
  notice: null,
  returnFocus: null,
  show: (snippet, returnFocus, defaultScope = { kind: "all" }) =>
    set({
      open: true,
      draft: snippet,
      original: snippet,
      query: "",
      problem: null,
      validated: false,
      errorDismissed: false,
      importConsoleId: null,
      returnFocus,
      defaultScope,
    }),
  hide: () => set({ open: false, draft: null, original: null, problem: null, importConsoleId: null }),
  select: (draft, original) => set({ draft, original, problem: null, validated: false, errorDismissed: false }),
  change: (patch) => {
    const draft = get().draft;
    if (draft !== null) set({ draft: { ...draft, ...patch }, problem: null, errorDismissed: false });
  },
  search: (query) => set({ query }),
  setWorking: (working) => set({ working }),
  setProblem: (problem) =>
    set({ problem, validated: get().validated || problem !== null, errorDismissed: problem === null }),
  beginImport: (consoleId) => set({ importConsoleId: consoleId }),
  created: (consoleId, snippet) => set({ notice: { consoleId, snippet } }),
}));
