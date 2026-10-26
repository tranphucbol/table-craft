import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultSnippetScope,
  SNIPPET_ACTIONS,
  SNIPPET_ACTION_IDS,
} from "@table-craft/desktop/renderer/actions/snippetActions.js";
import type { ActionContext } from "@table-craft/desktop/renderer/actions/context.js";
import type { PluginInfo } from "@table-craft/desktop/preload/bridge.js";
import { DISCONNECTED } from "@table-craft/desktop/renderer/state/datasources.js";
import { useModal } from "@table-craft/desktop/renderer/state/modal.js";
import { useSnippets } from "@table-craft/desktop/renderer/state/snippets.js";
import {
  snippetDraftDirty,
  snippetScopeOptions,
  snippetScopeLabel,
  useSnippetsDialog,
} from "@table-craft/desktop/renderer/state/snippetsDialog.js";
import type { TextSnippet } from "@table-craft/desktop/snippets/snippets.js";
import { IDLE_CONTEXT } from "./support.js";
import { POSTGRES_PLUGIN, view } from "./datasourceViews.js";

const FIRST: TextSnippet = {
  id: "first",
  name: "Select rows",
  prefix: "sel",
  body: "SELECT * FROM ${table};",
  scope: { kind: "all" },
};
const SECOND: TextSnippet = {
  ...FIRST,
  id: "second",
  name: "Other",
  prefix: "other",
  scope: { kind: "plugin", pluginId: "future-type" },
};
const initialDialog = useSnippetsDialog.getState();
const initialSnippets = useSnippets.getState();

function run(id: string, args?: unknown): Promise<void> {
  const action = SNIPPET_ACTIONS.find((action) => action.id === id);
  if (action === undefined) throw new Error(`Missing action ${id}`);
  return Promise.resolve(action.run(IDLE_CONTEXT, args as never));
}

beforeEach(() => {
  useSnippets.setState({ ...initialSnippets, loaded: true, snippets: [FIRST, SECOND] }, true);
  useSnippetsDialog.setState(initialDialog, true);
  useSnippetsDialog.getState().show(FIRST, null);
});

afterEach(() => {
  useModal.getState().answer(null);
  useSnippetsDialog.setState(initialDialog, true);
  useSnippets.setState(initialSnippets, true);
  vi.restoreAllMocks();
});

describe("text snippets dialog commands", () => {
  it("givenNewDraft_whenUntouched_thenStillNeedsSaving", () => {
    expect(snippetDraftDirty({ draft: FIRST, original: null })).toBe(true);
    expect(snippetDraftDirty({ draft: FIRST, original: FIRST })).toBe(false);
    expect(snippetDraftDirty({ draft: { ...FIRST, scope: { kind: "sql" } }, original: FIRST })).toBe(true);
    expect(snippetDraftDirty({ draft: { ...FIRST, scope: { kind: "all" } }, original: FIRST })).toBe(false);
  });

  it("givenDirtyDraft_whenSelectionCancelled_thenKeepsDraft", async () => {
    await run(SNIPPET_ACTION_IDS.change, { name: "Changed" });
    const selecting = run(SNIPPET_ACTION_IDS.select, SECOND.id);
    expect(useModal.getState().pending?.request.kind).toBe("choice");
    expect(useSnippetsDialog.getState().working).toBe(true);
    useModal.getState().answer(null);
    await selecting;
    expect(useSnippetsDialog.getState().draft?.name).toBe("Changed");
    expect(useSnippetsDialog.getState().working).toBe(false);
  });

  it("givenDirtyDraft_whenDiscardChosen_thenSelectsUnknownScopeUnchanged", async () => {
    await run(SNIPPET_ACTION_IDS.change, { body: "changed" });
    const selecting = run(SNIPPET_ACTION_IDS.select, SECOND.id);
    useModal.getState().answer("discard");
    await selecting;
    expect(useSnippetsDialog.getState().draft).toEqual(SECOND);
    expect(snippetDraftDirty(useSnippetsDialog.getState())).toBe(false);
  });

  it("givenInvalidDraft_whenSaveThenCloseSaveChosen_thenKeepsFormAndExplainsProblem", async () => {
    const save = vi.fn().mockResolvedValue(true);
    useSnippets.setState({ save });
    await run(SNIPPET_ACTION_IDS.change, { prefix: "invalid prefix" });
    const closing = run(SNIPPET_ACTION_IDS.close);
    useModal.getState().answer("save");
    await closing;
    expect(save).not.toHaveBeenCalled();
    expect(useSnippetsDialog.getState().open).toBe(true);
    expect(useSnippetsDialog.getState().problem).toContain("prefix");
  });

  it("givenSaveFailure_whenSaveBeforeClose_thenKeepsUnsavedDraft", async () => {
    useSnippets.setState({ save: vi.fn().mockResolvedValue(false) });
    await run(SNIPPET_ACTION_IDS.change, { name: "Changed" });
    const closing = run(SNIPPET_ACTION_IDS.close);
    useModal.getState().answer("save");
    await closing;
    expect(useSnippetsDialog.getState().open).toBe(true);
    expect(snippetDraftDirty(useSnippetsDialog.getState())).toBe(true);
  });

  it("givenSaveSuccess_whenSaved_thenClearsDirtyState", async () => {
    const changed = { ...FIRST, name: "Changed" };
    useSnippets.setState({
      save: vi.fn(() => {
        useSnippets.setState({ snippets: [changed, SECOND] });
        return Promise.resolve(true);
      }),
    });
    await run(SNIPPET_ACTION_IDS.change, { name: changed.name });
    await run(SNIPPET_ACTION_IDS.save);
    expect(useSnippetsDialog.getState().draft).toEqual(changed);
    expect(snippetDraftDirty(useSnippetsDialog.getState())).toBe(false);
  });

  it("givenDeleteCancelled_whenAsked_thenNeverRemoves", async () => {
    const remove = vi.fn().mockResolvedValue(true);
    useSnippets.setState({ remove });
    const deleting = run(SNIPPET_ACTION_IDS.delete);
    const request = useModal.getState().pending?.request;
    expect(request?.kind === "confirm" && request.destructive).toBe(true);
    useModal.getState().answer(null);
    await deleting;
    expect(remove).not.toHaveBeenCalled();
    expect(useSnippetsDialog.getState().draft).toEqual(FIRST);
  });

  it("givenDeleteFailure_whenConfirmed_thenKeepsSelection", async () => {
    useSnippets.setState({ remove: vi.fn().mockResolvedValue(false) });
    const deleting = run(SNIPPET_ACTION_IDS.delete);
    useModal.getState().answer("");
    await deleting;
    expect(useSnippetsDialog.getState().draft).toEqual(FIRST);
  });

  it("givenBusyStore_whenCommandsChecked_thenCannotMutateOrClose", () => {
    useSnippets.setState({ busy: true });
    for (const id of [
      SNIPPET_ACTION_IDS.new,
      SNIPPET_ACTION_IDS.save,
      SNIPPET_ACTION_IDS.delete,
      SNIPPET_ACTION_IDS.close,
    ]) {
      expect(SNIPPET_ACTIONS.find((action) => action.id === id)?.when?.(IDLE_CONTEXT)).toBe(false);
    }
  });
});

describe("snippet scope choices", () => {
  const commandPlugin: PluginInfo = {
    ...POSTGRES_PLUGIN,
    id: "future-commands",
    name: "Future Commands",
    capabilities: ["commands"],
    highlight: null,
  };
  const sharedHighlighter: PluginInfo = { ...POSTGRES_PLUGIN, id: "another-sql", name: "Another SQL" };
  const plugins = [POSTGRES_PLUGIN, sharedHighlighter, commandPlugin];

  function contextFor(plugin: PluginInfo): ActionContext {
    return {
      ...IDLE_CONTEXT,
      datasource: {
        view: view({ id: "active", name: "Active", pluginId: plugin.id }),
        connection: DISCONNECTED,
        capabilities: plugin.capabilities,
      },
    };
  }

  it("givenEligibleContext_whenCreatingDraft_thenDefaultsToCapturedDatasourceType", async () => {
    const scope = defaultSnippetScope(contextFor(commandPlugin), plugins);
    expect(scope).toEqual({ kind: "plugin", pluginId: commandPlugin.id });
    useSnippetsDialog.getState().show(FIRST, null, scope);
    await run(SNIPPET_ACTION_IDS.new);
    expect(useSnippetsDialog.getState().draft?.scope).toEqual(scope);
    expect(useSnippetsDialog.getState().draft?.id).toBeTruthy();
  });

  it("givenNoEligibleContext_whenCreatingDraft_thenDefaultsToAllTextConsoles", async () => {
    expect(defaultSnippetScope(IDLE_CONTEXT, plugins)).toEqual({ kind: "all" });
    const unsupported: PluginInfo = { ...commandPlugin, capabilities: [] };
    expect(defaultSnippetScope(contextFor(unsupported), [unsupported])).toEqual({ kind: "all" });
    expect(defaultSnippetScope(contextFor(commandPlugin), [])).toEqual({ kind: "all" });
    await run(SNIPPET_ACTION_IDS.new);
    expect(useSnippetsDialog.getState().draft?.scope).toEqual({ kind: "all" });
  });

  it("givenSameHighlighterPlugins_whenListingChoices_thenKeepsSeparateDatasourceTypes", () => {
    expect(snippetScopeOptions(plugins, { kind: "all" }).map(({ value, label }) => ({ value, label }))).toEqual([
      { value: "all", label: "All text consoles" },
      { value: "sql", label: "All SQL consoles" },
      { value: `plugin:${POSTGRES_PLUGIN.id}`, label: POSTGRES_PLUGIN.name },
      { value: `plugin:${sharedHighlighter.id}`, label: sharedHighlighter.name },
      { value: `plugin:${commandPlugin.id}`, label: commandPlugin.name },
    ]);
  });

  it("givenUnknownPluginScope_whenEditingNameAndSaving_thenRetainsScope", async () => {
    const save = vi.fn(() => Promise.resolve(true));
    useSnippets.setState({ save });
    useSnippetsDialog.getState().select(SECOND, SECOND);
    await run(SNIPPET_ACTION_IDS.change, { name: "Renamed" });
    await run(SNIPPET_ACTION_IDS.save);
    expect(save).toHaveBeenCalledWith({ ...SECOND, name: "Renamed" });
    const options = snippetScopeOptions(plugins, SECOND.scope);
    expect(options.at(-1)).toEqual({
      value: "plugin:future-type",
      label: "Datasource type: future-type (not installed)",
      scope: SECOND.scope,
    });
  });

  it("givenLegacySqlScope_whenListedThenSaved_thenRetainsOnlySelectedLegacyChoice", async () => {
    const scope = { kind: "sql", highlight: "old-dialect" } as const;
    const legacy = { ...FIRST, scope };
    const options = snippetScopeOptions(plugins, scope);
    expect(options.at(-1)).toEqual({
      value: "legacy-sql:old-dialect",
      label: "SQL dialect: old-dialect (legacy)",
      scope,
    });
    expect(snippetScopeLabel(scope, plugins)).toContain("old-dialect");
    expect(snippetScopeOptions(plugins, FIRST.scope).some((option) => option.value.startsWith("legacy-sql:"))).toBe(
      false,
    );
    const save = vi.fn(() => Promise.resolve(true));
    useSnippets.setState({ save });
    useSnippetsDialog.getState().select(legacy, legacy);
    await run(SNIPPET_ACTION_IDS.change, { prefix: "legacy" });
    await run(SNIPPET_ACTION_IDS.save);
    expect(save).toHaveBeenCalledWith({ ...legacy, prefix: "legacy" });
  });
});
