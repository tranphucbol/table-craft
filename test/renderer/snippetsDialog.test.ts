import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultSnippetScope,
  SNIPPET_ACTIONS,
  SNIPPET_ACTION_IDS,
} from "@table-craft/desktop/renderer/actions/snippetActions.js";
import type { ActionContext } from "@table-craft/desktop/renderer/actions/context.js";
import type { PluginInfo } from "@table-craft/desktop/preload/bridge.js";
import { DISCONNECTED, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useConsoles } from "@table-craft/desktop/renderer/state/consoles.js";
import { useModal } from "@table-craft/desktop/renderer/state/modal.js";
import { useSnippets } from "@table-craft/desktop/renderer/state/snippets.js";
import {
  snippetDraftDirty,
  snippetFieldProblems,
  snippetSuggestions,
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
const initialConsoles = useConsoles.getState();
const initialDatasources = useDatasources.getState();

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
  useConsoles.setState(initialConsoles, true);
  useDatasources.setState(initialDatasources, true);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("text snippets dialog commands", () => {
  it("givenNewDraft_whenDeleteChecked_thenDisabledWithoutConfirmation", async () => {
    await run(SNIPPET_ACTION_IDS.new);
    expect(SNIPPET_ACTIONS.find((action) => action.id === SNIPPET_ACTION_IDS.delete)?.when?.(IDLE_CONTEXT)).toBe(false);
    await run(SNIPPET_ACTION_IDS.delete);
    expect(useModal.getState().pending).toBeNull();
  });

  it("givenKnownInvalidDraft_whenEditing_thenSaveStaysDisabledUntilValid", async () => {
    await run(SNIPPET_ACTION_IDS.change, { prefix: "not valid" });
    await run(SNIPPET_ACTION_IDS.save);
    const save = SNIPPET_ACTIONS.find((action) => action.id === SNIPPET_ACTION_IDS.save)!;
    expect(save.when?.(IDLE_CONTEXT)).toBe(false);
    useSnippetsDialog.getState().setProblem(null);
    expect(save.when?.(IDLE_CONTEXT)).toBe(false);
    await run(SNIPPET_ACTION_IDS.change, { prefix: "123" });
    expect(save.when?.(IDLE_CONTEXT)).toBe(false);
    await run(SNIPPET_ACTION_IDS.change, { prefix: "valid" });
    expect(save.when?.(IDLE_CONTEXT)).toBe(true);
  });

  it("givenDuplicatePrefix_whenValidated_thenIdentifiesPrefixOnlyInSameScope", () => {
    expect(snippetFieldProblems({ ...FIRST, id: "new", prefix: "SEL" }, [FIRST]).prefix).toContain("already used");
    expect(snippetFieldProblems({ ...FIRST, id: "new", scope: { kind: "sql" } }, [FIRST])).toEqual({});
    expect(snippetFieldProblems({ ...FIRST, name: "", body: " " }, []).name).toContain("name");
    expect(snippetFieldProblems({ ...FIRST, body: " " }, []).body).toContain("text");
  });

  it("givenDirtyDraft_whenGuardOpened_thenOrdersDiscardBeforeSaveAndFocusesSave", async () => {
    await run(SNIPPET_ACTION_IDS.change, { name: "Changed" });
    const closing = run(SNIPPET_ACTION_IDS.close);
    const request = useModal.getState().pending?.request;
    expect(request?.kind === "choice" && request.choices.map((choice) => choice.id)).toEqual(["discard", "save"]);
    expect(request?.kind === "choice" && request.focusedChoice).toBe("save");
    useModal.getState().answer(null);
    await closing;
  });
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

describe("selection import", () => {
  async function contextWithSelection(): Promise<ActionContext> {
    vi.stubGlobal("document", { activeElement: null });
    vi.stubGlobal("HTMLElement", class {});
    await useConsoles
      .getState()
      .open("console", "source", { connect: false, sql: "before SELECT ${field}${cursor} after" });
    useConsoles.getState().setSelection("console", { from: 7, to: 30 });
    useDatasources.setState({ plugins: [POSTGRES_PLUGIN] });
    return {
      ...IDLE_CONTEXT,
      activeTab: { kind: "console", id: "console", title: "Console" },
      console: useConsoles.getState().consoles["console"]!,
      datasources: [view({ id: "source", name: "Source", pluginId: POSTGRES_PLUGIN.id })],
    };
  }

  it("givenSelection_whenImportCancelled_thenDraftNotSavedAndSelectionUnchanged", async () => {
    const context = await contextWithSelection();
    const action = SNIPPET_ACTIONS.find((item) => item.id === SNIPPET_ACTION_IDS.importSelection)!;
    useSnippetsDialog.getState().hide();
    expect(action.when?.({ ...context, paletteOpen: true })).toBe(true);
    await action.run(context, undefined as never);
    expect(useSnippetsDialog.getState().importConsoleId).toBe("console");
    expect(useSnippetsDialog.getState().draft?.body).toBe(context.console!.sql.slice(7, 30));
    expect(useSnippetsDialog.getState().draft?.scope).toEqual({ kind: "plugin", pluginId: POSTGRES_PLUGIN.id });
    await run(SNIPPET_ACTION_IDS.cancelImport);
    expect(useSnippetsDialog.getState().open).toBe(false);
    expect(useConsoles.getState().consoles["console"]?.selection).toEqual(context.console!.selection);
    expect(useSnippets.getState().snippets).toEqual([FIRST, SECOND]);
  });

  it("givenNoSelection_whenImportCheckedOrRun_thenDoesNotImportWholeDocument", async () => {
    const context = await contextWithSelection();
    const empty = { ...context, console: { ...context.console!, selection: { from: 0, to: 0 } } };
    const action = SNIPPET_ACTIONS.find((item) => item.id === SNIPPET_ACTION_IDS.importSelection)!;
    useSnippetsDialog.getState().hide();
    expect(action.when?.(empty)).toBe(false);
    await action.run(empty, undefined as never);
    expect(useSnippetsDialog.getState().open).toBe(false);
  });

  it("givenImportedDraft_whenSaved_thenClosesAndOpenNoticeSelectsSavedItem", async () => {
    const context = await contextWithSelection();
    await SNIPPET_ACTIONS.find((item) => item.id === SNIPPET_ACTION_IDS.importSelection)!.run(
      context,
      undefined as never,
    );
    const draft = useSnippetsDialog.getState().draft!;
    useSnippets.setState({
      save: vi.fn((snippet: TextSnippet) => {
        useSnippets.setState({ snippets: [FIRST, SECOND, snippet] });
        return Promise.resolve(true);
      }),
    });
    await run(SNIPPET_ACTION_IDS.save);
    expect(useSnippetsDialog.getState().open).toBe(false);
    expect(useSnippetsDialog.getState().notice).toEqual({ consoleId: "console", snippet: draft });
    await run(SNIPPET_ACTION_IDS.openCreated);
    expect(useSnippetsDialog.getState().draft).toEqual(draft);
    expect(useSnippetsDialog.getState().original).toEqual(draft);
    expect(useSnippetsDialog.getState().importConsoleId).toBeNull();
  });

  it("givenNumericUnicodeOrLongSelection_whenSuggested_thenNameAndPrefixAreValid", () => {
    for (const text of ["123 result", "你好", "SELECT " + "x".repeat(100), "\nSELECT name FROM users", "!!!"]) {
      const suggestion = snippetSuggestions(text);
      expect(suggestion.name.length).toBeGreaterThan(0);
      expect(suggestion.prefix).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
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
