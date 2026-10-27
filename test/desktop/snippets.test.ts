import { describe, expect, it, vi } from "vitest";
import {
  createSnippetsService,
  SNIPPETS_FILE,
  SnippetError,
  snippetSchema,
} from "@table-craft/desktop/main/snippets.js";
import { registerIpc, type IpcOptions } from "@table-craft/desktop/main/ipc.js";
import { INVOKE_CHANNELS } from "@table-craft/desktop/preload/bridge.js";
import {
  snippetProblem,
  snippetMatches,
  snippetScopeKey,
  SNIPPET_BODY_MAX_LENGTH,
  type TextSnippet,
  type SnippetScope,
} from "@table-craft/desktop/snippets/snippets.js";
import { memoryFiles } from "../support/memoryFiles.js";

const DIRECTORY = "/profile";
const PATH = `${DIRECTORY}/${SNIPPETS_FILE}`;
const SNIPPET: TextSnippet = {
  id: "select",
  name: "Select rows",
  prefix: "sel",
  body: "SELECT ${1:*} FROM ${2:table}",
  scope: { kind: "all" },
};
const LEGACY_SNIPPET = {
  id: "legacy",
  name: "Legacy SQL",
  prefix: "old",
  body: "SELECT ${column} FROM ${table}",
  dialect: null,
};

function setup(files = memoryFiles()) {
  const changed = vi.fn();
  return { files, changed, service: createSnippetsService({ directory: DIRECTORY, files, onChanged: changed }) };
}

async function snippetFailure(operation: Promise<unknown>): Promise<SnippetError> {
  const failure: unknown = await operation.catch((cause: unknown) => cause);
  expect(failure).toBeInstanceOf(SnippetError);
  if (!(failure instanceof SnippetError)) throw new Error("Expected a typed snippet failure.");
  return failure;
}

describe("text snippets", () => {
  it("givenMissingFile_whenSavedUpdatedAndRemoved_thenRoundTripsAndBroadcasts", async () => {
    const { files, service, changed } = setup();
    expect(await service.read()).toEqual([]);
    expect(await service.save(SNIPPET)).toEqual([SNIPPET]);
    const updated = { ...SNIPPET, name: "Select all" };
    expect(await service.save(updated)).toEqual([updated]);
    expect(await setup(files).service.read()).toEqual([updated]);
    expect(JSON.parse(files.contents.get(PATH) ?? "")).toEqual({ version: 2, snippets: [updated] });
    expect(await service.remove(SNIPPET.id)).toEqual([]);
    expect(changed.mock.calls).toEqual([[[SNIPPET]], [[updated]], [[]]]);
  });

  it.each([
    "{ broken",
    JSON.stringify({ version: 3, snippets: [] }),
    JSON.stringify({ version: 2, snippets: [SNIPPET, SNIPPET] }),
    JSON.stringify({ version: 2, snippets: [{ ...SNIPPET, scope: { kind: "future" } }] }),
    JSON.stringify({ version: 2, snippets: [{ ...SNIPPET, scope: { kind: "all", pluginId: "extra" } }] }),
    JSON.stringify({ version: 2, snippets: [{ ...SNIPPET, dialect: null }] }),
    JSON.stringify({ version: 1, snippets: [{ ...LEGACY_SNIPPET, extra: true }] }),
  ])("givenMalformedFile_whenReadOrMutated_thenPreservedAndActionableError: %s", async (text) => {
    const { files, service, changed } = setup(memoryFiles({ [PATH]: text }));
    await expect(service.read()).rejects.toBeInstanceOf(SnippetError);
    await expect(service.save(SNIPPET)).rejects.toThrow("Could not read");
    await expect(service.remove(SNIPPET.id)).rejects.toThrow("Could not read");
    expect(files.contents.get(PATH)).toBe(text);
    expect(changed).not.toHaveBeenCalled();
  });

  it("givenReadFailure_whenRead_thenTypedErrorAndNoWrites", async () => {
    const files = memoryFiles();
    const service = createSnippetsService({
      directory: DIRECTORY,
      files: { ...files, readText: () => Promise.reject(new Error("permission denied")) },
      onChanged: vi.fn(),
    });
    const failure = await snippetFailure(service.read());
    expect(failure.message).toContain("permission denied");
    expect(failure.hint).toContain("permissions");
    await expect(service.save(SNIPPET)).rejects.toThrow("permission denied");
    await expect(service.remove(SNIPPET.id)).rejects.toThrow("permission denied");
    expect(files.contents.size).toBe(0);
  });

  it.each(["writeText", "rename"] as const)(
    "givenPermissionFailureOn%s_whenSaved_thenOriginalFilePreservedAndNoNotification",
    async (operation) => {
      const original = JSON.stringify({ version: 2, snippets: [SNIPPET] });
      const files = memoryFiles({ [PATH]: original });
      const changed = vi.fn();
      const service = createSnippetsService({
        directory: DIRECTORY,
        files: { ...files, [operation]: () => Promise.reject(new Error("permission denied")) },
        onChanged: changed,
      });
      const failure = await snippetFailure(service.save({ ...SNIPPET, body: "SELECT 2" }));
      expect(failure.message).toContain("permission denied");
      expect(failure.hint).toContain("write permissions");
      expect(files.contents.get(PATH)).toBe(original);
      expect(changed).not.toHaveBeenCalled();
    },
  );

  it("givenFailedAtomicWrite_whenNextMutationQueued_thenPreviousFilePreservedAndQueueRecovers", async () => {
    const { files, service, changed } = setup();
    await service.save(SNIPPET);
    const before = files.contents.get(PATH);
    files.dieDuringNextWrite();
    const failure = await snippetFailure(service.save({ ...SNIPPET, body: "SELECT 2" }));
    expect(failure.hint).toContain("disk space");
    expect(files.contents.get(PATH)).toBe(before);
    expect(changed).toHaveBeenCalledTimes(1);
    const second = { ...SNIPPET, id: "second", prefix: "other" };
    const third = { ...SNIPPET, id: "third", prefix: "third" };
    await Promise.all([service.save(second), service.save(third)]);
    expect(await service.read()).toEqual([SNIPPET, second, third]);
  });

  it("givenDuplicatePrefix_whenSameScope_thenRejectedButOverlappingScopesCanCoexist", async () => {
    const { service } = setup();
    await service.save(SNIPPET);
    await expect(service.save({ ...SNIPPET, id: "duplicate", prefix: "SEL" })).rejects.toThrow("same scope");
    await service.save({ ...SNIPPET, id: "sql", scope: { kind: "sql" } });
    await service.save({ ...SNIPPET, id: "postgres", scope: { kind: "sql", highlight: "postgresql" } });
    await service.save({ ...SNIPPET, id: "unknown", scope: { kind: "plugin", pluginId: "not-installed" } });
    await expect(
      service.save({ ...SNIPPET, id: "sql-duplicate", prefix: "SEL", scope: { kind: "sql" } }),
    ).rejects.toThrow("same scope");
    await expect(service.remove("missing")).rejects.toThrow("no longer exists");
    await expect(service.remove("../bad")).rejects.toThrow("Invalid snippet ID");
  });

  it.each([
    { name: " " },
    { prefix: "two words" },
    { prefix: "1word" },
    { body: "\n" },
    { body: "a".repeat(SNIPPET_BODY_MAX_LENGTH + 1) },
    { scope: { kind: "sql", highlight: " " } as const },
    { scope: { kind: "plugin", pluginId: " " } as const },
    { id: "../x" },
  ])("givenInvalidFields_whenValidated_thenRejected", async (patch) => {
    const snippet = { ...SNIPPET, ...patch };
    expect(snippetProblem(snippet)).not.toBeNull();
    expect(snippetSchema.safeParse(snippet).success).toBe(false);
    await expect(setup().service.save(snippet)).rejects.toBeInstanceOf(SnippetError);
  });

  it("givenSnippetIpc_whenInputInvalid_thenRejectedBeforeServiceAndTypedFailuresKeepHint", async () => {
    const handlers = new Map<string, (event: { sender: string }, ...args: unknown[]) => unknown>();
    const { service } = setup();
    const save = vi.spyOn(service, "save");
    const remove = vi.spyOn(service, "remove");
    const log = { warn: vi.fn(), error: vi.fn() };
    const options = { snippets: service, log } as unknown as IpcOptions<string>;
    registerIpc(
      {
        handle: (channel, handler) => {
          handlers.set(channel, handler);
        },
      },
      options,
    );
    function invoke(channel: string, payload?: unknown) {
      return handlers.get(channel)?.({ sender: "window" }, payload);
    }
    expect(await invoke(INVOKE_CHANNELS.saveSnippet, { ...SNIPPET, extra: true })).toMatchObject({ ok: false });
    expect(await invoke(INVOKE_CHANNELS.saveSnippet, { ...SNIPPET, body: 2 })).toMatchObject({ ok: false });
    expect(await invoke(INVOKE_CHANNELS.saveSnippet, { ...SNIPPET, scope: { kind: "plugin" } })).toMatchObject({
      ok: false,
    });
    expect(
      await invoke(INVOKE_CHANNELS.saveSnippet, { ...SNIPPET, scope: { kind: "sql", highlight: null } }),
    ).toMatchObject({ ok: false });
    expect(await invoke(INVOKE_CHANNELS.deleteSnippet, { id: "../x" })).toMatchObject({ ok: false });
    expect(await invoke(INVOKE_CHANNELS.readSnippets, {})).toMatchObject({ ok: false });
    expect(save).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(await invoke(INVOKE_CHANNELS.saveSnippet, SNIPPET)).toEqual({ ok: true, value: [SNIPPET] });
    expect(await invoke(INVOKE_CHANNELS.readSnippets)).toEqual({ ok: true, value: [SNIPPET] });
    expect(await invoke(INVOKE_CHANNELS.deleteSnippet, { id: "missing" })).toMatchObject({
      ok: false,
      error: { hint: "Reload the snippets and select one again." },
    });
    expect(await invoke(INVOKE_CHANNELS.deleteSnippet, { id: SNIPPET.id })).toEqual({ ok: true, value: [] });
  });

  it.each([null, "postgresql", "uninstalled-dialect"])(
    "givenLegacyDialect%s_whenRead_thenMigratesOnlyInMemoryAndMutationWritesV2",
    async (dialect) => {
      const legacy = { ...LEGACY_SNIPPET, dialect };
      const original = JSON.stringify({ version: 1, snippets: [legacy] });
      const { service, files, changed } = setup(memoryFiles({ [PATH]: original }));
      const scope: SnippetScope = dialect === null ? { kind: "sql" } : { kind: "sql", highlight: dialect };
      const migrated: TextSnippet = {
        id: legacy.id,
        name: legacy.name,
        prefix: legacy.prefix,
        body: legacy.body,
        scope,
      };
      expect(await service.read()).toEqual([migrated]);
      expect(files.contents.get(PATH)).toBe(original);
      expect(changed).not.toHaveBeenCalled();
      await service.save(SNIPPET);
      expect(JSON.parse(files.contents.get(PATH) ?? "")).toEqual({ version: 2, snippets: [migrated, SNIPPET] });
    },
  );

  it("givenLegacyFile_whenMigrationWriteFails_thenV1PreservedAndRetrySucceeds", async () => {
    const original = JSON.stringify({ version: 1, snippets: [LEGACY_SNIPPET] });
    const { service, files, changed } = setup(memoryFiles({ [PATH]: original }));
    files.dieDuringNextWrite();
    await expect(service.save(SNIPPET)).rejects.toBeInstanceOf(SnippetError);
    expect(files.contents.get(PATH)).toBe(original);
    expect(changed).not.toHaveBeenCalled();
    await service.remove(LEGACY_SNIPPET.id);
    expect(JSON.parse(files.contents.get(PATH) ?? "")).toEqual({ version: 2, snippets: [] });
  });

  it("givenUnknownPluginAndHighlight_whenMutated_thenAllExistingFieldsPreserved", async () => {
    const unknownPlugin: TextSnippet = {
      ...SNIPPET,
      id: "future-plugin",
      scope: { kind: "plugin", pluginId: "future-plugin" },
    };
    const unknownHighlight: TextSnippet = {
      ...SNIPPET,
      id: "future-sql",
      scope: { kind: "sql", highlight: "future-highlight" },
    };
    const { service } = setup(
      memoryFiles({ [PATH]: JSON.stringify({ version: 2, snippets: [unknownPlugin, unknownHighlight] }) }),
    );
    await service.save(SNIPPET);
    expect(await service.read()).toEqual([unknownPlugin, unknownHighlight, SNIPPET]);
  });
});

describe("snippet scope matching", () => {
  const sql = { id: "sql-plugin", capabilities: ["sql"], highlight: "sql-dialect" };
  const commands = { id: "command-plugin", capabilities: ["commands"] };

  it("givenCanonicalScopes_whenKeyed_thenDistinctAndIndependentOfPropertyOrder", () => {
    const scopes: readonly SnippetScope[] = [
      { kind: "all" },
      { kind: "sql" },
      { kind: "sql", highlight: "dialect" },
      { kind: "plugin", pluginId: "dialect" },
    ];
    expect(new Set(scopes.map(snippetScopeKey)).size).toBe(scopes.length);
    expect(snippetScopeKey({ kind: "plugin", pluginId: "dialect" })).toBe(
      snippetScopeKey({ pluginId: "dialect", kind: "plugin" }),
    );
  });

  it("givenAllScope_whenTargetEligible_thenMatchesSqlAndCommandsOnly", () => {
    expect(snippetMatches(SNIPPET, sql)).toBe(true);
    expect(snippetMatches(SNIPPET, commands)).toBe(true);
    expect(snippetMatches(SNIPPET, undefined)).toBe(false);
    expect(snippetMatches(SNIPPET, { id: "other", capabilities: ["keyValue"] })).toBe(false);
  });

  it("givenSqlScope_whenMatchingLegacyHighlight_thenSqlOnlyWithoutPluginIdLogic", () => {
    const snippet: TextSnippet = { ...SNIPPET, scope: { kind: "sql" } };
    expect(snippetMatches(snippet, sql)).toBe(true);
    expect(snippetMatches(snippet, commands)).toBe(false);
    expect(snippetMatches({ ...snippet, scope: { kind: "sql", highlight: "sql-dialect" } }, sql)).toBe(true);
    expect(snippetMatches({ ...snippet, scope: { kind: "sql", highlight: "different" } }, sql)).toBe(false);
    expect(snippetMatches(snippet, { id: "future", capabilities: ["sql"], highlight: null })).toBe(true);
  });

  it("givenPluginScope_whenExactEligiblePlugin_thenMatchesWithoutHardcodedIds", () => {
    const snippet: TextSnippet = { ...SNIPPET, scope: { kind: "plugin", pluginId: commands.id } };
    expect(snippetMatches(snippet, commands)).toBe(true);
    expect(snippetMatches(snippet, sql)).toBe(false);
    expect(snippetMatches(snippet, { ...commands, capabilities: [] })).toBe(false);
    expect(snippetMatches(snippet, { ...commands, id: "COMMAND-PLUGIN" })).toBe(false);
  });
});
