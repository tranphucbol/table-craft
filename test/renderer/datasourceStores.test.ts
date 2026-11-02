import { describe, expect, it, vi } from "vitest";
import type {
  ClassifiedStatement,
  EngineConnectMode,
  EngineError,
  ExecutedStatement,
  OpenedSession,
  ServerSeen,
} from "@table-craft/desktop/engine/protocol.js";
import type { DatasourceList, DatasourceView } from "@table-craft/desktop/preload/bridge.js";
import {
  EngineRequestError,
  type EngineAuthorization,
  type EngineClient,
  type EngineConnection,
} from "@table-craft/desktop/renderer/engine/client.js";
import {
  activeResultOf,
  createConsolesStore,
  type ConsoleSession,
} from "@table-craft/desktop/renderer/state/consoles.js";
import {
  createDatasourcesStore,
  promptFields,
  type DatasourcesDependencies,
  type SecretRequest,
} from "@table-craft/desktop/renderer/state/datasources.js";
import { createTabsStore } from "@table-craft/desktop/renderer/state/tabs.js";
import { wireStores } from "@table-craft/desktop/renderer/state/wiring.js";
import { POSTGRES_PLUGIN, SQLITE_PLUGIN, view } from "./datasourceViews.js";

const PG = view({ id: "pg", name: "pg", secretModes: { password: "never" } });
const LITE = view({ id: "lite", name: "lite", pluginId: "sqlite" });

const SEEN_AT = 1_800_000_000_000;
const REFUSED: EngineError = { code: "connectionFailed", message: "password authentication failed", hint: "Check it." };

function list(datasources: readonly DatasourceView[]): DatasourceList {
  return { datasources, folders: [], warning: null, encryption: { available: true, reason: null } };
}

interface FakeClient extends EngineClient {
  readonly failedWith: () => EngineError | null;
  readonly calls: string[];
}

/** An engine that names its datasource in every result, so a mix-up shows. */
function fakeClient(
  datasourceId: string,
  options: { openFails?: EngineError | (() => EngineError | undefined); serverBrand?: string } = {},
): FakeClient {
  let sessions = 0;
  let failure: EngineError | null = null;
  const calls: string[] = [];
  const client = {
    calls,
    call(type: string, params: Record<string, unknown>): Promise<unknown> {
      calls.push(type);
      if (failure !== null) return Promise.reject(new EngineRequestError(failure));
      if (type === "session.open") {
        const openFails = typeof options.openFails === "function" ? options.openFails() : options.openFails;
        if (openFails !== undefined) return Promise.reject(new EngineRequestError(openFails));
        const opened: OpenedSession = {
          sessionId: `${datasourceId}-${String(++sessions)}`,
          pluginName: datasourceId,
          capabilities: ["sql"],
          serverVersion: `${datasourceId} 1.0`,
          serverBrand: options.serverBrand ?? null,
          namespace: null,
          serverTimeout: null,
          cancelReach: { method: "interrupt", reaches: "statement" },
        };
        return Promise.resolve(opened);
      }
      if (type === "sql.format") return Promise.resolve(String(params.text).toUpperCase());
      if (type === "script.split") {
        const text = String(params.text);
        const statement: ClassifiedStatement = {
          from: 0,
          to: text.length,
          sql: text,
          kind: "read",
          destructive: null,
          parameters: [],
        };
        return Promise.resolve(text.trim() === "" ? [] : [statement]);
      }
      if (type === "statement.execute") {
        const executed: ExecutedStatement = {
          handle: `${String(params.sessionId)}-result`,
          columns: [{ name: datasourceId, type: "text" }],
          typeClasses: ["text"],
          rowCount: 1,
          complete: true,
          cursorOpen: false,
          rowsAffected: null,
          firstWindow: { offset: 0, rows: [[String(params.sql)]] },
          transactionOpen: false,
        };
        return Promise.resolve(executed);
      }
      return Promise.resolve(null);
    },
    fail(error: EngineError) {
      failure = error;
    },
    failedWith: () => failure,
    onEvent: () => () => undefined,
  };
  return client as FakeClient;
}

function harness(
  options: {
    prompt?: (request: SecretRequest) => Record<string, string> | null;
    serverBrands?: Readonly<Record<string, string>>;
    views?: readonly DatasourceView[];
  } = {},
) {
  const clients = new Map<string, FakeClient>();
  /** The password main handed a `language` engine of pg; null while it runs without one. */
  let supplied: string | null = null;
  const connectEngine = vi.fn(
    (id: string, secrets?: Readonly<Record<string, string>>, mode?: EngineConnectMode): Promise<EngineConnection> => {
      if (id === "pg" && mode === "language") {
        supplied = null;
        const client = fakeClient(id, { openFails: () => (supplied === "right" ? undefined : REFUSED) });
        clients.set(id, client);
        return Promise.resolve({ status: "connected", client });
      }
      return connectForSession(id, secrets);
    },
  );
  const authorizeEngine = vi.fn(
    (id: string, secrets?: Readonly<Record<string, string>>): Promise<EngineAuthorization> => {
      if (id !== "pg" || supplied !== null) return Promise.resolve({ status: "authorized" });
      if (secrets?.password === undefined) return Promise.resolve({ status: "needsSecrets", keys: ["password"] });
      supplied = secrets.password;
      return Promise.resolve({ status: "authorized" });
    },
  );
  function connectForSession(id: string, secrets?: Readonly<Record<string, string>>): Promise<EngineConnection> {
    if (id === "pg" && secrets === undefined) return Promise.resolve({ status: "needsSecrets", keys: ["password"] });
    if (id === "pg" && secrets?.password !== "right") {
      const client = fakeClient(id, { openFails: REFUSED });
      clients.set(id, client);
      return Promise.resolve({ status: "connected", client });
    }
    const serverBrand = options.serverBrands?.[id];
    const client = fakeClient(id, serverBrand === undefined ? {} : { serverBrand });
    clients.set(id, client);
    return Promise.resolve({ status: "connected", client });
  }
  const remembered: [string, ServerSeen][] = [];
  const disconnectEngine = vi.fn((_id: string) => Promise.resolve());
  const prompts: SecretRequest[] = [];
  const dependencies: DatasourcesDependencies = {
    connectEngine,
    authorizeEngine,
    disconnectEngine,
    promptSecrets: (request) => {
      prompts.push(request);
      return Promise.resolve(options.prompt === undefined ? { password: "right" } : options.prompt(request));
    },
    rememberServer: (id, seen) => {
      remembered.push([id, seen]);
      return Promise.resolve();
    },
    now: () => SEEN_AT,
  };
  const datasources = createDatasourcesStore(dependencies);
  datasources.getState().setPlugins([POSTGRES_PLUGIN, SQLITE_PLUGIN]);
  datasources.getState().applyList(list(options.views ?? [PG, LITE]));
  let now = 0;
  const consoles = createConsolesStore({
    connect: (id) => datasources.getState().connect(id),
    engine: (id) => datasources.getState().engine(id),
    now: () => (now += 5),
  });
  const tabs = createTabsStore();
  const unwire = wireStores({ datasources, consoles, tabs });
  return {
    datasources,
    consoles,
    tabs,
    unwire,
    connectEngine,
    authorizeEngine,
    disconnectEngine,
    prompts,
    clients,
    remembered,
  };
}

describe("datasource and console stores", () => {
  it("givenTwoDatasources_whenConsolesRun_thenResultsStaySeparate", async () => {
    const { consoles, connectEngine } = harness();
    await consoles.getState().open("c1", "pg", { sql: "SELECT 'pg'" });
    await consoles.getState().open("c2", "lite", { sql: "SELECT 'lite'" });
    await consoles.getState().open("c3", "lite", { sql: "SELECT 'lite again'" });

    await Promise.all(["c1", "c2", "c3"].map((id) => consoles.getState().run(id, "all")));

    const { c1, c2, c3 } = consoles.getState().consoles;
    const rows = (session: ConsoleSession | undefined) => (session === undefined ? null : activeResultOf(session));
    expect(rows(c1)?.columns[0]?.name).toBe("pg");
    expect(rows(c1)?.windows[0]).toEqual([["SELECT 'pg'"]]);
    expect(rows(c2)?.columns[0]?.name).toBe("lite");
    expect(rows(c3)?.windows[0]).toEqual([["SELECT 'lite again'"]]);
    expect(connectEngine.mock.calls.filter(([id]) => id === "lite")).toHaveLength(1);
  });

  it("givenDatasourceDeleted_whenItHadConsoles_thenConsolesClosed", async () => {
    const { datasources, consoles, tabs } = harness();
    for (const [id, datasourceId] of [
      ["c1", "pg"],
      ["c2", "lite"],
      ["c3", "pg"],
    ] as const) {
      tabs.getState().open({ id, kind: "console", title: id });
      await consoles.getState().open(id, datasourceId);
    }

    datasources.getState().applyList(list([LITE]));

    expect(Object.keys(consoles.getState().consoles)).toEqual(["c2"]);
    expect(tabs.getState().tabs.map((tab) => tab.id)).toEqual(["c2"]);
    expect(datasources.getState().connections.pg).toBeUndefined();
  });

  it("givenSshSecretsNeeded_whenPrompting_thenAsksWithSshLabels", () => {
    const fields = promptFields(POSTGRES_PLUGIN, ["password", "ssh.password", "ssh.passphrase"]);

    expect(fields.map((field) => [field.key, field.label])).toEqual([
      ["password", "Password"],
      ["ssh.password", "SSH password"],
      ["ssh.passphrase", "Key passphrase"],
    ]);
  });

  it("givenNeverSecret_whenConnecting_thenPromptsOnceAndConnectsWithTypedValue", async () => {
    const { datasources, connectEngine, prompts } = harness();

    await datasources.getState().connect("pg");

    expect(prompts.map((request) => request.fields.map((field) => field.key))).toEqual([["password"]]);
    expect(connectEngine.mock.calls).toEqual([
      ["pg", undefined, "session"],
      ["pg", { password: "right" }, "session"],
    ]);
    expect(datasources.getState().connections.pg).toEqual({
      status: "connected",
      error: null,
      serverVersion: "pg 1.0",
      serverBrand: null,
    });
  });

  it("givenConnect_whenOpened_thenRemembersBrandAndServer", async () => {
    const { datasources, remembered } = harness({ serverBrands: { lite: "sqlite" } });

    await datasources.getState().connect("lite");
    await datasources.getState().disconnect("lite");

    expect(remembered).toEqual([
      [
        "lite",
        {
          brand: "sqlite",
          lastServer: { version: "lite 1.0", cancel: { method: "interrupt", reaches: "statement" }, seenAt: SEEN_AT },
        },
      ],
    ]);
    expect(datasources.getState().connections.lite).toMatchObject({ status: "disconnected", serverBrand: "sqlite" });
  });

  it("givenEphemeral_whenConnectReportsBrand_thenNotPersisted", async () => {
    const ephemeral = view({ id: "lite", name: "lite", pluginId: "sqlite", ephemeral: true });
    const { datasources, remembered } = harness({ serverBrands: { lite: "sqlite" }, views: [ephemeral] });

    await datasources.getState().connect("lite");

    expect(datasources.getState().connections.lite?.serverBrand).toBe("sqlite");
    expect(remembered).toEqual([]);
  });

  it("givenPromptCancelled_whenConnecting_thenFailedAndNothingStarted", async () => {
    const { datasources, connectEngine } = harness({ prompt: () => null });

    await expect(datasources.getState().connect("pg")).rejects.toMatchObject({ code: "cancelled" });

    expect(connectEngine).toHaveBeenCalledTimes(1);
    expect(datasources.getState().connections.pg?.status).toBe("failed");
  });

  it("givenWrongTypedPassword_whenSessionRefused_thenFailedAndEngineStoppedSoNextConnectPromptsAgain", async () => {
    const { datasources, disconnectEngine, prompts } = harness({ prompt: () => ({ password: "wrong" }) });

    await expect(datasources.getState().connect("pg")).rejects.toMatchObject({ code: "connectionFailed" });
    await vi.waitFor(() => expect(disconnectEngine).toHaveBeenCalledWith("pg"));
    await expect(datasources.getState().connect("pg")).rejects.toThrow();

    expect(prompts).toHaveLength(2);
    expect(datasources.getState().connections.pg?.error?.message).toBe("password authentication failed");
  });

  it("givenEngineCrashed_whenExitArrives_thenFailedEngineExitedConsolesFailedAndRunReconnects", async () => {
    const { datasources, consoles, clients, connectEngine } = harness();
    await consoles.getState().open("c1", "lite", { sql: "SELECT 1" });
    const crashed = clients.get("lite");

    datasources.getState().engineExited({ datasourceId: "lite", code: 134, clean: false });

    expect(datasources.getState().connections.lite).toMatchObject({
      status: "failed",
      error: { message: "Engine exited (code 134)." },
    });
    expect(consoles.getState().consoles.c1).toMatchObject({
      status: "failed",
      sessionId: null,
      error: { message: "Engine exited (code 134)." },
    });
    await vi.waitFor(() => expect(crashed?.failedWith()).not.toBeNull());

    await consoles.getState().run("c1", "all");

    expect(consoles.getState().consoles.c1?.status).toBe("ready");
    expect(consoles.getState().consoles.c1?.lastRun?.outcome).toBe("succeeded");
    expect(connectEngine.mock.calls.filter(([id]) => id === "lite")).toHaveLength(2);
    expect(datasources.getState().connections.lite?.status).toBe("connected");
  });

  it("givenConnected_whenDisconnected_thenEngineStoppedConsolesDisconnectedAndCleanExitIgnored", async () => {
    const { datasources, consoles, disconnectEngine } = harness();
    await consoles.getState().open("c1", "lite");

    await datasources.getState().disconnect("lite");
    datasources.getState().engineExited({ datasourceId: "lite", code: 0, clean: true });

    expect(disconnectEngine).toHaveBeenCalledWith("lite");
    expect(datasources.getState().connections.lite?.status).toBe("disconnected");
    expect(consoles.getState().consoles.c1?.status).toBe("disconnected");
  });

  it("givenDisconnectedDatasource_whenEngineRequested_thenNoSessionOpenedAndStatusStaysDisconnected", async () => {
    const { datasources, connectEngine, clients, prompts } = harness();

    await datasources.getState().engine("pg");

    expect(connectEngine.mock.calls).toEqual([["pg", undefined, "language"]]);
    expect(clients.get("pg")?.calls).toEqual([]);
    expect(prompts).toEqual([]);
    expect(datasources.getState().connections.pg).toBeUndefined();
  });

  it("givenConnectedDatasource_whenEngineRequested_thenConnectedClientReturned", async () => {
    const { datasources, connectEngine } = harness();
    const connected = await datasources.getState().connect("lite");

    const engine = await datasources.getState().engine("lite");

    expect(engine).toBe(connected);
    expect(connectEngine).toHaveBeenCalledTimes(1);
    expect(datasources.getState().connections.lite?.status).toBe("connected");
  });

  it("givenTwoEngineRequests_whenConcurrent_thenOneEngineStarted", async () => {
    const { datasources, connectEngine } = harness();

    const [first, second] = await Promise.all([
      datasources.getState().engine("lite"),
      datasources.getState().engine("lite"),
    ]);

    expect(first).toBe(second);
    expect(connectEngine).toHaveBeenCalledTimes(1);
  });

  it("givenEngineStartedForFormat_whenConnected_thenSameEngineAuthorizedAndVerified", async () => {
    const { datasources, connectEngine, authorizeEngine } = harness();
    const engine = await datasources.getState().engine("lite");

    const connected = await datasources.getState().connect("lite");

    expect(connected).toBe(engine);
    expect(connectEngine).toHaveBeenCalledTimes(1);
    expect(authorizeEngine.mock.calls).toEqual([["lite", undefined]]);
    expect(datasources.getState().connections.lite).toMatchObject({ status: "connected", serverVersion: "lite 1.0" });
  });

  it("givenPartialEngine_whenConnected_thenPromptsAndAuthorizesBeforeVerify", async () => {
    const { datasources, connectEngine, authorizeEngine, prompts } = harness();
    const engine = await datasources.getState().engine("pg");

    const connected = await datasources.getState().connect("pg");

    expect(connected).toBe(engine);
    expect(prompts.map((request) => request.fields.map((field) => field.key))).toEqual([["password"]]);
    expect(authorizeEngine.mock.calls).toEqual([
      ["pg", undefined],
      ["pg", { password: "right" }],
    ]);
    expect(connectEngine).toHaveBeenCalledTimes(1);
    expect(datasources.getState().connections.pg?.status).toBe("connected");
  });

  it("givenPartialEngine_whenWrongPasswordOnConnect_thenFailedAndEngineStopped", async () => {
    const { datasources, disconnectEngine, clients } = harness({ prompt: () => ({ password: "wrong" }) });
    await datasources.getState().engine("pg");

    await expect(datasources.getState().connect("pg")).rejects.toMatchObject({ code: "connectionFailed" });

    await vi.waitFor(() => expect(disconnectEngine).toHaveBeenCalledWith("pg"));
    expect(clients.get("pg")?.failedWith()?.message).toBe("password authentication failed");
    expect(datasources.getState().connections.pg?.status).toBe("failed");
  });

  it("givenLanguageOnlyEngine_whenItExits_thenStatusUnchangedConsolesUntouchedAndNextRequestStartsOne", async () => {
    const { datasources, consoles, connectEngine } = harness();
    await consoles.getState().open("c1", "lite", { sql: "select 1", connect: false });
    await datasources.getState().engine("lite");

    datasources.getState().engineExited({ datasourceId: "lite", code: 134, clean: false });
    await datasources.getState().engine("lite");

    expect(datasources.getState().connections.lite).toBeUndefined();
    expect(consoles.getState().consoles.c1).toMatchObject({ status: "disconnected", error: null });
    expect(connectEngine).toHaveBeenCalledTimes(2);
  });

  it("givenLanguageOnlyEngine_whenDisconnected_thenEngineStoppedAndStatusUntouched", async () => {
    const { datasources, disconnectEngine } = harness();
    await datasources.getState().engine("lite");

    await datasources.getState().disconnect("lite");

    expect(disconnectEngine).toHaveBeenCalledWith("lite");
    expect(datasources.getState().connections.lite).toBeUndefined();
  });

  it("givenDisconnectedConsole_whenReformatted_thenFormattedAndDatasourceStaysDisconnected", async () => {
    const { datasources, consoles, clients } = harness();
    await consoles.getState().open("c1", "pg", { sql: "select 1", connect: false });

    await consoles.getState().reformat("c1");

    expect(consoles.getState().consoles.c1?.replacement?.text).toBe("SELECT 1");
    expect(clients.get("pg")?.calls).toEqual(["sql.format"]);
    expect(datasources.getState().connections.pg).toBeUndefined();
    expect(consoles.getState().consoles.c1?.status).toBe("disconnected");
  });
});
