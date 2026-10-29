import { describe, expect, it } from "vitest";
import type { HistoryEntry } from "@table-craft/core";
import { createLogger } from "@table-craft/desktop/log/record.js";
import {
  createMcpSupervisor,
  MCP_SECRET_OWNER,
  MCP_TOKEN_KEY,
  type McpProcess,
  type McpSupervisorOptions,
} from "@table-craft/desktop/main/mcp.js";
import { createSecretStore } from "@table-craft/desktop/main/secrets.js";
import {
  MCP_BOOT_MESSAGE,
  MCP_CONFIG_MESSAGE,
  MCP_ENGINE_ANSWER_MESSAGE,
  MCP_ENGINE_REQUEST_MESSAGE,
  MCP_HISTORY_MESSAGE,
  MCP_SHUTDOWN_MESSAGE,
  MCP_STATUS_MESSAGE,
  type MainToMcp,
} from "@table-craft/desktop/mcp/messages.js";
import type { DatasourceView } from "@table-craft/desktop/preload/bridge.js";
import type { McpSettings } from "@table-craft/desktop/settings/settings.js";
import { tokenHint, type McpStatus } from "@table-craft/desktop/settings/mcp.js";
import { fakeCipher, memoryFiles } from "../support/memoryFiles.js";

const ON: McpSettings = { enabled: true, port: 47_820, rowCap: 100, statementTimeoutSeconds: 120, clients: [] };
const OFF: McpSettings = { ...ON, enabled: false };
const SILENT = createLogger({ process: "main", scope: "test", sink: () => undefined });

class FakeProcess implements McpProcess {
  readonly posted: MainToMcp[] = [];
  private readonly listeners: ((message: unknown) => void)[] = [];
  private exitListener: ((code: number) => void) | null = null;
  killed = false;

  postMessage(message: MainToMcp): void {
    this.posted.push(message);
    if (message.kind === MCP_SHUTDOWN_MESSAGE) queueMicrotask(() => this.exit(0));
  }
  on(_event: "message", listener: (message: unknown) => void): this {
    this.listeners.push(listener);
    return this;
  }
  once(_event: "exit", listener: (code: number) => void): this {
    this.exitListener = listener;
    return this;
  }
  kill(): boolean {
    this.killed = true;
    this.exit(1);
    return true;
  }
  send(message: unknown): void {
    for (const listener of this.listeners) listener(message);
  }
  exit(code: number): void {
    const listener = this.exitListener;
    this.exitListener = null;
    listener?.(code);
  }
  boot(): Extract<MainToMcp, { kind: typeof MCP_BOOT_MESSAGE }> {
    const boot = this.posted.find((message) => message.kind === MCP_BOOT_MESSAGE);
    if (boot?.kind !== MCP_BOOT_MESSAGE) throw new Error("no boot message");
    return boot;
  }
}

function view(id: string, patch: Partial<DatasourceView> = {}): DatasourceView {
  return {
    id,
    name: id,
    pluginId: "sqlite",
    folder: null,
    color: null,
    readOnly: false,
    comment: "",
    config: {},
    secretModes: {},
    storedSecrets: [],
    ephemeral: false,
    ...patch,
  };
}

async function supervised(patch: Partial<McpSupervisorOptions> = {}) {
  const processes: FakeProcess[] = [];
  const statuses: McpStatus[] = [];
  const recorded: HistoryEntry[] = [];
  const clipboard: string[] = [];
  let tokens = 0;
  const secrets = await createSecretStore({ directory: "/profile", files: memoryFiles(), cipher: fakeCipher() });
  const supervisor = createMcpSupervisor({
    fork: () => {
      const process = new FakeProcess();
      processes.push(process);
      return process;
    },
    settings: () => ON,
    datasources: () => [
      view("shop", { agentAccess: "ask" }),
      view("locked", { agentAccess: "ask", readOnly: true }),
      view("hidden"),
      view("env", { agentAccess: "read", ephemeral: true }),
    ],
    secrets,
    connect: () => Promise.resolve({ status: "connected" }),
    history: { record: (entry) => void recorded.push(entry) },
    onStatus: (status) => statuses.push(status),
    forward: () => undefined,
    windowsOpen: () => true,
    writeClipboard: (text) => clipboard.push(text),
    openConsole: () => true,
    askContext: () => true,
    newToken: () => `tc_token${String((tokens += 1))}`,
    serverVersion: "1.0.0",
    log: SILENT,
    ...patch,
  });
  return {
    supervisor,
    processes,
    statuses,
    recorded,
    clipboard,
    secrets,
  };
}

describe("MCP supervisor", () => {
  it("givenServerOff_whenStarted_thenNoProcess", async () => {
    const { supervisor, processes } = await supervised({ settings: () => OFF });

    await supervisor.start();

    expect(processes).toEqual([]);
    expect(supervisor.status().state).toBe("stopped");
  });

  it("givenServerOn_whenStarted_thenBootCarriesTokenAndOnlyExposedSavedDatasources", async () => {
    const { supervisor, processes, secrets } = await supervised();

    await supervisor.start();
    const boot = processes[0]?.boot();

    expect(boot?.token).toBe("tc_token1");
    expect(secrets.get(MCP_SECRET_OWNER, MCP_TOKEN_KEY, "forever")).toBe("tc_token1");
    expect(boot?.datasources.map((datasource) => [datasource.id, datasource.access])).toEqual([
      ["shop", "ask"],
      ["locked", "read"],
    ]);
  });

  it("givenStoredToken_whenRestarted_thenTheSameTokenIsReused", async () => {
    const { supervisor, processes } = await supervised();

    await supervisor.start();
    await supervisor.settingsChanged({ ...ON, port: 48_000 });

    expect(processes).toHaveLength(2);
    expect(processes[1]?.boot()).toMatchObject({ port: 48_000, token: "tc_token1" });
  });

  it("givenRowCapChange_whenRunning_thenConfigSentWithoutRestart", async () => {
    const { supervisor, processes } = await supervised();
    await supervisor.start();

    await supervisor.settingsChanged({ ...ON, rowCap: 5 });

    expect(processes).toHaveLength(1);
    expect(processes[0]?.posted.at(-1)).toEqual({ kind: MCP_CONFIG_MESSAGE, rowCap: 5, timeoutSeconds: 120, clients: [] });
  });

  it("givenStatementTimeoutChange_whenRunning_thenConfigSentWithoutRestart", async () => {
    const { supervisor, processes } = await supervised();
    await supervisor.start();

    await supervisor.settingsChanged({ ...ON, statementTimeoutSeconds: 30 });

    expect(processes).toHaveLength(1);
    expect(processes[0]?.posted.at(-1)).toEqual({ kind: MCP_CONFIG_MESSAGE, rowCap: 100, timeoutSeconds: 30, clients: [] });
  });

  it("givenHostMessages_whenReceived_thenStatusRelayedAndHistoryTaggedAgent", async () => {
    const { supervisor, processes, statuses, recorded } = await supervised();
    await supervisor.start();
    const status: McpStatus = {
      state: "running",
      port: 47_820,
      message: null,
      paused: false,
      clients: [],
      approvals: [],
      pendingClients: [],
      running: [],
      activity: [],
      tokenHint: null,
    };
    const entry = {
      datasourceId: "shop",
      sql: "SELECT 1",
      startedAt: 1,
      durationMs: 2,
      outcome: "success" as const,
      rowCount: 1,
      message: null,
      client: "Claude Code",
    };

    processes[0]?.send({ kind: MCP_STATUS_MESSAGE, status });
    processes[0]?.send({ kind: MCP_HISTORY_MESSAGE, entry });

    const relayed = { ...status, tokenHint: tokenHint("tc_token1") };
    expect(statuses.at(-1)).toEqual(relayed);
    expect(supervisor.status()).toEqual(relayed);
    expect(recorded).toEqual([{ ...entry, source: "agent" }]);
  });

  it("givenEngineRequestForHiddenDatasource_whenAnswered_thenFailedWithoutConnecting", async () => {
    const connects: string[] = [];
    const { supervisor, processes } = await supervised({
      connect: (datasourceId) => {
        connects.push(datasourceId);
        return Promise.resolve({ status: "connected" });
      },
    });
    await supervisor.start();
    const process = processes[0];

    process?.send({ kind: MCP_ENGINE_REQUEST_MESSAGE, requestId: 1, datasourceId: "hidden" });
    process?.send({ kind: MCP_ENGINE_REQUEST_MESSAGE, requestId: 2, datasourceId: "shop" });
    await new Promise((resolve) => setImmediate(resolve));

    expect(connects).toEqual(["shop"]);
    const answers = process?.posted.filter((message) => message.kind === MCP_ENGINE_ANSWER_MESSAGE);
    expect(answers).toEqual([
      {
        kind: MCP_ENGINE_ANSWER_MESSAGE,
        requestId: 1,
        answer: { status: "failed", message: "This datasource is not exposed to agents.", hint: null },
      },
      { kind: MCP_ENGINE_ANSWER_MESSAGE, requestId: 2, answer: { status: "connected" } },
    ]);
  });

  it("givenUnexpectedExit_whenHostDies_thenStatusFailedWithAWayOut", async () => {
    const { supervisor, processes } = await supervised();
    await supervisor.start();

    processes[0]?.exit(9);

    expect(supervisor.status()).toMatchObject({ state: "failed" });
    expect(supervisor.status().message).toContain("exit code 9");
  });

  it("givenCopyConfig_whenAsked_thenClipboardHoldsTheRealToken", async () => {
    const { supervisor, clipboard } = await supervised();

    await supervisor.copyClientConfig("claudeCode");

    expect(clipboard[0]).toContain("Authorization: Bearer tc_token1");
    expect(clipboard[0]).not.toContain("${TABLECRAFT_TOKEN}");
  });

  it("givenRunningHost_whenTokenRegenerated_thenRestartedWithTheNewToken", async () => {
    const { supervisor, processes } = await supervised();
    await supervisor.start();

    await supervisor.regenerateToken();

    expect(processes[0]?.posted.some((message) => message.kind === MCP_SHUTDOWN_MESSAGE)).toBe(true);
    expect(processes[1]?.boot().token).toBe("tc_token2");
  });

  it("givenStoppedHost_whenPortArrives_thenThePortIsClosed", async () => {
    const { supervisor } = await supervised();
    let closed = false;

    supervisor.sendPort({ mcpRequest: 1 }, { close: () => (closed = true) });

    expect(closed).toBe(true);
  });
});
